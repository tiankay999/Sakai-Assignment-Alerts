/**
 * Admin command parser.
 *
 * Authorisation is decided by the caller (index.js) and passed in as
 * `isAdmin`; every command here except /ask and /help requires it. Commands
 * from non-admins are not answered and not echoed - they only bump a counter,
 * so a stranger probing the bot learns nothing and leaves no message content
 * in the logs.
 */
import { config } from './config.js';
import { logger } from './logger.js';
import { deadlinesText } from './assistant.js';
import { groupsForCourse } from './broadcaster.js';
import {
  addGroupMapping,
  botState,
  clearSponsorLine,
  courseKey,
  groupLabel,
  groups,
  moderation,
  mute,
  removeGroupMapping,
  resolveGroupRef,
  setGroupLabel,
  setPaused,
  setSponsorLine,
  sponsors,
  unmute,
} from './store.js';
import { knownCourses, scraperStatus } from './sakaiState.js';
import { isGroupJid, normalizeNumber, senderIdentifiers } from './util.js';
import { timetableManager } from './timetable.js';

/** Commands anyone may use. Everything else is admin-only. */
const PUBLIC_COMMANDS = new Set(['ask', 'help', 'deadlines', 'id', 'today', 'classes', 'nextclass', 'timetable']);

function parse(text) {
  const prefix = config.commandPrefix;
  if (!text.startsWith(prefix)) return null;
  const body = text.slice(prefix.length).trim();
  if (!body) return null;
  const [name, ...rest] = body.split(/\s+/);
  return { name: name.toLowerCase(), args: rest, rest: body.slice(name.length).trim() };
}

function helpText(isAdmin) {
  const p = config.commandPrefix;
  const lines = [
    `*${config.botName}*`,
    '',
    `${p}today / ${p}classes — today's class schedule & venues (or free day notice)`,
    `${p}nextclass — upcoming class today`,
    `${p}timetable [day] — full Level 300 timetable (e.g. ${p}timetable mon)`,
    `${p}deadlines — outstanding assignments and quizzes`,
    `${p}ask <question> — ask the study assistant (you can also @mention or reply to me)`,
    `${p}help — this message`,
  ];
  if (isAdmin) {
    lines.push(
      '',
      '*Admin*',
      `${p}status — scraper, groups, queue, token usage`,
      `${p}id — show the identifiers for this chat and sender`,
      `${p}groups — list groups I am in and the course mapping`,
      `${p}addgroup <course> <groupId|here> [label] — map a course to a group`,
      `${p}removegroup <course> <groupId|here> — unmap`,
      `${p}broadcast <group|all> <message> — send a message to a group`,
      `${p}sync_timetable — reload DCS Level 300 timetable live`,
      `${p}ad <group|all> <message> — set the sponsor line appended to digests`,
      `${p}ad clear <group|all> — remove it`,
      `${p}mute <number> / ${p}unmute <number> — block a user from the assistant`,
      `${p}pause / ${p}resume — stop or restart broadcasting`,
    );
  }
  return lines.join('\n');
}

function formatMapping() {
  const entries = Object.entries(groups.data.courses);
  if (!entries.length) return '(no course is mapped yet)';
  return entries
    .map(([course, jids]) => {
      const labels = jids.map((jid) => groupLabel(jid)).join(', ');
      return `${course} -> ${labels}`;
    })
    .join('\n');
}

