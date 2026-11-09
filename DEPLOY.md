# Deploying to a Coolify VPS

Two containers, one shared volume: the Python scraper (Telegram + the hand-off queue) and the
Node/Baileys WhatsApp bot. Neither needs a domain or an open port — they are both worker
processes.

---

## Step 0 — the structural change you need first

**Coolify deploys from a git repository, and right now it cannot see this project.**

Only `Sakai-Assignment-Alerts/` is a git repo (`github.com/tiankay999/Sakai-Assignment-Alerts`).
`WhatsappBot/` and `docker-compose.yml` live *outside* it, in a plain folder. Point Coolify at the
existing repo today and it will find no compose file and no bot.

### Recommended: turn the workspace into one repo

Move the git directory up a level. Git's rename detection keeps the full history of `monitor.py`
and everything else — you lose nothing.

```bash
cd "/c/Users/admin/Desktop/Projects/Assignmnent ALERT"

mv Sakai-Assignment-Alerts/.git .git     # the repo now covers both services
git add -A
git status                               # expect renames, not deletes + adds
git commit -m "Restructure into a monorepo and add the WhatsApp bot layer"
git push origin main
```

`git status` should show entries like `renamed: monitor.py -> Sakai-Assignment-Alerts/monitor.py`.
If it shows deletions and separate additions instead, history is still intact — `git log --follow
Sakai-Assignment-Alerts/monitor.py` will prove it — but stop and check before pushing if anything
else looks off.

Afterwards the repo root holds `docker-compose.yml`, `.env.example`, `DEPLOY.md`, `LLMS.md`,
`Sakai-Assignment-Alerts/` and `WhatsappBot/`. Consider renaming the GitHub repo to something like
`assignmentdey` since it is no longer just the scraper.

### Alternative: two separate repos

Push `WhatsappBot/` as its own repo and create two Coolify resources. This works, but the two
containers must share a volume, and sharing a named volume between separate Coolify resources is
fiddly and easy to get wrong — if they do not end up on the same volume, the bot sees no alerts and
you get silence with no error. Take the monorepo unless you have a reason not to.

---

## Step 1 — create the Coolify resource

1. **Project → New Resource → Docker Compose**, "Based on a Git repository".
2. Pick the repo and the `main` branch.
3. **Build Pack:** `Docker Compose`.
4. **Docker Compose Location:** `/docker-compose.yml`.
5. **Do not assign a domain and do not set an exposed port.** Both services are workers with no
   HTTP listener; giving them a domain makes Coolify wait on a health check that will never pass
   and the deploy will look broken when it isn't.

## Step 2 — environment variables

Open the resource's **Environment Variables** tab and add the contents of
[`.env.example`](.env.example). You do not upload the file — Coolify injects these into the
containers, and [`docker-compose.yml`](docker-compose.yml) hands each one only to the service that
needs it.

Must be filled in:

| Variable | Service |
|---|---|
| `SAKAI_USER`, `SAKAI_PASS` | scraper |
| `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID` | scraper |
| `ACTIVE_TERM` | scraper — set it, or you will get alerts for old courses |
| `ADMIN_NUMBERS` | whatsapp |
| `GEMINI_API_KEY` | whatsapp — leave blank and the assistant just stays silent |

Everything else can stay at the defaults in `.env.example`. Blank optional values arrive as empty
strings and both services fall back to their built-in defaults.

Notes:

- Mark `SAKAI_PASS`, `TELEGRAM_TOKEN` and `GEMINI_API_KEY` as secret so they are masked in the UI.
- These are **runtime** variables, not build variables. Leave "Is Build Variable?" off.
- `SAKAI_PASS` and `TELEGRAM_TOKEN` are never passed to the WhatsApp container. That is
  deliberate — it is the container exposed to the internet and running an LLM over group
  messages, and it has no need for either.

## Step 3 — storage

`docker-compose.yml` declares a named volume, `assignmentdey_data`, mounted at `/data` in both
services. Coolify creates it on first deploy; check it appears under **Storages**.

Everything that must survive a redeploy lives there: `seen.json`, the Baileys session, the course
to group mapping, LLM usage counters and the hand-off queue.

## Step 4 — deploy and link the bot

```
Deploy → then open Logs and select the "whatsapp" service
```

Depending on `LOGIN_METHOD` you will see either a QR code or a block like:

```
  ===============================================
   PAIRING CODE:  ABCD-2345
  ===============================================
```

On the **bot's** phone (not yours): WhatsApp → Settings → Linked devices → Link a device, then
scan, or tap "Link with phone number instead" and type the code.

A pairing code expires after a few minutes; a fresh one is printed roughly every two minutes until
the link succeeds.

## Step 5 — first-run checks

From your personal number, DM the bot:

```
/id        -> confirms it sees your number as an admin
/status    -> should show "Last cycle: ok" once the scraper finishes a cycle
```

The scraper's first cycle runs immediately on boot, so `/status` is meaningful within a couple of
minutes. Then add the bot to each class group and map it:

```
/groups                            # lists groups, with IDs
/addgroup UGBS301 here Level300
/whereto UGBS 301                  # confirm routing before you rely on it
```

Telegram should keep working throughout — if it stops, that is a scraper problem, not a WhatsApp
one, and the scraper logs will say why.

---

## Things that will bite you

**Never delete the volume casually.** If `seen.json` is lost, every current assignment counts as
new on the next cycle and the bot will try to broadcast all of them at once. The send throttle
(3.5–9 s apart) stops that from looking like a flood, but on a busy semester it is still dozens of
messages. If you must wipe `/data`, run `/pause` first, let the scraper rebuild `seen.json` over
one cycle, then `/resume`.

**`baileys_auth/` is a credential.** Anyone with that directory has the bot's WhatsApp session.
It is on the volume, not in git — keep it that way.

**Timezone.** The digests fire at 08:00, 12:00 and 18:00 *container* local time, and containers
default to UTC. Ghana is UTC+0 all year, so this happens to be correct with no action. If you ever
move the VPS or the audience to another timezone, set `TZ` on the scraper service.

**Redeploys are safe.** Rebuilding either image leaves the volume alone, so you keep the session
and the state — no re-linking, no duplicate alerts.

**Resource use.** Node plus Baileys sits around 150–250 MB RSS; the Python scraper is well under
100 MB and idle most of the time. Any 1 GB VPS is fine.

**If the bot goes quiet but Telegram still works**, the queue is still being written — the bot
just is not draining it. Check `/status` for `PAUSED`, then the WhatsApp service logs for a
disconnect. Nothing is lost in the meantime; `outbox.jsonl` holds the backlog and delivery catches
up on reconnect.

---

## Validating locally first (optional but worth it)

```bash
cp .env.example .env            # fill it in
docker compose config           # prints the resolved config, catches typos
docker compose up -d --build
docker compose logs -f whatsapp
```

`docker compose config` is the quickest way to confirm every variable resolves before you push
anything to the VPS.
