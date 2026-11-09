import fs from 'node:fs';

// Core mappings extracted directly from DCS Curriculum:
// CS Core: DCIT 301, DCIT 303, DCIT 307, DCIT 313, DCIT 323, MATH 359
// IT Core: DCIT 301, DCIT 303, DCIT 307, DCIT 313, DCIT 317, DCIT 323
// Combined CS/Math: MATH 351, MATH 353, MATH 355
// Combined CS/Stat: STAT 331, STAT 333, STAT 335
// Combined CS/Phys: PHYS 305, PHYS 343, PHYS 345, PHYS 351

function getCourseStatus(code) {
  const c = code.toUpperCase().replace(/\s+/g, '');
  if (['DCIT301', 'DCIT303', 'DCIT307', 'DCIT313', 'DCIT323'].includes(c)) {
    return 'Core (CS & IT)';
  }
  if (c === 'DCIT317') return 'Core (IT), Elective (CS)';
  if (c === 'MATH359') return 'Core (CS), Elective (IT)';
  if (['DCIT309', 'DCIT311'].includes(c)) return 'Elective (CS)';
  if (['DCIT315', 'DCIT321'].includes(c)) return 'Elective (IT)';
  if (['MATH351', 'MATH353', 'MATH355'].includes(c)) return 'Core (CS & Math)';
  if (['STAT331', 'STAT333', 'STAT335', 'STAT339'].includes(c)) return 'Core (CS & Stat)';
  if (['PHYS305', 'PHYS343', 'PHYS345', 'PHYS351'].includes(c)) return 'Core (CS & Phys)';
  return 'Elective';
}

function calculateEndTime(startStr, hours) {
  const [h, m] = startStr.split(':').map(Number);
  const totalMins = h * 60 + m + Math.round(hours * 60);
  const endH = Math.floor(totalMins / 60);
  const endM = totalMins % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

export async function fetchLevel300Timetable() {
  console.log('[*] Fetching active timetable from DCS PMS API...');
  const listRes = await fetch('https://api.dcspms.me/api/public/timetables');
  const timetables = await listRes.json();
  const active = timetables.find(t => t.published) || timetables[0];
  if (!active) throw new Error('No published timetable found');

  console.log(`[+] Using Timetable ID ${active.id}: ${active.academicYear} - ${active.semester}`);
  const res = await fetch(`https://api.dcspms.me/api/public/timetables/${active.id}`);
  const data = await res.json();
  const entries = data.data?.entries || [];

  const daysOrder = { MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 7 };

  const parsed = [];
  for (const e of entries) {
    const code = String(e.course || '').trim();
    if (!code) continue;

    // Only keep DCIT courses for Level 300
    const isDCITL300 = /^DCIT\s*3\d{2}/i.test(code) || (e.level === 300 && /^DCIT/i.test(code));
    if (!isDCITL300) continue;

    const lecturers = (e.lecturers || [])
      .map(l => l.fullName ? l.fullName.trim() : (l.initials ? l.initials.trim() : ''))
      .filter(Boolean);

    const lecturerStr = lecturers.join(', ') || 'TBA';
    const endTime = calculateEndTime(e.start, e.hours);
    const status = getCourseStatus(code);

    parsed.push({
      id: e.id,
      day: e.day,
      dayIndex: daysOrder[e.day] ?? 9,
      startTime: e.start,
      endTime: endTime,
      durationHours: e.hours,
      courseCode: code,
      courseTitle: e.title || '',
      venue: e.venue || 'TBA',
      lecturer: lecturerStr,
      status: status,
      raw: e
    });
  }

  // Sort by day then by start time
  parsed.sort((a, b) => {
    if (a.dayIndex !== b.dayIndex) return a.dayIndex - b.dayIndex;
    return a.startTime.localeCompare(b.startTime);
  });

  return {
    meta: {
      timetableId: active.id,
      academicYear: active.academicYear,
      semester: active.semester,
      updatedAt: active.publishedAt || new Date().toISOString(),
      count: parsed.length
    },
    entries: parsed
  };
}

// CLI runner
if (process.argv[1] && process.argv[1].endsWith('timetableScraper.js')) {
  fetchLevel300Timetable().then(({ meta, entries }) => {
    console.log(`\n=== Successfully parsed ${entries.length} Level 300 class sessions ===\n`);
    const byDay = {};
    for (const e of entries) {
      byDay[e.day] = byDay[e.day] || [];
      byDay[e.day].push(e);
    }

    for (const [day, list] of Object.entries(byDay)) {
      console.log(`\n--- ${day} (${list.length} classes) ---`);
      for (const c of list) {
        console.log(`• ${c.startTime} - ${c.endTime} | ${c.courseCode}: ${c.courseTitle}`);
        console.log(`   Auditorium/Venue: ${c.venue} | ${c.status}`);
        console.log(`   Lecturer: ${c.lecturer}\n`);
      }
    }

    fs.writeFileSync('timetable_level300.json', JSON.stringify({ meta, entries }, null, 2));
    console.log('[+] Saved complete timetable to timetable_level300.json');
  }).catch(console.error);
}
