/**
 * Small shared helpers: JID handling, delays, text trimming, course codes.
 */
import { normalizeNumber } from './config.js';

export { normalizeNumber };

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Inclusive random integer in [min, max]. */
export function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

/** Digits of a JID: "233200000000@s.whatsapp.net" -> "233200000000". */
export function jidDigits(jid) {
  if (!jid) return '';
  return normalizeNumber(String(jid).split('@')[0].split(':')[0]);
}

/**
 * Collect every identifier WhatsApp might have used for the sender of a
 * message, as digit strings.
 *
 * WhatsApp is migrating from phone-number JIDs ("233...@s.whatsapp.net") to
 * opaque LIDs ("...@lid"). Baileys surfaces the phone-number form in different
 * fields depending on version and chat type, so admin matching compares
 * against the whole candidate set rather than one field. The /id command
 * prints this set so an admin can see exactly what to put in ADMIN_NUMBERS.
 */
export function senderIdentifiers(msg) {
  const key = msg?.key ?? {};
  const candidates = [
    key.participant,
    key.participantAlt,
    key.participantPn,
    key.senderPn,
    key.remoteJidAlt,
    isGroupJid(key.remoteJid) ? null : key.remoteJid,
    msg?.participant,
  ];
  const digits = new Set();
  for (const candidate of candidates) {
    const n = jidDigits(candidate);
    if (n) digits.add(n);
  }
  return [...digits];
}

/** Raw sender JID, preferred for @mentions and replies. */
export function senderJid(msg) {
  const key = msg?.key ?? {};
  return key.participant || key.participantAlt || key.remoteJid || '';
}

/** Recursively unwrap common Baileys message containers (ephemeral, view-once, document, etc.) */
export function unwrapMessage(m) {
  let curr = m;
  let iterations = 0;
  while (curr && typeof curr === 'object' && iterations < 8) {
    iterations += 1;
    if (curr.ephemeralMessage?.message) {
      curr = curr.ephemeralMessage.message;
      continue;
    }
    if (curr.viewOnceMessage?.message) {
      curr = curr.viewOnceMessage.message;
      continue;
    }
    if (curr.viewOnceMessageV2?.message) {
      curr = curr.viewOnceMessageV2.message;
      continue;
    }
    if (curr.viewOnceMessageV2Extension?.message) {
      curr = curr.viewOnceMessageV2Extension.message;
      continue;
    }
    if (curr.documentWithCaptionMessage?.message) {
      curr = curr.documentWithCaptionMessage.message;
      continue;
    }
    if (curr.editedMessage?.message?.protocolMessage?.editedMessage) {
      curr = curr.editedMessage.message.protocolMessage.editedMessage;
      continue;
    }
    break;
  }
  return curr || {};
}

/** Extract plain text from any supported message shape (raw message object or WAMessage). */
export function messageText(msg) {
  const raw = msg?.message ? msg.message : msg;
  const m = unwrapMessage(raw);
  if (!m || typeof m !== 'object') return '';

  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    '';
  return String(text).trim();
}

/** Extract contextInfo from any supported message shape. */
export function contextInfoOf(msg) {
  const raw = msg?.message ? msg.message : msg;
  const m = unwrapMessage(raw);
  if (!m || typeof m !== 'object') return null;

  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.stickerMessage?.contextInfo ||
    null
  );
}

/** Check if a message (or its unwrap) contains an image. */
export function hasImageInMessage(msg) {
  const raw = msg?.message ? msg.message : msg;
  const m = unwrapMessage(raw);
  return Boolean(m?.imageMessage);
}

/**
 * Extract details about the quoted message (if this message is a reply to another).
 * Returns { text, hasImage, participant, stanzaId, quotedMessage } or null if not a reply.
 */
export function quotedInfoOf(msg) {
  const ctx = contextInfoOf(msg);
  if (!ctx?.quotedMessage) return null;

  const unwrappedQuoted = unwrapMessage(ctx.quotedMessage);
  const text = messageText({ message: unwrappedQuoted });
  const hasImage = Boolean(unwrappedQuoted?.imageMessage);

  return {
    text,
    hasImage,
    participant: ctx.participant || '',
    stanzaId: ctx.stanzaId || '',
    quotedMessage: ctx.quotedMessage,
    unwrappedQuoted,
  };
}

export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** "UGBS 301: Marketing S1-2526" -> "UGBS301". Falls back to a short slug. */
export function courseCode(title) {
  const t = String(title ?? '').trim();
  if (!t) return '';
  const match = t.match(/\b([A-Za-z]{2,5})\s*[- ]?\s*(\d{3}[A-Za-z]?)\b/);
  if (match) return `${match[1].toUpperCase()}${match[2].toUpperCase()}`;
  return t.split(/[\s:|_-]+/)[0].toUpperCase().slice(0, 12);
}

/** Current month key, e.g. "2026-11", used for the monthly LLM cap. */
export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
