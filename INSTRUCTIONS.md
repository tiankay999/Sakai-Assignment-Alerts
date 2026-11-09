# 📱 UG Sakai & DCIT Level 300 Timetable Bot — User Guide

A comprehensive guide for administering and using the **UG Sakai Assignment Alerts & Level 300 DCIT Timetable WhatsApp Bot**.

---

## 📑 Table of Contents
1. [Overview](#1-overview)
2. [Environment Configuration Reference](#2-environment-configuration-reference)
3. [Sakai Course Setup & Troubleshooting](#3-sakai-course-setup--troubleshooting)
4. [Automated Alerts (Sakai & Timetable)](#4-automated-alerts-sakai--timetable)
5. [WhatsApp Command Reference](#5-whatsapp-command-reference)
   - [Public Student Commands](#public-student-commands)
   - [Admin Commands](#admin-commands)
6. [Step-by-Step Usage Examples](#6-step-by-step-usage-examples)
   - [Example A: Mapping Courses to WhatsApp Groups](#example-a-mapping-courses-to-whatsapp-groups)
   - [Example B: Timetable & Class Reminders](#example-b-timetable--class-reminders)
   - [Example C: Asking the AI Study Assistant](#example-c-asking-the-ai-study-assistant)
   - [Example D: Broadcasting Messages](#example-d-broadcasting-messages)
   - [Example E: Excluding Unwanted Courses](#example-e-excluding-unwanted-courses)

---

## 1. Overview

The system consists of two collaborating services running in Docker via Coolify:
1. **Sakai Scraper (`monitor.py`)**:
   - Periodically logs into `sakai.ug.edu.gh`.
   - Scrapes assignments, quizzes, announcements, and resources for your enrolled courses.
   - Pushes urgent alerts to Telegram and queues records into `outbox.jsonl` for WhatsApp.
2. **WhatsApp Bot (`WhatsappBot`)**:
   - Monitors `outbox.jsonl` and broadcasts assignment alerts to the appropriate group chats.
   - Automatically dispatches class reminders according to the **Level 300 DCIT Timetable** (1 hr before, 30 mins before, class begins).
   - Answers student course questions via an integrated LLM (Groq / Gemini).
   - Provides commands like `/today`, `/nextclass`, `/timetable`, `/deadlines`, and `/groups`.

---

## 2. Environment Configuration Reference

These environment variables are set in your **Coolify Environment Variables** tab:

| Variable | Description | Recommended Value |
| :--- | :--- | :--- |
| `SAKAI_USER` | Your student ID for Sakai login | `10xxxxxx` |
| `SAKAI_PASS` | Your Sakai PIN/password | `••••••••` |
| `ACTIVE_TERM` | Filter to track current semester courses | `2627, 26/27, 2026/2027, DCIT 3, DCIT3` |
| `EXCLUDE_COURSES` | Skip unwanted or past courses (e.g. CBAS) | `CBAS 210, CBAS, Overview` |
| `ADMIN_NUMBERS` | WhatsApp digits with country code allowed to run admin commands | `233598741552, 184971943780504` |
| `LOGIN_METHOD` | How WhatsApp connects (`qr` or `pairing`) | `qr` |
| `GROQ_API_KEY` | Free LLM API key from [console.groq.com](https://console.groq.com) | `gsk_••••••••••••` |
| `LLM_MODEL` | AI model name on Groq | `llama-3.1-8b-instant` or `qwen/qwen3.8-27b` |

---

## 3. Sakai Course Setup & Troubleshooting

### Star / Pin Your Courses
If your newly registered courses do not show up:
1. Log into [sakai.ug.edu.gh](https://sakai.ug.edu.gh).
2. Click the **"Sites"** grid icon (top-right of the navigation bar).
3. Find your current Level 300 courses (e.g., `DCIT 301`, `DCIT 303`, `DCIT 313`, etc.).
4. Click the **⭐ star** icon next to each course so it becomes yellow/pinned.

### Why `CBAS 210` Appeared & How to Remove It
If you took `CBAS 210` in a previous year, the department may have created the new semester site as `CBAS 210 1 S1-2627` (or `Overview (ID: CBAS-210-1-S1-2627)`).
* To drop it, set:
  ```ini
  EXCLUDE_COURSES=CBAS 210, CBAS, Overview
  ```
  The scraper will skip it and only track your 7 active DCIT courses.

---

## 4. Automated Alerts (Sakai & Timetable)

### A. Class Timetable Reminders (Automatic)
The bot tracks the **DCS Level 300 DCIT Timetable** and sends these alerts automatically:
* **7:00 AM Daily Schedule**: Full rundown of today's classes with venues and lecturers (or a *"🌴 No Classes Today!"* message on weekends and free days).
* **1 Hour Before Class**: Alert with course code, title, venue, and lecturer.
* **30 Minutes Before Class**: Quick reminder that class starts in 30 minutes.
* **Class Begins Now**: Notifies that class is starting, plus previews the **Next Class of the Day**.

### B. Sakai Assignment & Quiz Alerts (Automatic)
* **Instant Alert**: When a lecturer posts a new assignment or quiz.
* **Morning & Evening Digests**: Summary sent at 8:00 AM, 12:00 PM, and 6:00 PM for upcoming deadlines.

---

## 5. WhatsApp Command Reference

### Public Student Commands
Any student in a mapped group or DM can use these commands:

| Command | Description | Example |
| :--- | :--- | :--- |
| `/today` or `/classes` | Today's DCIT class schedule, times, and venues | `/today` |
| `/nextclass` | Shows the upcoming DCIT class today | `/nextclass` |
| `/timetable [day]` | Shows weekly DCIT schedule (or filter by day) | `/timetable mon` or `/timetable` |
| `/deadlines` | Lists all upcoming Sakai assignments & quizzes | `/deadlines` |
| `/ask <question>` | Ask the AI assistant course/study questions | `/ask summarize subnetting in computer networks` |
| `/help` | Displays command overview | `/help` |
| `/id` | Displays your sender ID and current chat ID | `/id` |

---

### Admin Commands
*(Requires sender number in `ADMIN_NUMBERS`)*

| Command | Description | Example |
| :--- | :--- | :--- |
| `/groups` | Lists groups the bot is in and active course mappings | `/groups` |
| `/addgroup <course> <here\|id> [label]` | Maps a course to the current group | `/addgroup DCIT301 here Level 300 OS Group` |
| `/removegroup <course> <here\|id>` | Removes course mapping from a group | `/removegroup DCIT301 here` |
| `/sync_timetable` | Re-fetches the live timetable from DCS PMS API | `/sync_timetable` |
| `/broadcast <group\|all> <msg>` | Sends an announcement to mapped groups | `/broadcast all Reminder: Class today is online!` |
| `/status` | Health check: scraper status, tokens, queue | `/status` |
| `/mute <number>` | Blocks an abusive student from using `/ask` | `/mute 233240000000` |
| `/unmute <number>` | Unblocks a student | `/unmute 233240000000` |
| `/pause` / `/resume` | Pauses or resumes alert broadcasts | `/pause` |

---

## 6. Step-by-Step Usage Examples

### Example A: Mapping Courses to WhatsApp Groups
When the bot is added to a WhatsApp course group:
1. In the WhatsApp group, an admin types:
   ```text
   /addgroup DCIT301 here DCIT 301 Main Group
   ```
2. The bot responds:
   ```text
   Mapped DCIT301 to DCIT 301 Main Group.
   ```
3. Now, whenever an assignment, announcement, or class alert for **DCIT 301** is triggered, it is sent directly into that group!

To map multiple courses to a single general departmental group:
```text
/addgroup DCIT301 here Level 300 IT
/addgroup DCIT303 here Level 300 IT
/addgroup DCIT313 here Level 300 IT
```

---

### Example B: Timetable & Class Reminders

#### Check Today's Classes:
**User:**
```text
/today
```
**Bot:**
```text
📅 Level 300 Schedule for Today (THU)
Total classes: 3

⏰ 07:30 - 08:30 | DCIT 303
   📖 Computer Networks
   🏛️ Venue: NNB1 (Core (CS & IT))
   👨‍🏫 Lecturer: Mr. Julius Ludu

⏰ 13:30 - 15:30 | DCIT 321
   📖 Software Evolution
   🏛️ Venue: N3 (Elective (IT))
   👨‍🏫 Lecturer: Prof. Solomon Mensah

⏰ 15:30 - 17:30 | DCIT 301
   📖 Operating System
   🏛️ Venue: NNB3 (Core (CS & IT))
   👨‍🏫 Lecturer: Mr. Benjamin Wiredu
```

#### Check Next Class:
**User:**
```text
/nextclass
```
**Bot:**
```text
⏰ Next Class Today
📚 Course: DCIT 321 - Software Evolution
🏛️ Venue: N3 (Elective (IT))
⏰ Time: 13:30 - 15:30
👨‍🏫 Lecturer: Prof. Solomon Mensah
```

#### Automatic Beginning Alert:
```text
🔔 Class Begins Now!

📚 Course: DCIT 303 - Computer Networks
🏛️ Auditorium/Venue: NNB1
⏰ Time: 07:30 - 08:30
👨‍🏫 Lecturer: Mr. Julius Ludu

➡️ Next Class Today: DCIT 321 at 13:30 in N3
```

---

### Example C: Asking the AI Study Assistant
Students can ask academic questions using `/ask`, by @mentioning the bot, or by quoting/replying to a bot message:

**Student:**
```text
/ask What is the difference between a process and a thread in DCIT 301?
```
**Bot:**
```text
In Operating Systems (DCIT 301):

• Process: An executing program with its own dedicated memory address space, file handles, and resources. Context switching between processes has high overhead.
• Thread: The smallest unit of execution within a process (often called a lightweight process). Threads in the same process share the same memory space and code section, making thread switching and communication much faster.
```

---

### Example D: Broadcasting Messages
To broadcast an urgent message to all mapped groups:
**Admin:**
```text
/broadcast all 📢 Important: The DCIT 301 lecture tomorrow at 13:30 will be held via Zoom. Check Sakai for the link!
```
**Bot:**
```text
Sent to 3 of 3 group(s).
```

---

### Example E: Excluding Unwanted Courses
If you see old courses like `CBAS 210` in Coolify logs:
1. Open Coolify ➔ Your Resource ➔ **Environment Variables**.
2. Add or update:
   ```ini
   EXCLUDE_COURSES=CBAS 210, CBAS, Overview
   ```
3. Click **Save** and **Redeploy**.
4. The scraper will ignore `CBAS` and monitor only your active DCIT courses.
