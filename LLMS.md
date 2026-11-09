# Sakai LMS Assignment & Announcement Alerts — Workspace LLM Context

This workspace contains two services that run side by side on one shared `/data` volume:

| Directory | Runtime | Role |
|---|---|---|
| `Sakai-Assignment-Alerts/` | Python 3.10+ | Scrapes Sakai, sends Telegram alerts, writes the WhatsApp hand-off queue. **Source of truth.** |
| `WhatsappBot/` | Node.js 20+ | Baileys WhatsApp broadcasting, admin commands, Gemini Flash group assistant. |
| `docker-compose.yml` | — | Runs both, sharing the `assignmentdey_data` volume. |

For complete architectural specifications, system diagrams, scraper mechanics, data schemas, the
`outbox.jsonl` bridge contract and coding guidelines for LLMs, refer directly to:
👉 [**`Sakai-Assignment-Alerts/LLMS.md`**](Sakai-Assignment-Alerts/LLMS.md)
and [**`WhatsappBot/README.md`**](WhatsappBot/README.md)

---

## Quick Summary

- **Project:** Automated scraper and multi-channel notifier for University of Ghana Sakai LMS (`https://sakai.ug.edu.gh`).
- **Core Script:** [`Sakai-Assignment-Alerts/monitor.py`](Sakai-Assignment-Alerts/monitor.py)
- **Dependencies:** Python — `requests`, `beautifulsoup4`, `python-dotenv`. Node — `@whiskeysockets/baileys`, `pino`, `qrcode-terminal`, `dotenv`.
- **Primary Features:**
  - Automated session login & CSRF handling.
  - Course site discovery with academic term filtering (`ACTIVE_TERM`).
  - Scrapes Assignments (REST API + HTML), Tests & Quizzes, Announcements, and Resources.
  - Deduplication & persistence via `seen.json`, `reminder_state.json`, and `deployment_ts.txt`.
  - Immediate Telegram alerts for new items.
  - WhatsApp broadcasting of the same items to the class groups mapped to each course.
  - Daily deadline digest reminders at 8:00 AM, 12:00 PM, and 6:00 PM on both channels.
  - 2-hour polling interval with 1-hour fast cycle every 4th iteration.
  - Trigger-based Gemini Flash assistant in WhatsApp groups, grounded on scraped state, with
    per-user rate limits and a hard monthly token/cost cap.
- **Docker Support:** `docker compose up -d --build` from this directory.

---

## Hard constraints (do not "optimise" these away)

- **One Sakai account only — the owner's.** The scraper broadcasts course-level items shared with
  a whole class. No other student's Sakai ID, PIN or password is ever collected, stored or logged.
  There is no per-user login; WhatsApp subscribers are identified by their number alone.
- **The Node service never scrapes Sakai.** It reads `outbox.jsonl` and `seen.json`. Scraping,
  dedup and scheduling live in `monitor.py` and nowhere else.
- **The assistant is never always-on** — @mention, reply, or `/ask` only.
- **All automated WhatsApp sends are throttled** with randomised delays, and the only advertising
  surface is a single sponsor line appended to a digest.
- **The WhatsApp bot runs on a dedicated second number**, never a personal one.
