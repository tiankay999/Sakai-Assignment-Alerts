"""
Sakai LMS Assignment & Quiz Monitor
Logs into the University of Ghana Sakai portal, scrapes enrolled courses for
new assignments and quizzes, and sends Telegram notifications when new items
are detected. Seen items are persisted in seen.json so duplicates are never
re-notified.
"""

import json
import os
import sys
import time
from datetime import datetime, date, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

load_dotenv()  # Read credentials from .env into environment variables

SAKAI_USER = os.getenv("SAKAI_USER")
SAKAI_PASS = os.getenv("SAKAI_PASS")
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

SAKAI_BASE = "https://sakai.ug.edu.gh"
LOGIN_URL = f"{SAKAI_BASE}/portal/xlogin"
SITE_LIST_URL = f"{SAKAI_BASE}/portal/sites"

# Local file that tracks which assignments/quizzes have already been seen.
# Format: {"ids": [...], "items": [{id, title, course, due_date, type}, ...]}
SEEN_FILE = Path("seen.json")

# Tracks the date the morning reminder was last sent (contains "YYYY-MM-DD")
REMINDER_FILE = Path("last_reminder_date.txt")

# Delay between HTTP requests to avoid hammering the server
REQUEST_DELAY = 1.0  # seconds


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def validate_env() -> None:
    """Abort early if any required environment variable is missing."""
    missing = [
        var for var in ("SAKAI_USER", "SAKAI_PASS", "TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID")
        if not os.getenv(var)
    ]
    if missing:
        print(f"[ERROR] Missing required environment variables: {', '.join(missing)}")
        print("Copy .env.example to .env and fill in your credentials.")
        sys.exit(1)


def load_seen() -> tuple[set, list[dict]]:
    """
    Load seen item IDs and their full metadata from seen.json.
    Returns (seen_ids: set[str], items: list[dict]).

    Handles the old flat-list format transparently so existing seen.json files
    are migrated without data loss (IDs preserved, metadata starts empty).
    """
    if not SEEN_FILE.exists():
        return set(), []
    with SEEN_FILE.open("r", encoding="utf-8") as f:
        data = json.load(f)
    # Old format was a plain list of ID strings
    if isinstance(data, list):
        return set(data), []
    return set(data.get("ids", [])), data.get("items", [])


def save_seen(seen_ids: set, items: list[dict]) -> None:
    """Persist seen item IDs and full item metadata to seen.json."""
    with SEEN_FILE.open("w", encoding="utf-8") as f:
        json.dump({"ids": sorted(seen_ids), "items": items}, f, indent=2)


# ---------------------------------------------------------------------------
# Sakai login
# ---------------------------------------------------------------------------

def sakai_login(session: requests.Session) -> bool:
    """
    Authenticate against Sakai using a form POST.
    Sakai uses a container-managed login form with fields 'eid' and 'pw'.
    Returns True on success, False otherwise.
    """
    print("[*] Fetching login page ...")
    try:
        # First GET to retrieve any hidden form fields / cookies
        resp = session.get(f"{SAKAI_BASE}/portal", timeout=10)
        resp.raise_for_status()
    except requests.RequestException as exc:
        print(f"[ERROR] Could not reach Sakai: {exc}")
        return False

    soup = BeautifulSoup(resp.text, "html.parser")

    # Build the POST payload; Sakai's login form uses 'eid' and 'pw'
    payload = {"eid": SAKAI_USER, "pw": SAKAI_PASS, "submit": "Login"}

    # Some Sakai versions include a hidden 'sakai_csrf_token'; include it if present
    csrf_input = soup.find("input", {"name": "sakai_csrf_token"})
    if csrf_input:
        payload["sakai_csrf_token"] = csrf_input.get("value", "")

    print("[*] Submitting login credentials ...")
    time.sleep(REQUEST_DELAY)
    try:
        resp = session.post(LOGIN_URL, data=payload, timeout=10, allow_redirects=True)
        resp.raise_for_status()
    except requests.RequestException as exc:
        print(f"[ERROR] Login POST failed: {exc}")
        return False

    # A successful login redirects to the portal dashboard; check for the
    # presence of a logout link as a reliable success indicator
    if "logout" in resp.text.lower() or "/portal/logout" in resp.url:
        print("[+] Login successful.")
        return True

    print("[ERROR] Login failed — check your SAKAI_USER / SAKAI_PASS in .env")
    return False


# ---------------------------------------------------------------------------
# Site discovery
# ---------------------------------------------------------------------------