export function createCommands({ whatsapp, broadcaster, assistant }) {
  async function statusText() {
    const wa = whatsapp.status();
    const scraper = scraperStatus();
    const llm = assistant.usageSummary();
    const mapped = Object.keys(groups.data.courses).length;

    const lines = [
      '*Status*',
      '',
      `Broadcasting: ${botState.data.paused ? 'PAUSED' : 'active'}`,
      `WhatsApp: ${wa.connected ? 'connected' : 'disconnected'}${wa.loggedOut ? ' (logged out - re-link needed)' : ''}`,
      `Send queue: ${wa.queued} waiting`,
      `Messages delivered: ${botState.data.deliveries}`,
      `Ignored non-admin commands: ${botState.data.ignoredCommands}`,
      '',
      '*Scraper*',
    ];

    if (!scraper) {
      lines.push('No heartbeat yet - the Python scraper has not finished a cycle.');
    } else {
      lines.push(`Last cycle: ${scraper.last_cycle} at ${scraper.updated_at}`);
      if (scraper.sites !== undefined) lines.push(`Course sites: ${scraper.sites}`);
      if (scraper.tracked_items !== undefined) lines.push(`Items tracked: ${scraper.tracked_items}`);
      if (scraper.pending_items !== undefined) lines.push(`Pending items: ${scraper.pending_items}`);
      if (scraper.new_last_cycle) {
        const n = scraper.new_last_cycle;
        lines.push(
          `New last cycle: ${n.assignments_quizzes} tasks, ${n.announcements} announcements, ${n.resources} resources`,
        );
      }
    }

    lines.push(
      '',
      '*Groups*',
      `Courses mapped: ${mapped}`,
      formatMapping(),
      '',
      '*Assistant*',
      `Month: ${llm.month}`,
      `Requests: ${llm.requests}`,
      `Tokens: ${llm.totalTokens}${llm.tokenCap ? ` / ${llm.tokenCap}` : ' (no cap)'}`,
      `Estimated cost: $${llm.estimatedCostUsd.toFixed(4)}${llm.costCap ? ` / $${llm.costCap}` : ''}`,
      `Muted users: ${moderation.data.muted.length}`,
    );

    if (sponsors.data.global?.line) lines.push('', `Sponsor (all groups): ${sponsors.data.global.line}`);
    const perGroup = Object.entries(sponsors.data.groups);
    if (perGroup.length) {
      lines.push('', 'Sponsor lines per group:');
      for (const [jid, entry] of perGroup) lines.push(`${groupLabel(jid)}: ${entry.line}`);
    }

    return lines.join('\n');
  }

  /** Resolve a group argument, allowing "here" for the current chat. */
  function resolveTarget(ref, chatJid) {
    if (!ref) return [];
    if (ref.toLowerCase() === 'here') return isGroupJid(chatJid) ? [chatJid] : [];
    return resolveGroupRef(ref);
  }

  /**
   * Handle a command. Returns the text to reply with, or null for silence.
   * `ask` is returned as a marker so index.js can route it through the
   * assistant with the same gating as an @mention.
   */
  async function handle({ msg, chatJid, text, isAdmin }) {
    const parsed = parse(text);
    if (!parsed) return null;

    const { name, args, rest } = parsed;

    if (!PUBLIC_COMMANDS.has(name) && !isAdmin) {
      botState.data.ignoredCommands += 1;
      botState.save();
      logger.debug({ chatJid }, 'ignored command from non-admin');
      // In direct messages (DM), provide feedback so the admin knows what to do
      if (!isGroupJid(chatJid)) {
        return '⚠️ You are not recognized as an admin. Send /id to check your number, then add it to ADMIN_NUMBERS in Coolify.';
      }
      return null;
    }

    switch (name) {
      case 'help':
        return helpText(isAdmin);

      case 'ask':
        return { assistantQuestion: rest };

      case 'deadlines':
        return deadlinesText();

      case 'today':
      case 'classes':
        return timetableManager.formatDailySchedule();

      case 'nextclass': {
        const next = timetableManager.getNextClassToday();
        if (!next) return 'No more classes scheduled for today!';
        return [
          '⏰ *Next Class Today*',
          `📚 *Course:* ${next.courseCode} - ${next.courseTitle}`,
          `🏛️ *Venue:* ${next.venue} (${next.status})`,
          `⏰ *Time:* ${next.startTime} - ${next.endTime}`,
          `👨‍🏫 *Lecturer:* ${next.lecturer}`,
        ].join('\n');
      }

      case 'timetable': {
        const dayArg = args[0] ? args[0].toUpperCase() : null;
        return timetableManager.formatFullTimetable(dayArg);
      }

      case 'sync_timetable': {
        try {
          const data = await timetableManager.sync();
          return `✅ Synced timetable successfully! Loaded ${data.entries.length} Level 300 class sessions (${data.meta.academicYear} - ${data.meta.semester}).`;
        } catch (err) {
          return `❌ Timetable sync failed: ${err.message}`;
        }
      }

      case 'id': {
        const identifiers = senderIdentifiers(msg);
        return [
          '*Identifiers*',
          `Chat: ${chatJid}`,
          `Chat type: ${isGroupJid(chatJid) ? 'group' : 'direct'}`,
          `You: ${identifiers.join(', ') || 'unknown'}`,
          `Bot: ${whatsapp.botNumbers().join(', ') || 'unknown'}`,
          '',
          'Put your number in ADMIN_NUMBERS, and use the chat ID with /addgroup.',
        ].join('\n');
      }

      case 'status':
        return statusText();

      case 'groups': {
        const participating = await whatsapp.fetchGroups();
        const lines = ['*Groups I am in*', ''];
        if (!participating.length) {
          lines.push('(none - add the bot number to a group first)');
        } else {
          for (const g of participating) {
            const courses = Object.entries(groups.data.courses)
              .filter(([, jids]) => jids.includes(g.id))
              .map(([course]) => course);
            lines.push(`${g.subject}`);
            lines.push(`  ${g.id}`);
            lines.push(`  courses: ${courses.length ? courses.join(', ') : 'none'}`);
          }
        }
        lines.push('', '*Course mapping*', formatMapping());

        const tracked = knownCourses();
        if (tracked.length) {
          lines.push('', '*Courses the scraper sees*');
          for (const c of tracked) lines.push(`${c.code} — ${c.title}`);
        }
        return lines.join('\n');
      }

      case 'addgroup': {
        const [course, groupRef, ...labelParts] = args;
        if (!course || !groupRef) {
          return `Usage: ${config.commandPrefix}addgroup <course> <groupId|here> [label]`;
        }
        const targets = resolveTarget(groupRef, chatJid);
        if (!targets.length) {
          return 'Could not resolve that group. Run /groups for IDs, or use "here" inside the group.';
        }
        const label = labelParts.join(' ');
        for (const jid of targets) {
          addGroupMapping(course, jid, label || undefined);
        }
        return `Mapped ${courseKey(course)} to ${targets.map((j) => groupLabel(j)).join(', ')}.`;
      }

      case 'removegroup': {
        const [course, groupRef] = args;
        if (!course || !groupRef) {
          return `Usage: ${config.commandPrefix}removegroup <course> <groupId|here>`;
        }
        const targets = resolveTarget(groupRef, chatJid);
        if (!targets.length) return 'Could not resolve that group.';
        const removed = targets.filter((jid) => removeGroupMapping(course, jid));
        return removed.length
          ? `Unmapped ${courseKey(course)} from ${removed.length} group(s).`
          : 'That mapping did not exist.';
      }

      case 'setlabel': {
        const [groupRef, ...labelParts] = args;
        const label = labelParts.join(' ');
        const targets = resolveTarget(groupRef, chatJid);
        if (!targets.length || !label) {
          return `Usage: ${config.commandPrefix}setlabel <groupId|here> <label>`;
        }
        for (const jid of targets) setGroupLabel(jid, label);
        return `Label set for ${targets.length} group(s).`;
      }

      case 'broadcast': {
        const groupRef = args[0];
        // Strip just the first token so newlines in the message survive.
        const message = rest.replace(/^\S+\s*/, '').trim();
        if (!groupRef || !message) {
          return `Usage: ${config.commandPrefix}broadcast <group|all|here> <message>`;
        }
        const targets = resolveTarget(groupRef, chatJid);
        if (!targets.length) return 'Could not resolve that group. Run /groups for IDs.';
        if (botState.data.paused) return 'Broadcasting is paused. Run /resume first.';
        const sent = await broadcaster.broadcastManual(targets, message);
        return `Sent to ${sent} of ${targets.length} group(s).`;
      }

      case 'ad': {
        const [first, ...restArgs] = args;
        if (!first) {
          return `Usage: ${config.commandPrefix}ad <group|all> <message>  |  ${config.commandPrefix}ad clear <group|all>`;
        }

        if (first.toLowerCase() === 'clear') {
          const ref = restArgs[0] ?? 'all';
          if (ref.toLowerCase() === 'all') {
            clearSponsorLine('all');
            return 'Global sponsor line cleared.';
          }
          const targets = resolveTarget(ref, chatJid);
          if (!targets.length) return 'Could not resolve that group.';
          for (const jid of targets) clearSponsorLine(jid);
          return `Sponsor line cleared for ${targets.length} group(s).`;
        }

        const message = restArgs.join(' ').trim();
        if (!message) return 'Give me the sponsor line text.';

        if (first.toLowerCase() === 'all') {
          setSponsorLine('all', message, 'admin');
          return 'Sponsor line set for all groups. It will be appended to the next digest only.';
        }
        const targets = resolveTarget(first, chatJid);
        if (!targets.length) return 'Could not resolve that group.';
        for (const jid of targets) setSponsorLine(jid, message, 'admin');
        return [
          `Sponsor line set for ${targets.length} group(s).`,
          'It is appended to the 8am/12pm/6pm digest - nothing is sent now.',
        ].join('\n');
      }

      // A number may be typed with spaces or a "+", so join every argument
      // before stripping non-digits - "+233 20 000 0000" must not become "233".
      case 'mute': {
        const digits = normalizeNumber(args.join(''));
        if (!digits) return `Usage: ${config.commandPrefix}mute <number>`;
        return mute(digits)
          ? `${digits} can no longer use the assistant.`
          : `${digits} was already muted.`;
      }

      case 'unmute': {
        const digits = normalizeNumber(args.join(''));
        if (!digits) return `Usage: ${config.commandPrefix}unmute <number>`;
        return unmute(digits) ? `${digits} unmuted.` : `${digits} was not muted.`;
      }

      case 'pause':
        setPaused(true);
        return 'Broadcasting paused. Alerts keep queuing in outbox.jsonl and go out on /resume.';

      case 'resume':
        setPaused(false);
        return 'Broadcasting resumed.';

      case 'whereto': {
        // Diagnostic: which groups would receive items for a given course.
        const course = args.join(' ');
        if (!course) return `Usage: ${config.commandPrefix}whereto <course title or code>`;
        const targets = groupsForCourse(course);
        return targets.length
          ? `Would go to: ${targets.map((j) => groupLabel(j)).join(', ')}`
          : 'No group is mapped for that course.';
      }

      default:
        return isAdmin ? `Unknown command. Try ${config.commandPrefix}help` : null;
    }
  }

  return { handle, parse, helpText };
}
