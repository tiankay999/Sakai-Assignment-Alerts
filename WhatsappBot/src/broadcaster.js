/**
 * Turns one scraper event into group messages.
 *
 * Routing: a course is matched against the keys in groups.json. A key matches
 * when it equals the course's derived code (UGBS301), when it appears inside
 * the course title with spaces stripped, or when it is the wildcard "*", which
 * receives everything. One course can therefore map to several groups, and one
 * group can serve several courses.
 */
import { config } from './config.js';
import { logger } from './logger.js';
import { formatAlert, formatDigest } from './format.js';
import {
  botState,
  courseKey,
  groupLabel,
  groups,
  noteDelivery,
  sponsorLineFor,
} from './store.js';
import { courseCode } from './util.js';

/** Group JIDs that should receive items for this course title. */
export function groupsForCourse(courseTitle) {
  const code = courseKey(courseCode(courseTitle));
  const normalizedTitle = courseKey(courseTitle);
  const targets = new Set();

  for (const [key, jids] of Object.entries(groups.data.courses)) {
    const matches =
      key === '*' ||
      (key && (key === code || (normalizedTitle && normalizedTitle.includes(key))));
    if (!matches) continue;
    for (const jid of jids) targets.add(jid);
  }

  return [...targets];
}

export function createBroadcaster({ whatsapp }) {
  /**
   * Deliver one new scraped item to every group mapped to its course.
   * Resolves once every send has been attempted.
   */
  async function broadcastAlert(item) {
    if (botState.data.paused) {
      logger.info({ id: item.id }, 'broadcasting paused, alert dropped from queue');
      return;
    }

    const targets = groupsForCourse(item.course);
    if (!targets.length) {
      logger.warn(
        { course: item.course, code: courseCode(item.course) },
        'no group mapped for this course - use /addgroup to map it',
      );
      return;
    }

    const text = formatAlert(item);
    const results = await Promise.all(
      targets.map((jid) => whatsapp.enqueue(jid, text, { kind: 'alert' })),
    );
    if (results.some(Boolean)) noteDelivery('alert');
  }

  /**
   * Deliver the 8am/12pm/6pm deadline digest.
   *
   * Only assignments and quizzes are included: the scraper's pending list also
   * carries announcements and resources (which have no due date), and a
   * "deadline summary" full of items marked Unknown is noise. Telegram keeps
   * its existing behaviour untouched.
   *
   * A group with nothing outstanding is skipped rather than sent an empty
   * digest - three "nothing due" messages a day per group is exactly the kind
   * of volume that gets a number flagged.
   */
  async function broadcastDigest(event) {
    if (botState.data.paused) {
      logger.info({ window: event.window }, 'broadcasting paused, digest dropped');
      return;
    }

    const deadlines = (event.items ?? []).filter(
      (entry) => entry.type === 'Assignment' || entry.type === 'Quiz',
    );

    // Every group that is mapped to at least one course gets considered.
    const byGroup = new Map();
    for (const entry of deadlines) {
      for (const jid of groupsForCourse(entry.course)) {
        if (!byGroup.has(jid)) byGroup.set(jid, []);
        byGroup.get(jid).push(entry);
      }
    }

    if (!byGroup.size) {
      logger.info({ window: event.window }, 'digest had nothing to send to any mapped group');
      return;
    }

    const results = [];
    for (const [jid, entries] of byGroup) {
      const text = formatDigest({
        greeting: event.greeting,
        entries,
        sponsorLine: sponsorLineFor(jid),
        groupLabel: groups.data.names[jid] ? groupLabel(jid) : '',
      });
      results.push(await whatsapp.enqueue(jid, text, { kind: 'digest' }));
    }
    if (results.some(Boolean)) noteDelivery('digest');
  }

  /** Dispatch one outbox record. */
  async function handleEvent(record) {
    if (record.kind === 'alert' && record.item) {
      await broadcastAlert(record.item);
      return;
    }
    if (record.kind === 'digest') {
      await broadcastDigest(record);
      return;
    }
    logger.warn({ kind: record.kind }, 'unknown outbox record kind, skipped');
  }

  /** Admin /broadcast - throttled like any other automated send. */
  async function broadcastManual(jids, message) {
    const results = [];
    for (const jid of jids) {
      results.push(await whatsapp.enqueue(jid, message, { kind: 'manual' }));
    }
    return results.filter(Boolean).length;
  }

  return { handleEvent, broadcastAlert, broadcastDigest, broadcastManual, sakaiBase: config.sakaiBase };
}