def get_enrolled_sites(session: requests.Session) -> list[dict]:
    """
    Return a list of sites the user is enrolled in.
    Each entry is {'id': str, 'title': str, 'url': str}.

    Sakai exposes enrolled sites in the portal's left-hand sidebar as
    <a> links under the #sitesNav element (or similar), and also via the
    /portal/sites JSON endpoint.
    """
    print("[*] Fetching enrolled course list ...")
    time.sleep(REQUEST_DELAY)

    sites = []

    # Try the JSON site list endpoint first (more reliable)
    try:
        resp = session.get(SITE_LIST_URL, timeout=10, headers={"Accept": "application/json"})
        if resp.status_code == 200 and resp.headers.get("Content-Type", "").startswith("application/json"):
            data = resp.json()
            # Sakai returns {"site_collection": [...]} or a list directly
            site_list = data.get("site_collection", data) if isinstance(data, dict) else data
            for site in site_list:
                site_id = site.get("id") or site.get("siteId", "")
                title = site.get("title", "Unknown Course")
                url = f"{SAKAI_BASE}/portal/site/{site_id}"
                sites.append({"id": site_id, "title": title, "url": url})
            if sites:
                print(f"[+] Found {len(sites)} enrolled sites via JSON endpoint.")
                return sites
    except (requests.RequestException, ValueError):
        pass  # Fall through to HTML scraping

    # Fallback: scrape the portal HTML for site links
    try:
        resp = session.get(f"{SAKAI_BASE}/portal", timeout=10)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        # Sakai renders site tabs/links in elements with class 'fav-sites-entry'
        # or inside a nav with id 'sitesNav'. We cast a wide net.
        for link in soup.select("a[href*='/portal/site/']"):
            href = link.get("href", "")
            # Extract the site ID from the URL path segment after /portal/site/
            parts = href.split("/portal/site/")
            if len(parts) < 2:
                continue
            site_id = parts[1].split("/")[0].split("?")[0]
            title = link.get_text(strip=True) or site_id
            if site_id and not any(s["id"] == site_id for s in sites):
                sites.append({
                    "id": site_id,
                    "title": title,
                    "url": f"{SAKAI_BASE}/portal/site/{site_id}",
                })
    except requests.RequestException as exc:
        print(f"[WARN] Could not scrape portal for sites: {exc}")

    print(f"[+] Found {len(sites)} enrolled sites via HTML scraping.")
    return sites


# ---------------------------------------------------------------------------
# Scraping helpers
# ---------------------------------------------------------------------------

def _is_meaningful_title(text: str) -> bool:
    """
    Return True only if text looks like a real assignment/quiz name.
    Rejects: empty strings, purely numeric strings (row IDs like "10", "56"),
    single-character artifacts, and anything containing "@" (email addresses).
    """
    t = text.strip()
    return bool(t) and not t.isdigit() and len(t) > 1 and "@" not in t


def _extract_title_from_row(cells) -> str:
    """
    Walk every <td> in a row and return the text of the first <a> tag whose
    text is a meaningful title.

    Links are rejected when:
      - href starts with "mailto:" (email links appear in instructor columns)
      - href starts with "#" (in-page anchors used as row markers)
      - the link text fails _is_meaningful_title (numeric IDs, emails, etc.)

    Cells are visited left-to-right so the title column (typically the first
    non-ID column) wins over later columns that may hold instructor emails or
    action buttons.
    """
    for cell in cells:
        for link in cell.find_all("a"):
            href = link.get("href", "")
            if href.startswith("mailto:") or href.startswith("#"):
                continue
            text = link.get_text(strip=True)
            if _is_meaningful_title(text):
                return text
    return ""


def _extract_due_date_from_row(cells) -> str:
    """Return the first cell text that looks like a date, or empty string."""
    month_abbrevs = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    for cell in cells:
        text = cell.get_text(strip=True)
        has_month = any(m in text for m in month_abbrevs)
        has_separator = "/" in text or "-" in text
        if (has_month or has_separator) and any(c.isdigit() for c in text):
            return text
    return ""


# ---------------------------------------------------------------------------
# Assignment scraping
# ---------------------------------------------------------------------------

def scrape_assignments(session: requests.Session, site: dict) -> list[dict]:
    """
    Scrape the Assignments tool for a single Sakai site.
    Returns a list of dicts with keys: id, title, course, due_date, type.
    """
    assignments = []
    site_id = site["id"]
    course = site["title"]

    url = f"{SAKAI_BASE}/portal/site/{site_id}/tool-reset/sakai.assignment.grades"
    time.sleep(REQUEST_DELAY)

    try:
        resp = session.get(url, timeout=30)
        if resp.status_code != 200:
            return assignments
        soup = BeautifulSoup(resp.text, "html.parser")
    except requests.RequestException:
        return assignments

    # Prefer the 'listHier' table used by Sakai's assignment tool; fall back
    # to any table on the page if that class is absent.
    rows = soup.select("table.listHier tr") or soup.select("table tr")

    for row in rows:
        cells = row.find_all("td")
        if not cells:
            continue  # skip header rows (<th> only)

        # Walk all cells to find the real title link, skipping numeric IDs
        title = _extract_title_from_row(cells)
        if not title:
            continue

        due_date = _extract_due_date_from_row(cells)

        item_id = f"assignment::{site_id}::{title.lower().replace(' ', '_')}"
        assignments.append({
            "id": item_id,
            "title": title,
            "course": course,
            "due_date": due_date,
            "type": "Assignment",
        })

    return assignments


