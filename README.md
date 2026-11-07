# Sakai LMS Assignment Monitor

Monitors the University of Ghana's Sakai LMS for new assignments, quizzes, announcements, and resources, and sends you a Telegram notification the moment one is detected.

---

## How it works

1. Logs into `sakai.ug.edu.gh` using your student credentials.
2. Discovers all courses you are enrolled in (filtered by `ACTIVE_TERM` if provided).
3. Scrapes each course's **Assignments**, **Tests & Quizzes**, **Announcements**, and **Resources**.
4. Compares the results against `seen.json` (created automatically on the first run).
5. Sends a Telegram message for every new item found.
6. Updates `seen.json` so you are never notified about the same item twice.

---

## Prerequisites
- Clone the project(git clone + url of repository  (inside your terminal (inside your IDE terminal)))
- Python 3.10 or newer
- A Telegram bot and your chat ID (see below)

---

## Setup

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Create your `.env` file

Copy the example file and fill in your real credentials:

```bash
cp .env.example .env
```

Open `.env` and set:

| Variable | Description |
|---|---|
| `SAKAI_USER` | Your UG student ID (e.g. `10XXXXXXX`) |
| `SAKAI_PASS` | Your Sakai password |
| `TELEGRAM_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your personal chat ID (from @userinfobot) |
| `ACTIVE_TERM` | **Optional but recommended.** Your current academic term (e.g., `S1-2526` or `2526`). Only courses with this term in their title will be checked, blocking spam from old first-year courses. |

**Never commit `.env` to git** — it is already listed in `.gitignore`.

### 3. Create a Telegram bot (first time only)

1. Open Telegram and search for **@BotFather**.
2. Send `/newbot` and follow the prompts to get a **Bot Token**.
3. Search for **@userinfobot** and send `/start` to get your **Chat ID**.
4. Start a conversation with your new bot (search it by name and press Start)
   so it has permission to message you.

---

## Running the monitor Locally

```bash
python monitor.py
```

The script runs continuously, rechecking Sakai every **2 hours** (and every 4th cycle it checks after **1 hour**). Press `Ctrl+C` to stop it. Leave it running in a terminal (or background process) and it will notify you automatically whenever a new item appears.

### Running in the background (Windows)
```powershell
Start-Process python -ArgumentList "monitor.py" -WorkingDirectory "C:\path\to\AssignmentDey" -WindowStyle Hidden
```

### Running in the background (Linux/macOS)
```bash
nohup python monitor.py >> monitor.log 2>&1 &
```

---

## Cloud Deployment (24/7 Hosting)

To keep the bot running 24/7 without keeping your computer on, you can deploy it to a cloud provider for free or very cheap. Note: Before deploying, ensure you add an empty `Procfile` if required by the hosting service, or simply specify the start command.

### Option 1: Render (Recommended for Beginners)
1. Push your code to a GitHub repository.
2. Go to [Render](https://render.com/) and sign up.
3. Click **New +** and select **Background Worker**.
4. Connect your GitHub account and select your repository.
5. Set the Start Command to: `python monitor.py`
6. Under **Environment Variables**, add all the variables from your `.env` file (`SAKAI_USER`, `SAKAI_PASS`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `ACTIVE_TERM`).
7. Click **Create Worker**. Render will build and run your bot!

### Option 2: Railway
1. Push your code to a GitHub repository.
2. Go to [Railway](https://railway.app/) and log in.
3. Click **New Project** -> **Deploy from GitHub repo**.
4. Select your repository.
5. Once deployed, click on the project, go to the **Variables** tab.
6. Add all the variables from your `.env` file.
7. Railway will automatically restart and your bot will be live.

### Option 3: Heroku
1. Push your code to a GitHub repository.
2. Go to [Heroku](https://heroku.com/) and create a new app.
3. Under the **Deploy** tab, connect your GitHub repository and enable Automatic Deploys.
4. Go to the **Settings** tab -> **Reveal Config Vars**.
5. Add all your `.env` variables here (Key: `SAKAI_USER`, Value: `your_id`, etc.).
6. Go to the **Resources** tab, and toggle on the worker dyno (`python monitor.py`) and turn off the web dyno.
7. Your bot is now running!

---

## File structure

```
AssignmentDey/
├── monitor.py        # Main monitoring script
├── requirements.txt  # Python dependencies
├── .env.example      # Template — copy to .env and fill in credentials
├── .env              # Your real credentials (git-ignored)
├── seen.json         # Auto-generated; tracks already-notified items
└── README.md         # This file
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| *Login failed* | Double-check `SAKAI_USER` / `SAKAI_PASS` in `.env`. |
| *No sites found* | Log in manually in a browser to confirm your account has enrolled courses. |
| *Old assignments/resources appearing* | Set the `ACTIVE_TERM` in your `.env` file to your current semester (e.g. `S1-2526`) to completely block old courses. |
| *Telegram message not received* | Verify the token and chat ID; make sure you started a conversation with the bot. |
| *Items re-notified every run* | Check that `seen.json` is being written correctly (disk permissions). |
---

## WhatsApp channel (optional)

Telegram keeps working exactly as described above. A WhatsApp bot can run **alongside** it,
broadcasting the same alerts to class groups and answering questions in those groups.

The scraper is unchanged as the source of truth. It now also appends every alert and every
8AM/12PM/6PM digest to `$DATA_DIR/outbox.jsonl`, and writes a heartbeat to
`$DATA_DIR/scraper_status.json`. A separate Node service tails that file and delivers the
messages. If the WhatsApp side is not running, the file simply grows and delivery catches up
later — nothing about Telegram changes, and nothing is lost.

```bash
# from the workspace root (one level up), runs scraper + bot on a shared /data volume
docker compose up -d --build
docker compose logs -f whatsapp   # scan the QR shown here with the BOT's number, once
```

Setup, the full command list and the group mapping guide are in
[`../WhatsappBot/README.md`](../WhatsappBot/README.md).

Two things worth repeating:

- **Use a dedicated second number for the bot, never your personal one.** Automated WhatsApp
  accounts carry a real ban risk.
- **No per-student Sakai credentials, ever.** The bot still logs in as your single account and
  broadcasts course-level items shared with the whole class. Group members are identified by
  WhatsApp number only.
