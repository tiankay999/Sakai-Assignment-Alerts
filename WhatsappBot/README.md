# WhatsApp bot layer (Baileys + Gemini Flash)

A WhatsApp channel **alongside** the existing Telegram alerts, not a replacement.

The Python scraper (`../Sakai-Assignment-Alerts/monitor.py`) stays the source of truth: it logs
into Sakai, scrapes, deduplicates and schedules exactly as before, and still sends every Telegram
message it always did. It now also appends each alert and each daily digest to
`$DATA_DIR/outbox.jsonl`. This Node service tails that file and delivers the messages to the
WhatsApp groups mapped to each course, and answers questions in those groups when it is addressed.

### Privacy, by design

The bot logs into Sakai **as one account only** — the owner's — through the Python scraper.
It broadcasts course-level items (assignments, quizzes, announcements, resources) that are shared
with the whole class. There is no per-student login, and no other student's Sakai ID, PIN or
password is ever requested, stored or logged. Group members are identified by WhatsApp number
alone. The assistant is instructed to refuse credentials if anyone offers them.

---

## 1. Prerequisites

- **A dedicated second WhatsApp number for the bot.** Never link your personal number — an
  automated account carries a real ban risk, and you do not want that risk on your own line.
- Node.js 20+ (or just Docker).
- A Gemini API key from Google AI Studio, if you want the in-group assistant.

## 2. Configuration

```bash
cp .env.example .env
```

The settings that matter most:

| Variable | What it does |
|---|---|
| `DATA_DIR` | Shared volume with the scraper. **Must match the scraper's `DATA_DIR`** (`/data` in Docker). |
| `ADMIN_NUMBERS` | Comma-separated admin numbers, digits with country code, e.g. `233200000000`. Only these can run commands. |
| `LOGIN_METHOD` | `qr` (default) or `pairing` — see below. |
| `BOT_NUMBER` | Required for `pairing`: the bot's own number, digits with country code, no `+`. |
| `GEMINI_API_KEY` | Enables the assistant. Leave empty and the bot stays silent instead of answering. |
| `GEMINI_MODEL` | Defaults to `gemini-2.5-flash`. |
| `LLM_RATE_LIMIT` / `LLM_RATE_WINDOW_MINUTES` | Per-user limit, default 5 questions per hour. |
| `LLM_MONTHLY_CAP` | Hard monthly token ceiling. The assistant stops answering when it is reached; alerts keep working. |
| `LLM_MONTHLY_COST_CAP` | Optional USD ceiling, estimated from the price variables. Whichever cap trips first wins. |
| `SEND_MIN_DELAY_MS` / `SEND_MAX_DELAY_MS` | Randomised gap between automated sends. **Do not set these to zero** — bursts are what get numbers flagged. |

Secrets live in `.env` only. Nothing is hardcoded, and the bot never echoes its own configuration
into a chat.

## 3. Link the bot number

Two ways, both one-time. Start the service and watch the logs:

```bash
# from the workspace root
docker compose up -d --build
docker compose logs -f whatsapp
```

Running without Docker instead:

```bash
npm install
npm start
```

### Option A — QR code (`LOGIN_METHOD=qr`, the default)

A QR code is printed in the logs. On the **bot's phone**: WhatsApp → Settings → Linked devices →
Link a device → scan it.

### Option B — pairing code (`LOGIN_METHOD=pairing`)

Easier when the server is remote and the phone is with you, since there is no screen to point a
camera at. Set both values in `.env`:

```env
LOGIN_METHOD=pairing
BOT_NUMBER=233200000000     # the BOT's number, digits only, no "+"
```

The logs then print a block like:

```
  ===============================================
   PAIRING CODE:  ABCD-2345
  ===============================================
```

On the **bot's phone**: WhatsApp → Settings → Linked devices → Link a device →
**"Link with phone number instead"** → type the code.

Notes:

- `BOT_NUMBER` must be the bot's own number in international format with no `+`, spaces or
  leading zeros — e.g. `233200000000`, not `+233 20 000 0000` or `020 000 0000`.
- The code expires after a few minutes. A fresh one is issued automatically about every two
  minutes until the link succeeds, so just watch the logs for the newest block.
- `PAIRING_CODE` can pin a specific 8-character code (A–Z, 2–9) instead of a random one.
- If the request fails for any reason, the service falls back to printing a QR code rather than
  leaving you stuck.

### Either way

The auth state is written to `$DATA_DIR/baileys_auth`, so restarts and rebuilds do **not** need
re-linking as long as the volume survives. If the bot is logged out from the phone, delete that
directory and restart to link again.

## 4. Set yourself up as admin

From your personal number, send the bot a direct message:

```
/id
```

It replies with the identifiers it sees for you. Put that number in `ADMIN_NUMBERS` and restart.
(WhatsApp is migrating to opaque "LID" identifiers; `/id` shows exactly what this bot matches on,
so you never have to guess.)

## 5. Map courses to groups

Add the bot number to each class group, then from inside a group:

```
/groups                         # lists groups I am in, with their IDs
/addgroup UGBS301 here Level300 # map a course to this group, with a label
/whereto UGBS 301               # check where that course's alerts would go
```

- The course key is matched against the code derived from the Sakai course title (`UGBS301`),
  or as a substring of that title — so `/addgroup DCIT305 here` catches
  "DCIT 305 : Software Engineering S1-2526".
- One course can map to several groups, and one group can carry several courses.
- `/addgroup * here` maps **every** course to that group.
- Mappings live in `$DATA_DIR/groups.json` and survive restarts.