# ---------------------------------------------------------------------------
# Quiz scraping
# ---------------------------------------------------------------------------

def scrape_quizzes(session: requests.Session, site: dict) -> list[dict]:
    """
    Scrape the Tests & Quizzes (Samigo) tool for a single Sakai site.
    Returns a list of dicts with keys: id, title, course, due_date, type.
    """
    quizzes = []
    site_id = site["id"]
    course = site["title"]

    url = f"{SAKAI_BASE}/portal/site/{site_id}/tool-reset/sakai.samigo"
    time.sleep(REQUEST_DELAY)

    try:
        resp = session.get(url, timeout=30)
        if resp.status_code != 200:
            return quizzes
        soup = BeautifulSoup(resp.text, "html.parser")
    except requests.RequestException:
        return quizzes

    for row in soup.select("table tr"):
        cells = row.find_all("td")
        if not cells:
            continue

        title = _extract_title_from_row(cells)
        if not title:
            continue

        due_date = _extract_due_date_from_row(cells)

        item_id = f"quiz::{site_id}::{title.lower().replace(' ', '_')}"
        quizzes.append({
            "id": item_id,
            "title": title,
            "course": course,
            "due_date": due_date,
            "type": "Quiz",
        })

    return quizzes


# ---------------------------------------------------------------------------
# Telegram notification
# ---------------------------------------------------------------------------

def send_telegram(items: list[dict]) -> None:
    """
    Send a Telegram message for each newly detected assignment or quiz.
    Uses the Telegram Bot API sendMessage endpoint.
    """
    api_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"

    for item in items:
        due_line = f"\nDue: {item['due_date']}" if item.get("due_date") else ""
        text = (
            f"New {item['type']} Detected!\n"
            f"Course: {item['course']}\n"
            f"Title: {item['title']}"
            f"{due_line}"
        )
        payload = {
            "chat_id": TELEGRAM_CHAT_ID,
            "text": text,
            # MarkdownV2 requires heavy escaping; plain text is simpler and safer
            "parse_mode": "",
        }
        try:
            resp = requests.post(api_url, data=payload, timeout=15)
            if resp.status_code == 200:
                print(f"[+] Telegram notification sent: {item['title']}")
            else:
                print(f"[WARN] Telegram API returned {resp.status_code}: {resp.text[:200]}")
        except requests.RequestException as exc:
            print(f"[ERROR] Could not send Telegram message: {exc}")


# ---------------------------------------------------------------------------
# Morning reminder
# ---------------------------------------------------------------------------

# Sakai date formats to try in order, most specific first.
_DATE_FORMATS = [
    "%b %d, %Y %I:%M %p",   # Jan 15, 2026 11:59 PM
    "%b %d, %Y %I:%M%p",    # Jan 15, 2026 11:59PM
    "%B %d, %Y %I:%M %p",   # January 15, 2026 11:59 PM
    "%b %d, %Y",             # Jan 15, 2026
    "%B %d, %Y",             # January 15, 2026
    "%A, %d %B %Y",          # Monday, 26 May 2026
    "%d %B %Y %I:%M %p",     # 26 May 2026 11:59 PM
    "%d %B %Y",              # 26 May 2026
    "%d/%m/%Y",              # 26/05/2026
    "%Y-%m-%d",              # 2026-05-26
]


def parse_due_date(due_date_str: str) -> date | None:
    """
    Try every known Sakai date format and return a date object, or None if
    the string is empty or does not match any format.
    """
    if not due_date_str:
        return None
    cleaned = due_date_str.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(cleaned, fmt).date()
        except ValueError:
            continue
    return None


def _should_send_morning_reminder() -> bool:
    """
    Return True if the current time is in the 8:00–8:10 AM window and the
    reminder has not already been sent today.
    """
    now = datetime.now()
    if not (now.hour == 8 and now.minute < 10):
        return False
    today_str = now.strftime("%Y-%m-%d")
    if REMINDER_FILE.exists() and REMINDER_FILE.read_text().strip() == today_str:
        return False  # already sent this morning
    return True


