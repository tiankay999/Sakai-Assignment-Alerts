/**
 * WhatsApp message formatting.
 *
 * House style: one emoji per message, a bold header, then plain text. User and
 * course content is never placed inside WhatsApp formatting markers, for the
 * same reason monitor.py sends Telegram messages as plain text - a title
 * containing an asterisk or underscore should never mangle the message.
 */
import { config } from './config.js';
import { dueLabel, parseDueDate } from './sakaiState.js';
import { courseCode, truncate } from './util.js';

const TYPE_STYLE = {
  Assignment: { emoji: '\u{1F4DD}', heading: 'New Assignment', dateLabel: 'Due' },
  Quiz: { emoji: '\u{1F9EA}', heading: 'New Quiz', dateLabel: 'Due' },
  Announcement: { emoji: '\u{1F4E3}', heading: 'Announcement', dateLabel: 'Posted' },
  Resource: { emoji: '\u{1F4C1}', heading: 'New Resource', dateLabel: 'Added' },
};

const FALLBACK_STYLE = { emoji: '\u{1F514}', heading: 'New Item', dateLabel: 'Date' };

/**
 * Format one scraped item for a group.
 *
 * The raw Sakai date string is kept (it carries the time of day) and a
 * relative hint is appended when the date is near, so "Due: Nov 14, 2026
 * 11:59 PM (Tomorrow)" reads at a glance without losing precision.
 */
export function formatAlert(item) {
  const style = TYPE_STYLE[item.type] ?? FALLBACK_STYLE;
  const code = courseCode(item.course);
  const raw = item.due_date || item.posted_date || '';

  const lines = [];
  lines.push(`${style.emoji} *${style.heading}*${code ? ` · ${code}` : ''}`);
  lines.push(truncate(item.title || 'Untitled', 180));

  if (raw) {
    const parsed = parseDueDate(raw);
    const hint = parsed ? dueLabel(parsed) : '';
    const showHint = hint === 'Today' || hint === 'Tomorrow';
    lines.push(`${style.dateLabel}: ${raw}${showHint ? ` (${hint})` : ''}`);
  } else if (style.dateLabel === 'Due') {
    lines.push('Due: not stated');
  }

  if (item.course) lines.push(`Course: ${truncate(item.course, 120)}`);
  if (item.link) lines.push(item.link);

  return lines.join('\n');
}

/**
 * Format the 8am/12pm/6pm deadline digest for one group.
 *
 * `entries` are the digest rows the scraper queued, already filtered to the
 * courses this group is mapped to. The sponsor line, if any, is appended here
 * and only here - digests are the single place an ad is allowed to appear.
 */
export function formatDigest({ greeting, entries, sponsorLine, groupLabel }) {
  const lines = [];
  const header = `\u{1F4C5} *${greeting || 'Hello!'}*`;

  if (!entries.length) {
    lines.push(header);
    lines.push('');
    lines.push('No pending assignments or quizzes right now. Enjoy your day.');
  } else {
    lines.push(header);
    lines.push('');
    lines.push(`Pending work${groupLabel ? ` for ${groupLabel}` : ''}:`);
    lines.push('');
    for (const entry of entries) {
      const code = courseCode(entry.course);
      lines.push(`${code ? `${code} · ` : ''}${truncate(entry.title || 'Untitled', 140)}`);
      lines.push(`   ${entry.type === 'Quiz' ? 'Quiz' : 'Assignment'} — due ${entry.due_label}`);
    }
  }

  if (sponsorLine) {
    lines.push('');
    lines.push(`— ${truncate(sponsorLine, 220)}`);
  }

  return lines.join('\n');
}

/** Line nudging towards past questions, appended to course-specific answers. */
export function questionsDeyLine(courseLabel) {
  const subject = courseLabel ? `${courseLabel} ` : '';
  return `\u{1F4DA} Past ${subject}questions: ${config.questionsDeyUrl}`;
}
