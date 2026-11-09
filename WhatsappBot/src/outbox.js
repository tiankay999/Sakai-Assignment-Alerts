/**
 * The Python -> Node bridge: tails $DATA_DIR/outbox.jsonl.
 *
 * Why a watched append-only file rather than HTTP or SQLite:
 *   - The two processes already share the /data volume, so there is no port,
 *     no auth secret and no network path to secure.
 *   - Appending is atomic enough for single-writer/single-reader use, and the
 *     file survives the Node service being down, restarted or rebuilt - the
 *     scraper keeps writing and delivery catches up. An HTTP endpoint would
 *     silently drop alerts during any Node downtime.
 *   - No schema migrations, no locking, no extra dependency. SQLite would add
 *     a native module and writer-lock contention for no benefit at this scale
 *     (a few dozen records a day).
 *
 * Delivery guarantees: a byte offset plus a set of delivered event IDs are
 * persisted. The offset only advances after every send for that record has
 * been attempted, so a crash replays the record rather than losing it, and the
 * event-ID set makes the replay a no-op if it had already gone out.
 */
import fs from 'node:fs';
import { config } from './config.js';
import { logger } from './logger.js';
import { alreadyDelivered, cursor, markDelivered, setCursorOffset } from './store.js';

export function startOutboxWatcher({ onEvent }) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      if (!fs.existsSync(config.outboxFile)) return;

      const { size } = fs.statSync(config.outboxFile);
      let offset = cursor.data.offset ?? 0;

      // The scraper rotates the outbox once it gets large, which makes the
      // file smaller than our offset. Start over; delivered IDs stop resends.
      if (size < offset) {
        logger.info({ size, offset }, 'outbox shrank (rotated), resetting cursor');
        offset = 0;
        setCursorOffset(0);
      }
      if (size === offset) return;

      const length = size - offset;
      const buf = Buffer.alloc(length);
      const fd = fs.openSync(config.outboxFile, 'r');
      try {
        fs.readSync(fd, buf, 0, length, offset);
      } finally {
        fs.closeSync(fd);
      }

      const chunk = buf.toString('utf8');
      const lastNewline = chunk.lastIndexOf('\n');
      // No complete line yet: the scraper is mid-write. Try again next tick.
      if (lastNewline === -1) return;

      const lines = chunk.slice(0, lastNewline).split('\n');
      let consumed = offset;

      for (const line of lines) {
        consumed += Buffer.byteLength(line, 'utf8') + 1; // +1 for the newline
        const trimmed = line.trim();
        if (!trimmed) {
          setCursorOffset(consumed);
          continue;
        }

        let record;
        try {
          record = JSON.parse(trimmed);
        } catch {
          logger.warn({ bytes: trimmed.length }, 'malformed outbox line skipped');
          setCursorOffset(consumed);
          continue;
        }

        const eventId = record.event_id || `${record.kind}:${record.queued_at}`;
        if (alreadyDelivered(eventId)) {
          setCursorOffset(consumed);
          continue;
        }

        // Awaits every send for this record, so the cursor below is only
        // advanced once delivery has actually been attempted.
        await onEvent(record);
        markDelivered(eventId, consumed);
      }
    } catch (err) {
      logger.error({ err: err.message }, 'outbox tick failed');
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), config.outboxPollMs);
  void tick();

  logger.info(
    { file: config.outboxFile, everyMs: config.outboxPollMs },
    'watching scraper outbox',
  );

  return () => clearInterval(timer);
}