def _mark_reminder_sent() -> None:
    """Record today's date so we don't send the reminder a second time."""
    REMINDER_FILE.write_text(datetime.now().strftime("%Y-%m-%d"), encoding="utf-8")


def _build_morning_message(items: list[dict]) -> str:
    """
    Build the morning summary text from the stored item list.
    Items whose due date has already passed are excluded.
    Items with no parseable due date are included with 'Due: Unknown'.
    """
    today = date.today()
    tomorrow = today + timedelta(days=1)

    pending = []
    for item in items:
        parsed = parse_due_date(item.get("due_date", ""))
        # Keep items with no date (unknown) and items not yet past their due date
        if parsed is None or parsed >= today:
            pending.append((item, parsed))

    if not pending:
        return "✅ Good morning! No pending assignments or quizzes. Enjoy your day!"

    lines = ["📅 Good morning! Here are your pending tasks:\n"]
    for item, parsed in pending:
        icon = "📝" if item.get("type") == "Assignment" else "🧪"
        lines.append(f"{icon} {item['type']}: {item['title']}")
        lines.append(f"   Course: {item['course']}")

        if parsed is None:
            due_label = "Unknown"
        elif parsed == today:
            due_label = "Today"
        elif parsed == tomorrow:
            due_label = "Tomorrow"
        else:
            due_label = parsed.strftime("%A, %d %b %Y")

        lines.append(f"   Due: {due_label}")
        lines.append("")  # blank line between items

    return "\n".join(lines).rstrip()


def send_morning_reminder(items: list[dict]) -> None:
    """Send the morning summary Telegram message and record that it was sent."""
    message = _build_morning_message(items)
    api_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    try:
        resp = requests.post(
            api_url,
            data={"chat_id": TELEGRAM_CHAT_ID, "text": message},
            timeout=15,
        )
        if resp.status_code == 200:
            print("[+] Morning reminder sent.")
            _mark_reminder_sent()
        else:
            print(f"[WARN] Morning reminder failed: {resp.status_code} {resp.text[:200]}")
    except requests.RequestException as exc:
        print(f"[ERROR] Could not send morning reminder: {exc}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

CHECK_INTERVAL = 600  # seconds between checks (10 minutes)


def check_once(
    session: requests.Session, seen: set, stored_items: list[dict]
) -> tuple[set, list[dict]]:
    """
    Run a single scrape cycle.
    Returns the updated (seen_ids, items) tuple.
    Never raises — errors are caught and logged so the loop keeps running.
    """
    if not sakai_login(session):
        print("[WARN] Login failed this cycle; will retry next interval.")
        return seen, stored_items

    sites = get_enrolled_sites(session)
    if not sites:
        print("[WARN] No enrolled sites found this cycle.")
        return seen, stored_items

    all_items: list[dict] = []
    for site in sites:
        print(f"[*] Checking site: {site['title']} ...")
        all_items.extend(scrape_assignments(session, site))
        all_items.extend(scrape_quizzes(session, site))

    print(f"[*] Total items found this run: {len(all_items)}")

    new_items = [item for item in all_items if item["id"] not in seen]
    print(f"[*] New items detected: {len(new_items)}")

    if new_items:
        send_telegram(new_items)
    else:
        print("[*] No new assignments or quizzes.")

    # Merge scraped items into the stored list so metadata (especially due
    # dates) stays fresh. Use a dict keyed by ID for O(1) upserts.
    items_by_id = {item["id"]: item for item in stored_items}
    for item in all_items:
        items_by_id[item["id"]] = item  # overwrite with latest metadata

    updated_items = list(items_by_id.values())
    seen.update(item["id"] for item in all_items)
    save_seen(seen, updated_items)
    print(f"[*] seen.json updated ({len(seen)} total items tracked).")
    return seen, updated_items


def main() -> None:
    validate_env()

    seen, stored_items = load_seen()
    print(f"[*] Loaded {len(seen)} previously seen items from {SEEN_FILE}.")

    session = requests.Session()
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0 Safari/537.36"
        )
    })

    print(f"[*] Starting monitor — checking every {CHECK_INTERVAL // 60} minutes. Press Ctrl+C to stop.")

    while True:
        print(f"\n[*] Running check at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ...")
        try:
            # Morning reminder runs before the scrape so it uses stored data
            # immediately at 8 AM without waiting for a full scrape cycle.
            if _should_send_morning_reminder():
                print("[*] 8 AM window detected — sending morning reminder ...")
                send_morning_reminder(stored_items)

            seen, stored_items = check_once(session, seen, stored_items)
        except Exception as exc:
            print(f"[ERROR] Unexpected error during check: {exc}")

        print(f"[*] Next check in {CHECK_INTERVAL // 60} minutes ...")
        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
