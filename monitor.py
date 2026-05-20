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

# Local file that tracks which assignments/quizzes have already been seen
SEEN_FILE = Path("seen.json")

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


def load_seen() -> set:
    """Load the set of already-seen item IDs from seen.json."""
    if SEEN_FILE.exists():
        with SEEN_FILE.open("r", encoding="utf-8") as f:
            return set(json.load(f))
    return set()


def save_seen(seen: set) -> None:
    """Persist the set of seen item IDs to seen.json."""
    with SEEN_FILE.open("w", encoding="utf-8") as f:
        json.dump(sorted(seen), f, indent=2)


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

    # Sakai's Assignment tool URL for a site
    url = f"{SAKAI_BASE}/portal/site/{site_id}/tool-reset/sakai.assignment.grades"
    time.sleep(REQUEST_DELAY)

    try:
        resp = session.get(url, timeout=30)
        if resp.status_code != 200:
            return assignments
        soup = BeautifulSoup(resp.text, "html.parser")
    except requests.RequestException:
        return assignments

    # Sakai assignment rows are typically in a table with class 'listHier'
    # Each row contains the title and due date in labelled cells
    for row in soup.select("table.listHier tr, table tr"):
        cells = row.find_all("td")
        if not cells:
            continue

        # The assignment title is usually in the first or second cell as a link
        title_cell = cells[0] if cells else None
        title_link = title_cell.find("a") if title_cell else None
        title = title_link.get_text(strip=True) if title_link else ""
        if not title:
            # Some themes put the title text directly in the first cell
            title = title_cell.get_text(strip=True) if title_cell else ""
        if not title:
            continue

        # Look for a due-date cell — Sakai often labels it or it's the 3rd/4th column
        due_date = ""
        for cell in cells[1:]:
            text = cell.get_text(strip=True)
            # Heuristic: due date cells contain month abbreviations or date separators
            if any(m in text for m in ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
                                        "/", "-")) and any(c.isdigit() for c in text):
                due_date = text
                break

        # Build a stable unique ID: site_id + normalised title
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

    # Sakai's Samigo (Tests & Quizzes) tool URL
    url = f"{SAKAI_BASE}/portal/site/{site_id}/tool-reset/sakai.samigo"
    time.sleep(REQUEST_DELAY)

    try:
        resp = session.get(url, timeout=30)
        if resp.status_code != 200:
            return quizzes
        soup = BeautifulSoup(resp.text, "html.parser")
    except requests.RequestException:
        return quizzes

    # Samigo renders published assessments in a table; each row has the quiz title
    for row in soup.select("table tr"):
        cells = row.find_all("td")
        if not cells:
            continue

        title_cell = cells[0]
        title_link = title_cell.find("a")
        title = title_link.get_text(strip=True) if title_link else title_cell.get_text(strip=True)
        if not title:
            continue

        # Look for a due/available-until date in the row
        due_date = ""
        for cell in cells[1:]:
            text = cell.get_text(strip=True)
            if any(m in text for m in ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
                                        "/", "-")) and any(c.isdigit() for c in text):
                due_date = text
                break

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
# Main
# ---------------------------------------------------------------------------

CHECK_INTERVAL = 600  # seconds between checks (10 minutes)


def check_once(session: requests.Session, seen: set) -> set:
    """
    Run a single scrape cycle. Returns the updated seen set.
    Re-raises nothing — errors are caught and logged so the loop keeps running.
    """
    # Re-login if the session has expired (Sakai sessions are typically 1 hour)
    if not sakai_login(session):
        print("[WARN] Login failed this cycle; will retry next interval.")
        return seen

    sites = get_enrolled_sites(session)
    if not sites:
        print("[WARN] No enrolled sites found this cycle.")
        return seen

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

    seen.update(item["id"] for item in all_items)
    save_seen(seen)
    print(f"[*] seen.json updated ({len(seen)} total items tracked).")
    return seen


def main() -> None:
    validate_env()

    seen = load_seen()
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
        print(f"\n[*] Running check at {time.strftime('%Y-%m-%d %H:%M:%S')} ...")
        try:
            seen = check_once(session, seen)
        except Exception as exc:
            # Catch unexpected errors so the loop never crashes permanently
            print(f"[ERROR] Unexpected error during check: {exc}")

        print(f"[*] Next check in {CHECK_INTERVAL // 60} minutes ...")
        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
