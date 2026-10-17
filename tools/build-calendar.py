#!/usr/bin/env python3
"""
Build subscribable calendar feeds of upcoming committee oral evidence.

Walks the Committees API's Events endpoint for the next eight weeks,
keeps the public oral evidence sessions, and writes:

  calendar/committees.ics            every committee, one feed
  calendar/committees/<id>-<slug>.ics  one feed per select committee
  calendar/events/<id>.ics           one file per session, for "add to
                                     calendar" on Apple and Outlook
  calendar/committees.json           manifest the page reads to list them

A reader subscribes once (webcal:// on Apple and Outlook, "From URL" on
Google) and the feed keeps itself current as GitHub Actions rebuilds it.
Event UIDs are stable, so a time or witness change updates the entry in
the reader's calendar rather than adding a second one; a cancelled
session drops out of the feed and the calendar removes it.

Times are London wall-clock with no zone, the same convention as
Parliament's own per-event file: the sessions happen in Westminster.

Stdlib only, so no `pip install` step.

    python3 tools/build-calendar.py
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

API = "https://committees-api.parliament.uk"
WINDOW_DAYS = 56
PAGE_SIZE = 100
UID_DOMAIN = "house.peter-guillam123.github.io"

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "calendar"
PER_COMMITTEE_DIR = OUT_DIR / "committees"
PER_EVENT_DIR = OUT_DIR / "events"
ALL_PATH = OUT_DIR / "committees.ics"
MANIFEST_PATH = OUT_DIR / "committees.json"


def get_json(path, params=None):
    url = API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001 - retry anything transient
            last = e
            print(f"  retry {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)
    raise RuntimeError(f"failed after retries: {url} ({last})")


def list_events(start_iso, end_iso):
    events = []
    skip = 0
    while True:
        page = get_json("/api/Events", {
            "StartDateFrom": start_iso,
            "StartDateTo": end_iso,
            "IncludeEventAttendees": "true",
            "ShowOnWebsiteOnly": "true",
            "ExcludeCancelledEvents": "true",
            "SortAscending": "true",
            "Take": PAGE_SIZE,
            "Skip": skip,
        })
        items = page.get("items") or []
        if not items:
            break
        events.extend(items)
        skip = len(events)
        if skip >= page.get("totalResults", 0):
            break
    return events


def list_select_committees():
    """Current select committees, both Houses and joint. Each gets a
    feed whether or not it has anything scheduled, so a subscription
    survives recess."""
    page = get_json("/api/Committees", {
        "CommitteeStatus": "Current",
        "CommitteeCategory": "Select",
        "ShowOnWebsiteOnly": "true",
        "Take": 300,
    })
    return [
        {"id": c["id"], "name": c.get("name") or "", "house": c.get("house") or ""}
        for c in page.get("items") or []
        if c.get("id") and c.get("name")
    ]


def session_from_event(ev):
    """One session per event: the public oral evidence panels merged,
    witnesses in running order. None if the event has no public panel."""
    panels = [
        a for a in ev.get("activities") or []
        if a.get("activityType") == "Oral evidence" and not a.get("isPrivate")
    ]
    if not panels:
        return None
    business = next((b for a in panels for b in (a.get("committeeBusinesses") or [])), {}) or {}
    witnesses = []
    for a in panels:
        for w in sorted(a.get("attendees") or [], key=lambda x: x.get("displayOrder") or 0):
            orgs = [o.get("name") for o in w.get("organisations") or [] if o.get("name")]
            name = w.get("name") or ""
            if name and orgs:
                witnesses.append(f"{name} ({', '.join(orgs)})")
            elif name or orgs:
                witnesses.append(name or ", ".join(orgs))
    committees = [c for c in ev.get("committees") or [] if c.get("name")]
    start = panels[0].get("startDate") or ev.get("startDate") or ""
    end = panels[-1].get("endDate") or ev.get("endDate") or ""
    return {
        "id": ev["id"],
        "start": start[:16],
        "end": end[:16],
        "committee": ", ".join(c["name"] for c in committees),
        "committee_ids": [c["id"] for c in committees],
        "location": ev.get("location") or "",
        "inquiry": (business.get("title") or ""),
        "inquiry_id": business.get("id"),
        "witnesses": witnesses,
        "url": f"https://api.parliament.uk/committees/events/{ev['id']}",
    }


# ---------- iCalendar ----------

def ics_text(s):
    return (str(s or "")
            .replace("\\", "\\\\")
            .replace("\r\n", "\n").replace("\n", "\\n")
            .replace(",", "\\,").replace(";", "\\;"))


def fold(line):
    """RFC 5545: lines longer than 75 octets fold with CRLF + space.
    Measured in bytes so a long run of accented names folds correctly."""
    out = []
    data = line.encode("utf-8")
    first = True
    while data:
        limit = 74 if first else 73
        chunk = data[:limit]
        # Don't split a multi-byte character.
        while chunk and len(chunk) > 0:
            try:
                text = chunk.decode("utf-8")
                break
            except UnicodeDecodeError:
                chunk = chunk[:-1]
        out.append(("" if first else " ") + text)
        data = data[len(chunk):]
        first = False
    return "\r\n".join(out)


def stamp(dt16):
    # "2026-10-19T16:30" -> "20261019T163000"
    return dt16.replace("-", "").replace(":", "") + "00"


def vevent(s):
    end = s["end"] if s["end"] and s["end"] > s["start"] else s["start"]
    summary = " · ".join(x for x in (s["inquiry"] or "Oral evidence", s["committee"]) if x)
    desc_lines = [f"Oral evidence session, {s['committee']}."]
    if s["witnesses"]:
        desc_lines.append("Witnesses: " + "; ".join(s["witnesses"]) + ".")
    else:
        desc_lines.append("Witnesses to be announced.")
    desc_lines.append(s["url"])
    lines = [
        "BEGIN:VEVENT",
        f"UID:house-committee-event-{s['id']}@{UID_DOMAIN}",
        # DTSTAMP is meant to be the creation time; using the session's
        # own start keeps the file byte-stable between builds, so the
        # workflow only commits when the schedule has changed.
        f"DTSTAMP:{stamp(s['start'])}Z",
        f"DTSTART:{stamp(s['start'])}",
        f"DTEND:{stamp(end)}",
        f"SUMMARY:{ics_text(summary)}",
    ]
    if s["location"]:
        lines.append(f"LOCATION:{ics_text(s['location'])}")
    lines.append(f"DESCRIPTION:{ics_text(chr(10).join(desc_lines))}")
    lines.append(f"URL:{s['url']}")
    lines.append("END:VEVENT")
    return lines


def vcalendar(name, sessions):
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//House//Committee calendars//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{ics_text(name)}",
        "X-WR-TIMEZONE:Europe/London",
    ]
    for s in sorted(sessions, key=lambda x: x["start"]):
        lines.extend(vevent(s))
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(l) for l in lines) + "\r\n"


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")[:60]


# ---------- main ----------

def main():
    today = date.today()
    start_iso = today.isoformat()
    end_iso = (today + timedelta(days=WINDOW_DAYS)).isoformat()
    print(f"Events {start_iso} to {end_iso}")
    events = list_events(start_iso, end_iso)
    sessions = [s for s in (session_from_event(e) for e in events) if s]
    print(f"  {len(events)} events, {len(sessions)} public oral evidence sessions")

    committees = {c["id"]: c for c in list_select_committees()}
    # Any committee with a session gets a feed even if it isn't a select
    # committee (joint committees, commissions).
    for ev in events:
        for c in ev.get("committees") or []:
            if c.get("id") and c.get("name") and c["id"] not in committees:
                committees[c["id"]] = {"id": c["id"], "name": c["name"], "house": c.get("house") or ""}
    print(f"  {len(committees)} committee feeds")

    OUT_DIR.mkdir(exist_ok=True)
    PER_COMMITTEE_DIR.mkdir(exist_ok=True)
    ALL_PATH.write_text(vcalendar("House · Committee oral evidence", sessions), encoding="utf-8")

    manifest = []
    wanted = set()
    for cid, c in sorted(committees.items(), key=lambda kv: kv[1]["name"].lower()):
        mine = [s for s in sessions if cid in s["committee_ids"]]
        fname = f"{cid}-{slugify(c['name'])}.ics"
        wanted.add(fname)
        (PER_COMMITTEE_DIR / fname).write_text(vcalendar(f"House · {c['name']}", mine), encoding="utf-8")
        manifest.append({
            "id": cid,
            "name": c["name"],
            "house": c["house"],
            "file": f"committees/{fname}",
            "upcoming": len(mine),
        })
    # A renamed or wound-up committee leaves a stale file behind; clear it.
    for stale in PER_COMMITTEE_DIR.glob("*.ics"):
        if stale.name not in wanted:
            stale.unlink()
            print(f"  removed stale feed {stale.name}")

    # One file per session. Served as a real file with the calendar
    # content type, a phone opens it as an event with an Add button,
    # where a file generated in the browser only ever downloads.
    PER_EVENT_DIR.mkdir(exist_ok=True)
    event_ids = []
    for s in sessions:
        name = " · ".join(x for x in (s["inquiry"] or "Oral evidence", s["committee"]) if x)
        (PER_EVENT_DIR / f"{s['id']}.ics").write_text(vcalendar(name, [s]), encoding="utf-8")
        event_ids.append(s["id"])
    for stale in PER_EVENT_DIR.glob("*.ics"):
        if stale.stem not in {str(i) for i in event_ids}:
            stale.unlink()

    MANIFEST_PATH.write_text(json.dumps({
        "built": start_iso,
        "windowDays": WINDOW_DAYS,
        "sessions": len(sessions),
        "all": "committees.ics",
        "committees": manifest,
        "events": sorted(event_ids),
    }, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"Wrote {ALL_PATH.relative_to(REPO_ROOT)}, {len(manifest)} committee feeds and {len(event_ids)} event files")


if __name__ == "__main__":
    main()