## 6. Commands

Everyone:

| Command | Does |
|---|---|
| `/ask <question>` | Ask the study assistant |
| `/deadlines` | Outstanding assignments and quizzes, straight from the scraper (no AI tokens spent) |
| `/help` | Command list |

Admins only — anyone else running these gets **no reply at all**, just a counter bump:

| Command | Does |
|---|---|
| `/status` | Scraper heartbeat, group mapping, send queue, token usage and cost |
| `/id` | Identifiers for this chat and sender |
| `/groups` | Groups the bot is in, the course mapping, and the courses the scraper sees |
| `/addgroup <course> <groupId\|here> [label]` | Map a course to a group |
| `/removegroup <course> <groupId\|here>` | Unmap |
| `/setlabel <groupId\|here> <label>` | Name a group for readable output |
| `/broadcast <group\|all\|here> <message>` | Send a message to a group (throttled like any automated send) |
| `/ad <group\|all> <message>` | Set the sponsor line appended to that group's digest |
| `/ad clear <group\|all>` | Remove it |
| `/mute <number>` / `/unmute <number>` | Block a user from invoking the assistant |
| `/pause` / `/resume` | Stop or restart broadcasting |
| `/whereto <course>` | Show which groups a course's alerts would reach |

## 7. The assistant

It is **trigger-based, never always-on.** It replies only when it is:

- `@mentioned` in a group, or
- replied to, or
- addressed with `/ask ...`

Every other message in the group is ignored outright.

Guardrails:

- **Per-user rate limit** — 5 questions per hour by default.
- **Hard monthly token cap**, plus an optional cost cap. When either trips, the bot posts one
  short notice and stops answering until the month rolls over. Alerts and digests are unaffected.
- **Muted users get silence**, not an explanation.
- **Short context** — the last few turns per chat, held in memory only and never written to disk.
- **Grounded answers** — deadlines come from the scraper's `seen.json`. The model is told never to
  invent a date, and to say it has not seen something rather than guess.
- When a question names a course or asks about past questions, the reply carries a line pointing
  to QuestionsDey (`QUESTIONSDEY_URL`).

`/deadlines` answers the most common question deterministically, with no API call at all.

## 8. Sponsors

A single sponsor line can be appended to a group's daily digest, set with `/ad` or by editing
`$DATA_DIR/sponsors.json`. That is the only place an ad appears — there is deliberately **no**
standalone ad broadcast. A per-group line overrides the global one.

## 9. Anti-ban behaviour

- Every automated message goes through one serial queue with a randomised 3.5–9 s gap.
- The bot presents as a passive linked device (`markOnlineOnConnect: false`, no history sync).
- Groups with nothing outstanding are skipped at digest time rather than sent "nothing due" three
  times a day.
- `/pause` halts all broadcasting instantly; queued alerts stay in `outbox.jsonl` and go out on
  `/resume`.

## 10. How the bridge works

`$DATA_DIR/outbox.jsonl` is append-only, one JSON record per line, written by Python and read by
Node:

```json
{"v":1,"kind":"alert","event_id":"alert:assignment::SITE::title","queued_at":"...","item":{...}}
{"v":1,"kind":"digest","event_id":"digest:8am:2026-11-07","window":"8am","greeting":"...","items":[...]}
```

**Why a watched file rather than HTTP or SQLite:** both processes already share the `/data`
volume, so there is no port, no shared secret and no network path to secure. The file survives the
Node service being down, restarted or rebuilt — the scraper keeps writing and delivery catches up,
where an HTTP endpoint would silently drop every alert during downtime. And it needs no schema,
no locking and no extra dependency; SQLite would add a native module and writer-lock contention
for a few dozen records a day.

Delivery is tracked by a byte offset plus a set of delivered event IDs in
`$DATA_DIR/outbox_cursor.json`. The offset only advances once every send for a record has been
attempted, so a crash replays the record instead of losing it, and the event-ID set makes that
replay a no-op if it had already gone out. The scraper rotates the file past ~2 MB; the reader
detects the shrink and restarts cleanly.

## 11. Files on the volume

| File | Owner | Contents |
|---|---|---|
| `outbox.jsonl` | Python | The hand-off queue |
| `seen.json`, `reminder_state.json`, `deployment_ts.txt` | Python | Existing scraper state |
| `scraper_status.json` | Python | Heartbeat for `/status` |
| `baileys_auth/` | Node | WhatsApp session — **treat as a credential** |
| `groups.json` | Node | Course → group mapping |
| `sponsors.json` | Node | Sponsor lines |
| `moderation.json` | Node | Mute list |
| `llm_usage.json` | Node | Monthly tokens, cost, per-user rate windows |
| `bot_state.json` | Node | Pause switch and counters |
| `outbox_cursor.json` | Node | Read offset and delivered event IDs |

No message bodies are ever written to any of these.

## 12. Troubleshooting

| Symptom | Cause |
|---|---|
| No QR in the logs | Already linked. Delete `$DATA_DIR/baileys_auth` to force a re-link. |
| "no group mapped for this course" warning | Run `/addgroup` for that course — alerts are dropped, not queued, when nothing is mapped. |
| Alerts in Telegram but not WhatsApp | Check `/status` for paused state, then that both containers share the same `DATA_DIR`. |
| Assistant silent on @mention | No `GEMINI_API_KEY`, the user is muted, or the monthly cap has tripped — `/status` shows which. |
| Commands ignored | Your number is not in `ADMIN_NUMBERS`. Send `/id` to see what the bot sees. |
