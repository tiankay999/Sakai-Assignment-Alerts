/**
 * Tiny JSON persistence layer on the shared /data volume.
 *
 * Everything this service needs to survive a restart lives here: course to
 * group mapping, sponsor lines, the mute list, LLM usage counters, pause state
 * and the outbox cursor. Writes are atomic (temp file + rename) so a container
 * restart mid-write cannot leave a truncated config behind.
 *
 * Note what is NOT stored: no Sakai identities, no credentials, no message
 * bodies. The only personal data here is a WhatsApp number on the mute list
 * and a hashed-free JID key for rate limiting, both of which the bot needs to
 * do its job.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { monthKey } from './util.js';

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    logger.error({ err: err.message, dir }, 'could not create data directory');
  }
}

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...structuredClone(this.defaults), ...parsed };
      }
    } catch (err) {
      logger.warn(
        { err: err.message, file: path.basename(this.file) },
        'unreadable store, falling back to defaults',
      );
      this.data = structuredClone(this.defaults);
    }
    return this.data;
  }

  save() {
    ensureDir(path.dirname(this.file));
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      logger.error(
        { err: err.message, file: path.basename(this.file) },
        'could not persist store',
      );
    }
    return this.data;
  }
}

ensureDir(config.dataDir);

// ---------------------------------------------------------------------------
// Course -> group mapping
// ---------------------------------------------------------------------------

export const groups = new JsonStore(config.groupsFile, { courses: {}, names: {} });

/** Normalise a course key so "ugbs 301" and "UGBS301" are the same bucket. */
export function courseKey(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

export function addGroupMapping(course, groupJid, label) {
  const key = courseKey(course);
  if (!key || !groupJid) return false;
  const list = groups.data.courses[key] ?? [];
  if (!list.includes(groupJid)) list.push(groupJid);
  groups.data.courses[key] = list;
  if (label) groups.data.names[groupJid] = label;
  groups.save();
  return true;
}

export function removeGroupMapping(course, groupJid) {
  const key = courseKey(course);
  const list = groups.data.courses[key];
  if (!list) return false;
  const next = list.filter((jid) => jid !== groupJid);
  if (next.length === list.length) return false;
  if (next.length) groups.data.courses[key] = next;
  else delete groups.data.courses[key];
  groups.save();
  return true;
}

export function setGroupLabel(groupJid, label) {
  groups.data.names[groupJid] = label;
  groups.save();
}

export function groupLabel(groupJid) {
  return groups.data.names[groupJid] || groupJid;
}

/** Every group JID that has at least one mapping (including the wildcard). */
export function allMappedGroups() {
  const set = new Set();
  for (const list of Object.values(groups.data.courses)) {
    for (const jid of list) set.add(jid);
  }
  return [...set];
}

/**
 * Resolve a group reference typed by an admin. Accepts a raw JID, a saved
 * label, or a course key. Returns a list of JIDs (a course can map to several
 * groups; "all" fans out to everything mapped).
 */
export function resolveGroupRef(ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return [];
  if (raw.toLowerCase() === 'all' || raw === '*') return allMappedGroups();
  if (raw.endsWith('@g.us')) return [raw];

  const byLabel = Object.entries(groups.data.names)
    .filter(([, label]) => String(label).toLowerCase() === raw.toLowerCase())
    .map(([jid]) => jid);
  if (byLabel.length) return byLabel;

  const byCourse = groups.data.courses[courseKey(raw)];
  if (byCourse?.length) return [...byCourse];

  return [];
}

// ---------------------------------------------------------------------------
// Sponsors (a single appended line per group, digest only)
// ---------------------------------------------------------------------------

export const sponsors = new JsonStore(config.sponsorsFile, { global: null, groups: {} });

export function setSponsorLine(groupJid, line, by) {
  const entry = { line, updatedAt: new Date().toISOString(), by };
  if (groupJid === 'all') sponsors.data.global = entry;
  else sponsors.data.groups[groupJid] = entry;
  sponsors.save();
}

export function clearSponsorLine(groupJid) {
  if (groupJid === 'all') sponsors.data.global = null;
  else delete sponsors.data.groups[groupJid];
  sponsors.save();
}

/** Per-group line wins over the global one. */
export function sponsorLineFor(groupJid) {
  return sponsors.data.groups[groupJid]?.line || sponsors.data.global?.line || '';
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

export const moderation = new JsonStore(config.moderationFile, { muted: [] });

export function isMuted(digitsList) {
  return digitsList.some((d) => moderation.data.muted.includes(d));
}

export function mute(digits) {
  if (!digits || moderation.data.muted.includes(digits)) return false;
  moderation.data.muted.push(digits);
  moderation.save();
  return true;
}

export function unmute(digits) {
  const next = moderation.data.muted.filter((d) => d !== digits);
  if (next.length === moderation.data.muted.length) return false;
  moderation.data.muted = next;
  moderation.save();
  return true;
}

// ---------------------------------------------------------------------------
// Bot state (pause switch + last activity, for /status)
// ---------------------------------------------------------------------------

export const botState = new JsonStore(config.stateFile, {
  paused: false,
  startedAt: null,
  lastBroadcastAt: null,
  lastDigestAt: null,
  deliveries: 0,
  ignoredCommands: 0,
});

export function setPaused(paused) {
  botState.data.paused = Boolean(paused);
  botState.save();
}

export function noteDelivery(kind) {
  botState.data.deliveries += 1;
  const now = new Date().toISOString();
  if (kind === 'digest') botState.data.lastDigestAt = now;
  else botState.data.lastBroadcastAt = now;
  botState.save();
}

export function noteIgnoredCommand() {
  // Counter only - we deliberately never store who sent it or what it said.
  botState.data.ignoredCommands += 1;
  botState.save();
}

// ---------------------------------------------------------------------------
// LLM usage: per-user sliding window + monthly token/cost cap
// ---------------------------------------------------------------------------

export const usage = new JsonStore(config.usageFile, {
  month: monthKey(),
  promptTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  requests: 0,
  users: {},
});

/** Reset counters when the calendar month rolls over. */
function rollMonth() {
  const current = monthKey();
  if (usage.data.month !== current) {
    usage.data = {
      month: current,
      promptTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requests: 0,
      users: {},
    };
    usage.save();
  }
}

export function estimatedCost() {
  const { inputPricePerMTok, outputPricePerMTok } = config.gemini;
  return (
    (usage.data.promptTokens / 1e6) * inputPricePerMTok +
    (usage.data.outputTokens / 1e6) * outputPricePerMTok
  );
}

/** Monthly cap check. Returns null when there is budget left. */
export function capExceeded() {
  rollMonth();
  const { monthlyTokenCap, monthlyCostCap } = config.gemini;
  if (monthlyTokenCap > 0 && usage.data.totalTokens >= monthlyTokenCap) {
    return 'token';
  }
  if (monthlyCostCap > 0 && estimatedCost() >= monthlyCostCap) {
    return 'cost';
  }
  return null;
}

/**
 * Per-user sliding-window rate limit. Returns
 * { allowed, remaining, retryAfterMs }.
 */
export function checkUserRate(userKey) {
  rollMonth();
  const now = Date.now();
  const windowMs = config.gemini.rateWindowMs;
  const limit = config.gemini.rateLimit;
  const hits = (usage.data.users[userKey] ?? []).filter((ts) => now - ts < windowMs);
  usage.data.users[userKey] = hits;

  if (limit > 0 && hits.length >= limit) {
    const retryAfterMs = windowMs - (now - Math.min(...hits));
    return { allowed: false, remaining: 0, retryAfterMs };
  }
  return { allowed: true, remaining: limit > 0 ? limit - hits.length : Infinity, retryAfterMs: 0 };
}

/** Record that a user consumed one request (called before the API call). */
export function recordUserRequest(userKey) {
  rollMonth();
  const hits = usage.data.users[userKey] ?? [];
  hits.push(Date.now());
  usage.data.users[userKey] = hits;
  usage.data.requests += 1;
  usage.save();
}

/** Record token consumption reported by the Gemini API. */
export function recordTokens({ promptTokens = 0, outputTokens = 0, totalTokens = 0 }) {
  rollMonth();
  usage.data.promptTokens += promptTokens;
  usage.data.outputTokens += outputTokens;
  usage.data.totalTokens += totalTokens || promptTokens + outputTokens;
  usage.save();
}

// ---------------------------------------------------------------------------
// Outbox cursor
// ---------------------------------------------------------------------------

const MAX_DELIVERED_IDS = 2000;

export const cursor = new JsonStore(config.cursorFile, { offset: 0, delivered: [] });

export function alreadyDelivered(eventId) {
  return cursor.data.delivered.includes(eventId);
}

export function markDelivered(eventId, offset) {
  if (eventId && !cursor.data.delivered.includes(eventId)) {
    cursor.data.delivered.push(eventId);
    if (cursor.data.delivered.length > MAX_DELIVERED_IDS) {
      cursor.data.delivered = cursor.data.delivered.slice(-MAX_DELIVERED_IDS);
    }
  }
  if (Number.isFinite(offset)) cursor.data.offset = offset;
  cursor.save();
}

export function setCursorOffset(offset) {
  cursor.data.offset = offset;
  cursor.save();
}
