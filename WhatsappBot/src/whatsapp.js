/**
 * Baileys socket: QR link, persistent auth, auto-reconnect, throttled sending.
 *
 * Two send paths, deliberately different:
 *   - sendNow()  : human-triggered replies (admin commands, assistant answers).
 *                  Answered promptly because a person is waiting.
 *   - enqueue()  : automated broadcasts (alerts, digests). Serialised through
 *                  one worker with a randomised delay between every message so
 *                  the account never emits a burst. Bursts are what get a
 *                  number flagged.
 */
import path from 'node:path';
import fs from 'node:fs';
import qrcode from 'qrcode-terminal';
import * as baileys from '@whiskeysockets/baileys';

import { config } from './config.js';
import { logger, baileysLogger } from './logger.js';
import { jidDigits, randomBetween, sleep } from './util.js';

// Baileys ships as CJS. Verified against 6.7.24: the socket factory is the
// default export and everything else is a named export. The fallback keeps
// this working if a future release moves the factory to a named export.
const makeWASocket = baileys.default ?? baileys.makeWASocket;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = baileys;

const MAX_BACKOFF_MS = 60_000;

export function createWhatsApp({ onMessage }) {
  let sock = null;
  let connected = false;
  let reconnectAttempts = 0;
  let loggedOut = false;
  let lastConnectedAt = null;
  let lastDisconnectReason = null;

  const queue = [];
  let draining = false;

  // WhatsApp emits a fresh QR roughly every 20s. A pairing code stays valid
  // for a few minutes, so a new one is only requested once the old one has
  // aged out - re-requesting on every QR refresh would invalidate the code the
  // user is currently typing.
  const PAIRING_REFRESH_MS = 120_000;
  let lastPairingRequestAt = 0;

  function botNumbers() {
    const out = new Set();
    for (const id of [sock?.user?.id, sock?.user?.lid]) {
      const digits = jidDigits(id);
      if (digits) out.add(digits);
    }
    return [...out];
  }

  function botJids() {
    return [sock?.user?.id, sock?.user?.lid].filter(Boolean);
  }

  function showQr(qr) {
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
    process.stdout.write(
      [
        '',
        '  ========================================================================',
        '   IF THE TERMINAL QR CODE LOOKS DISTORTED, OPEN THIS IN YOUR BROWSER:',
        `   ${qrImageUrl}`,
        '  ========================================================================',
        '',
      ].join('\n'),
    );
    logger.info('scan this QR with the BOT number (WhatsApp > Linked devices > Link a device)');
    qrcode.generate(qr, { small: true });
  }

  /**
   * Offer whichever linking method is configured.
   *
   * Both paths are driven by the same `qr` event, because that event is the
   * signal that the socket is live and WhatsApp is ready for a link attempt.
   * In pairing mode the QR is suppressed and an 8-character code is requested
   * instead - the "Link with phone number" flow on the phone.
   */
  async function offerLink(qr) {
    const usePairing = config.loginMethod === 'pairing' && Boolean(config.botNumber);

    if (!usePairing) {
      showQr(qr);
      return;
    }
    if (sock?.authState?.creds?.registered) return;
    if (Date.now() - lastPairingRequestAt < PAIRING_REFRESH_MS) return;

    try {
      const custom =
        config.customPairingCode.length === 8 ? config.customPairingCode : undefined;
      const code = await sock.requestPairingCode(config.botNumber, custom);
      lastPairingRequestAt = Date.now();

      const pretty = code?.match(/.{1,4}/g)?.join('-') ?? code;
      const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
      // Printed directly so it stays readable among the JSON log lines.
      process.stdout.write(
        [
          '',
          '  ===============================================',
          `   PAIRING CODE:  ${pretty}`,
          '  ===============================================',
          `   On the bot's phone (+${config.botNumber}):`,
          '   WhatsApp > Settings > Linked devices >',
          '   Link a device > Link with phone number instead',
          '   then type the code above.',
          '',
          '   --- OR SCAN VIA BROWSER IF PAIRING FAILS ---',
          `   ${qrImageUrl}`,
          '  ===============================================',
          '',
          '',
        ].join('\n'),
      );
      logger.info({ method: 'pairing' }, 'pairing code issued, waiting for the phone');
    } catch (err) {
      logger.error(
        { err: err.message },
        'could not request a pairing code, falling back to the QR code',
      );
      showQr(qr);
    }
  }

  async function connect() {
    if (process.env.RESET_AUTH === 'true') {
      logger.warn({ authDir: config.authDir }, 'RESET_AUTH=true detected: wiping baileys_auth directory for a clean link');
      fs.rmSync(config.authDir, { recursive: true, force: true });
    }
    fs.mkdirSync(config.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: baileysLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      browser: Browsers ? Browsers.macOS('Desktop') : undefined,
      // The QR is rendered from the connection.update event below, so the
      // deprecated printQRInTerminal option is deliberately not passed.
      // Keep the bot number looking like a passive device.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) void offerLink(qr);

      if (connection === 'open') {
        connected = true;
        loggedOut = false;
        reconnectAttempts = 0;
        lastConnectedAt = new Date().toISOString();
        logger.info({ user: jidDigits(sock?.user?.id) }, 'whatsapp connected');
        void drain();
        return;
      }

      if (connection === 'close') {
        connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        lastDisconnectReason = statusCode ?? 'unknown';

        if (statusCode === DisconnectReason.loggedOut) {
          loggedOut = true;
          logger.error(
            { authDir: config.authDir },
            'the bot number was logged out on the phone. Delete the auth directory and restart to re-link.',
          );
          return;
        }

        reconnectAttempts += 1;
        const backoff = Math.min(2 ** reconnectAttempts * 1000, MAX_BACKOFF_MS);
        logger.warn(
          { statusCode, attempt: reconnectAttempts, backoff },
          'connection closed, reconnecting',
        );
        setTimeout(() => {
          connect().catch((err) => logger.error({ err: err.message }, 'reconnect failed'));
        }, backoff);
      }
    });

    sock.ev.on('messages.upsert', async (event) => {
      // "notify" is a live incoming message; "append"/history syncs are skipped
      // so a reconnect never replays old commands.
      if (event.type !== 'notify') return;
      for (const msg of event.messages ?? []) {
        if (msg.key?.fromMe) continue;
        if (!msg.message) continue;
        try {
          await onMessage(msg, api);
        } catch (err) {
          logger.error({ err: err.message }, 'message handler failed');
        }
      }
    });

    return sock;
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  async function rawSend(jid, content) {
    if (!sock) throw new Error('socket not ready');
    return sock.sendMessage(jid, content);
  }

  /** Immediate send for human-triggered replies. */
  async function sendNow(jid, text, options = {}) {
    const content = typeof text === 'string' ? { text, ...options } : text;
    try {
      return await rawSend(jid, content);
    } catch (err) {
      logger.error({ err: err.message, jid }, 'send failed');
      return null;
    }
  }

  /** Short typing indicator so replies do not appear instantaneously. */
  async function showTyping(jid) {
    try {
      await sock?.presenceSubscribe(jid);
      await sock?.sendPresenceUpdate('composing', jid);
    } catch {
      // Presence is cosmetic; never let it break a reply.
    }
  }

  /**
   * Queue an automated broadcast. Returns a promise that settles once the
   * message has been attempted, with `true` on success and `false` on failure,
   * so the outbox can advance its cursor only after delivery was attempted.
   */
  function enqueue(jid, text, { kind = 'alert' } = {}) {
    return new Promise((resolve) => {
      queue.push({ jid, text, kind, settle: resolve });
      void drain();
    });
  }

  function queueLength() {
    return queue.length;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        if (!connected) return; // paused until 'connection.open' calls drain again
        const job = queue.shift();
        const delay = randomBetween(config.sendMinDelayMs, config.sendMaxDelayMs);
        await sleep(delay);
        if (!connected) {
          queue.unshift(job); // put it back; nothing is dropped on a disconnect
          return;
        }
        try {
          await rawSend(job.jid, { text: job.text });
          logger.info({ jid: job.jid, kind: job.kind, delay }, 'broadcast sent');
          job.settle?.(true);
        } catch (err) {
          logger.error({ err: err.message, jid: job.jid, kind: job.kind }, 'broadcast failed');
          job.settle?.(false);
        }
      }
    } finally {
      draining = false;
    }
  }

  /** Groups the bot number is actually a member of, for /groups. */
  async function fetchGroups() {
    try {
      const all = await sock?.groupFetchAllParticipating();
      return Object.values(all ?? {}).map((g) => ({ id: g.id, subject: g.subject }));
    } catch (err) {
      logger.warn({ err: err.message }, 'could not fetch participating groups');
      return [];
    }
  }

  function status() {
    return {
      connected,
      loggedOut,
      lastConnectedAt,
      lastDisconnectReason,
      reconnectAttempts,
      queued: queue.length,
      botNumbers: botNumbers(),
      authDir: path.basename(config.authDir),
    };
  }

  const api = {
    connect,
    sendNow,
    showTyping,
    enqueue,
    queueLength,
    fetchGroups,
    status,
    botNumbers,
    botJids,
    isConnected: () => connected,
  };

  return api;
}
