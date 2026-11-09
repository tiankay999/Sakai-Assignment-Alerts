/**
 * Read-only view of the Python scraper's state.
 *
 * This module never writes to seen.json or scraper_status.json - the scraper
 * owns them. It exists so the assistant and /status can answer from the same
 * data the Telegram channel uses, rather than re-scraping Sakai (which would
 * duplicate logic and double the load on the LMS).
 */
import fs from 'node:fs';
import { config } from './config.js';
import { logger } from './logger.js';
import { courseCode } from './util.js';

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse the date formats Sakai emits, mirroring monitor.py's _DATE_FORMATS.
 * Time-of-day is ignored, exactly as the Python side does (it compares
 * `.date()` values), so "due today" means the same thing on both channels.
 */
export function parseDueDate(value) {
  const t = String(value ?? '').trim();
  if (!t) return null;

  // 2026-05-26
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // 26/05/2026 (day first, as in monitor.py)
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));

  // Jan 15, 2026 / January 15, 2026
  m = t.match(/([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month !== undefined) return new Date(Number(m[3]), month, Number(m[2]));
  }

  // 26 May 2026 / Monday, 26 May 2026
  m = t.match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month !== undefined) return new Date(Number(m[3]), month, Number(m[1]));
  }

  return null;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** "Today" / "Tomorrow" / "Friday, 14 Nov 2026" / "Unknown". */
export function dueLabel(parsed) {
  if (!parsed) return 'Unknown';
  const today = startOfToday();
  const diffDays = Math.round((parsed - today) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return parsed.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

let cache = { mtimeMs: 0, items: [] };

/** All items the scraper has ever recorded, cached on seen.json's mtime. */
export function allItems() {
  try {
    if (!fs.existsSync(config.seenFile)) return [];
    const { mtimeMs } = fs.statSync(config.seenFile);
    if (mtimeMs === cache.mtimeMs) return cache.items;

    const parsed = JSON.parse(fs.readFileSync(config.seenFile, 'utf8'));
    // monitor.py still supports the legacy flat-list format, which carries no
    // metadata at all; treat that as "nothing to show".
    const items = Array.isArray(parsed) ? [] : parsed.items ?? [];
    cache = { mtimeMs, items };
    return items;
  } catch (err) {
    logger.warn({ err: err.message }, 'could not read seen.json');
    return [];
  }
}

const DEADLINE_TYPES = new Set(['Assignment', 'Quiz']);

/**
 * Outstanding deadlines: assignments and quizzes due today or later, plus any
 * whose date could not be parsed (the Python side errs the same way).
 */
export function pendingDeadlines() {
  const today = startOfToday();
  return allItems()
    .filter((item) => DEADLINE_TYPES.has(item.type))
    .map((item) => ({ item, parsed: parseDueDate(item.due_date) }))
    .filter(({ parsed }) => parsed === null || parsed >= today)
    .sort((a, b) => {
      if (!a.parsed) return 1;
      if (!b.parsed) return -1;
      return a.parsed - b.parsed;
    });
}

/** Distinct course titles seen by the scraper, with their derived codes. */
export function knownCourses() {
  const map = new Map();

  // 1. Actively tracked course sites from scraper heartbeat
  const status = scraperStatus();
  if (Array.isArray(status?.courses)) {
    for (const title of status.courses) {
      if (title && !map.has(title)) {
        map.set(title, courseCode(title));
      }
    }
  }

  // 2. Courses that have items in seen.json
  for (const item of allItems()) {
    const title = item.course;
    if (!title || map.has(title)) continue;
    map.set(title, courseCode(title));
  }
  return [...map.entries()].map(([title, code]) => ({ title, code }));
}

/** Case-insensitive course match on code or title substring. */
export function matchCourses(query) {
  const q = String(query ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!q) return [];
  return knownCourses().filter(
    ({ title, code }) => code.includes(q) || title.toUpperCase().replace(/\s+/g, '').includes(q),
  );
}

/** Most recent announcements and resources, newest-last ordering unknown. */
export function recentPostings(limit = 12) {
  return allItems()
    .filter((item) => item.type === 'Announcement' || item.type === 'Resource')
    .slice(-limit);
}

/** The scraper's heartbeat, or null if it has not run yet. */
export function scraperStatus() {
  try {
    if (!fs.existsSync(config.scraperStatusFile)) return null;
    return JSON.parse(fs.readFileSync(config.scraperStatusFile, 'utf8'));
  } catch (err) {
    logger.warn({ err: err.message }, 'could not read scraper_status.json');
    return null;
  }
}
