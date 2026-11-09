/**
 * Level 300 Timetable Manager & Alert Engine
 * Scrapes https://dcs.ug.edu.gh/pms/timetable, manages class schedules,
 * and triggers alerts (1 hour before, 30 minutes before, class begins, next class).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { fetchLevel300Timetable } from './timetableScraper.js';
import { groupsForCourse } from './broadcaster.js';
import { groups } from './store.js';

const TIMETABLE_FILE = path.join(config.dataDir, 'timetable_level300.json');
const ALERT_STATE_FILE = path.join(config.dataDir, 'timetable_alert_state.json');

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export class TimetableManager {
  constructor() {
    this.timetable = null;
    this.alertState = this.loadAlertState();
    this.loadCached();
  }

  loadAlertState() {
    try {
      if (fs.existsSync(ALERT_STATE_FILE)) {
        return JSON.parse(fs.readFileSync(ALERT_STATE_FILE, 'utf8'));
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'could not read alert state, resetting');
    }
    return {};
  }

  saveAlertState() {
    try {
      // Clean up keys older than 3 days
      const cutoff = new Date(Date.now() - 3 * 86400 * 1000).toISOString().slice(0, 10);
      const cleaned = {};
      for (const [k, v] of Object.entries(this.alertState)) {
        if (k.slice(0, 10) >= cutoff) cleaned[k] = v;
      }
      this.alertState = cleaned;
      fs.writeFileSync(ALERT_STATE_FILE, JSON.stringify(this.alertState, null, 2), 'utf8');
    } catch (e) {
      logger.warn({ err: e.message }, 'could not save alert state');
    }
  }

  loadCached() {
    try {
      const candidates = [TIMETABLE_FILE, 'timetable_level300.json', path.join(process.cwd(), 'timetable_level300.json')];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          this.timetable = JSON.parse(fs.readFileSync(p, 'utf8'));
          logger.info({ count: this.timetable.entries?.length, path: p }, 'loaded cached Level 300 timetable');
          return;
        }
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'failed to load cached timetable');
    }
  }

  async sync() {
    try {
      const data = await fetchLevel300Timetable();
      this.timetable = data;
      fs.writeFileSync(TIMETABLE_FILE, JSON.stringify(data, null, 2), 'utf8');
      logger.info({ count: data.entries.length }, 'synced fresh Level 300 timetable');
      return data;
    } catch (e) {
      logger.error({ err: e.message }, 'timetable sync failed');
      throw e;
    }
  }

  getEntries() {
    return this.timetable?.entries || [];
  }

  /** Get all classes for a specific day string ('MON', 'TUE', etc.) */
  getClassesForDay(dayStr) {
    const target = dayStr.toUpperCase().trim();
    return this.getEntries().filter(e => e.day.toUpperCase() === target);
  }

  /** Get classes for today */
  getClassesForToday(date = new Date()) {
    const dayStr = DAY_NAMES[date.getDay()];
    return this.getClassesForDay(dayStr);
  }

  /** Find the next class of the day after the given date/time */
  getNextClassToday(date = new Date()) {
    const todayClasses = this.getClassesForToday(date);
    const currentMins = date.getHours() * 60 + date.getMinutes();

    for (const c of todayClasses) {
      const [h, m] = c.startTime.split(':').map(Number);
      const classStartMins = h * 60 + m;
      if (classStartMins > currentMins) {
        return c;
      }
    }
    return null;
  }

  /** Format a daily summary message */
  formatDailySchedule(date = new Date()) {
    const dayName = DAY_NAMES[date.getDay()];
    const todayClasses = this.getClassesForToday(date);

    if (!todayClasses.length) {
      return (
        `🌴 *No Classes Today!*\n\n` +
        `There are no Level 300 classes scheduled for today (${dayName}).\n` +
        `Enjoy your day off or catch up on your studies!`
      );
    }

    const lines = [
      `📅 *Level 300 Schedule for Today (${dayName})*`,
      `Total classes: ${todayClasses.length}\n`
    ];

    for (const c of todayClasses) {
      lines.push(`⏰ *${c.startTime} - ${c.endTime}* | *${c.courseCode}*`);
      lines.push(`   📖 ${c.courseTitle}`);
      lines.push(`   🏛️ Venue: *${c.venue}* (${c.status})`);
      lines.push(`   👨‍🏫 Lecturer: ${c.lecturer}\n`);
    }

    return lines.join('\n').trim();
  }

  /** Format full weekly timetable */
  formatFullTimetable(filterDay = null) {
    const entries = this.getEntries();
    if (!entries.length) return 'Timetable not loaded yet. Run /sync_timetable first.';

    const days = filterDay ? [filterDay.toUpperCase()] : ['MON', 'TUE', 'WED', 'THU', 'FRI'];
    const lines = [`📚 *DCS Level 300 Timetable (2026/2027)*\n`];

    for (const day of days) {
      const dayClasses = this.getClassesForDay(day);
      if (!dayClasses.length) continue;

      lines.push(`*--- ${day} (${dayClasses.length} classes) ---*`);
      for (const c of dayClasses) {
        lines.push(`• *${c.startTime} - ${c.endTime}* · *${c.courseCode}* (${c.status})`);
        lines.push(`   🏛️ ${c.venue} | 👨‍🏫 ${c.lecturer}`);
      }
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  /** Check for 60m, 30m, and 0m alerts and send them */
  async checkAndDispatchAlerts({ whatsapp, broadcaster }) {
    if (!this.timetable?.entries) return;

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const dayStr = DAY_NAMES[now.getDay()];
    const currentMins = now.getHours() * 60 + now.getMinutes();

    // 1. Morning 07:00 AM daily overview or "No classes today" alert
    if (now.getHours() === 7 && now.getMinutes() === 0) {
      const morningKey = `${todayStr}::morning_schedule`;
      if (!this.alertState[morningKey]) {
        this.alertState[morningKey] = true;
        this.saveAlertState();
        const msg = this.formatDailySchedule(now);
        await this.broadcastToAllGroups(broadcaster, msg);
      }
    }

    // 2. Class-specific alerts for today
    const todayClasses = this.getClassesForToday(now);
    if (!todayClasses.length) return;

    for (const c of todayClasses) {
      const [h, m] = c.startTime.split(':').map(Number);
      const classStartMins = h * 60 + m;
      const diffMins = classStartMins - currentMins;

      // Identify which alert window we are in:
      // 1-hour alert: diff between 58 and 61 mins
      // 30-min alert: diff between 28 and 31 mins
      // Begins alert: diff between -1 and 1 mins
      let alertType = null;
      let alertMsg = null;

      if (diffMins >= 58 && diffMins <= 61) {
        alertType = '60m';
        alertMsg = (
          `⏰ *Class Reminder — 1 Hour Alert!*\n\n` +
          `📚 *Course:* ${c.courseCode} - ${c.courseTitle}\n` +
          `🏛️ *Auditorium/Venue:* ${c.venue}\n` +
          `⏰ *Time:* ${c.startTime} - ${c.endTime} (Starts in 1 hour)\n` +
          `👨‍🏫 *Lecturer:* ${c.lecturer}\n` +
          `📌 *Status:* ${c.status}`
        );
      } else if (diffMins >= 28 && diffMins <= 31) {
        alertType = '30m';
        alertMsg = (
          `⏳ *Class Reminder — 30 Minutes More!*\n\n` +
          `📚 *Course:* ${c.courseCode} - ${c.courseTitle}\n` +
          `🏛️ *Auditorium/Venue:* ${c.venue}\n` +
          `⏰ *Time:* ${c.startTime} - ${c.endTime} (Starts in 30 mins)\n` +
          `👨‍🏫 *Lecturer:* ${c.lecturer}`
        );
      } else if (diffMins >= -1 && diffMins <= 1) {
        alertType = '0m';
        const nextClass = this.getNextClassToday(now);
        const nextClassText = nextClass
          ? `${nextClass.courseCode} at ${nextClass.startTime} in ${nextClass.venue}`
          : 'None (This is the last class of the day!)';

        alertMsg = (
          `🔔 *Class Begins Now!*\n\n` +
          `📚 *Course:* ${c.courseCode} - ${c.courseTitle}\n` +
          `🏛️ *Auditorium/Venue:* ${c.venue}\n` +
          `⏰ *Time:* ${c.startTime} - ${c.endTime}\n` +
          `👨‍🏫 *Lecturer:* ${c.lecturer}\n\n` +
          `➡️ *Next Class Today:* ${nextClassText}`
        );
      }

      if (alertType && alertMsg) {
        const alertKey = `${todayStr}::${c.courseCode}::${c.startTime}::${alertType}`;
        if (!this.alertState[alertKey]) {
          this.alertState[alertKey] = true;
          this.saveAlertState();
          logger.info({ course: c.courseCode, alertType }, 'sending class reminder alert');
          await this.routeClassAlert(broadcaster, c.courseCode, alertMsg);
        }
      }
    }
  }

  /** Route an alert to groups mapped to this course, or all groups if none mapped specifically */
  async routeClassAlert(broadcaster, courseCode, message) {
    const targets = groupsForCourse(courseCode);
    if (targets.length > 0) {
      await broadcaster.broadcastManual(targets, message);
    } else {
      // If course is not specifically mapped to a single group, broadcast to all mapped groups
      await this.broadcastToAllGroups(broadcaster, message);
    }
  }

  async broadcastToAllGroups(broadcaster, message) {
    const allGroupJids = new Set();
    for (const jids of Object.values(groups.data.courses)) {
      for (const jid of jids) allGroupJids.add(jid);
    }
    if (allGroupJids.size > 0) {
      await broadcaster.broadcastManual([...allGroupJids], message);
    }
  }
}

export const timetableManager = new TimetableManager();
