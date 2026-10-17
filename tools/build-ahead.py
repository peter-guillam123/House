#!/usr/bin/env python3
"""
Build days/ahead.json: what Parliament is doing next.

For each House, the next sitting day (today, if it is one) with that
day's chamber business in running order, from Parliament's What's On
feed; recess and non-sitting days, so the page can say when a House
comes back; and the week ahead, day by day: chamber highlights and the
public committee evidence sessions with their witnesses.

The home page reads this file instead of calling Parliament live, so it
loads fast and the Worker needs no new hosts. GitHub Actions rebuilds it
through the day; business for the day is published the evening before
and urgent questions get added the same morning.

    python3 tools/build-ahead.py

Stdlib only.
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

WHATSON = "https://whatson-api.parliament.uk"
COMMITTEES = "https://committees-api.parliament.uk"
REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = REPO_ROOT / "days" / "ahead.json"
WEEK_DAYS = 7
LOOKAHEAD_DAYS = 70
HOUSES = ("Commons", "Lords")

# Chamber items worth a line in a week-ahead digest. Everything else
# (routine oral questions, ten minute rule motions) stays on the day.
HIGHLIGHT_CATEGORIES = {
    "Prime Minister's Question Time", "Statement", "Opposition Day Debate", "Legislation",
    "General debate", "Debate", "Estimates day", "Backbench Business",
}


def get_json(url, params=None):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  retry {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)
    raise RuntimeError(f"failed after retries: {url} ({last})")


def clean(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def title_for(e):
    t = clean(e.get("Description"))
    cat = e.get("Category") or ""
    if cat == "Prime Minister's Question Time":
        return "Prime Minister’s Questions"
    if cat == "Oral questions" and e.get("House") == "Commons":
        t = re.sub(r"\s*\(including Topical Questions\)", "", t)
        return f"{t} questions" if t else "Oral questions"
    return t or cat


def item_for(e):
    return {
        "time": e.get("StartTime") or None,
        "category": e.get("Category") or "",
        "title": title_for(e),
        "members": [m.get("Name") for m in e.get("Members") or [] if m.get("Name")][:3],
        "bill": e.get("BillName") or None,
        "venue": e.get("Type") or "",
        "house": e.get("House") or "",
    }


def chamber_business(events, house, day):
    """One House's business for one day, in running order, with the
    Lords' run of oral questions folded into a single line."""
    rows = [e for e in events if e.get("House") == house and (e.get("StartDate") or "")[:10] == day
            and e.get("Type") in ("Main Chamber", "Westminster Hall", "Grand Committee")]
    rows.sort(key=lambda e: ({"Main Chamber": 0, "Westminster Hall": 1, "Grand Committee": 2}.get(e.get("Type"), 9), e.get("SortOrder") or 0))
    out = []
    for e in rows:
        it = item_for(e)
        if house == "Lords" and it["category"] == "Oral questions" and out and out[-1]["category"] == "Oral questions" and out[-1]["venue"] == it["venue"]:
            out[-1].setdefault("topics", [out[-1]["title"]]).append(it["title"])
            out[-1]["title"] = f"Oral questions ({len(out[-1]['topics'])})"
            continue
        out.append(it)
    return out


def committee_sessions(day_from, day_to):
    sessions = []
    skip = 0
    while True:
        page = get_json(f"{COMMITTEES}/api/Events", {
            "StartDateFrom": day_from, "StartDateTo": day_to, "IncludeEventAttendees": "true",
            "ShowOnWebsiteOnly": "true", "ExcludeCancelledEvents": "true", "SortAscending": "true",
            "Take": 100, "Skip": skip,
        })
        items = page.get("items") or []
        for ev in items:
            panels = [a for a in ev.get("activities") or [] if a.get("activityType") == "Oral evidence" and not a.get("isPrivate")]
            if not panels:
                continue
            business = next((b for a in panels for b in (a.get("committeeBusinesses") or [])), {}) or {}
            witnesses = []
            for a in panels:
                for w in sorted(a.get("attendees") or [], key=lambda x: x.get("displayOrder") or 0):
                    orgs = ", ".join(o.get("name") for o in w.get("organisations") or [] if o.get("name"))
                    witnesses.append({"name": w.get("name") or "", "org": orgs})
            start = panels[0].get("startDate") or ev.get("startDate") or ""
            sessions.append({
                "id": ev["id"],
                "date": start[:10],
                "time": start[11:16],
                "committee": ", ".join(c.get("name") for c in ev.get("committees") or [] if c.get("name")),
                "house": (ev.get("committees") or [{}])[0].get("house") or "",
                "inquiry": business.get("title") or "",
                "inquiryId": business.get("id"),
                "witnesses": witnesses,
            })
        skip += len(items)
        if not items or skip >= page.get("totalResults", 0):
            break
    return sessions


def main():
    today = date.today()
    today_iso = today.isoformat()
    end_iso = (today + timedelta(days=LOOKAHEAD_DAYS)).isoformat()
    print(f"What's On {today_iso} to {end_iso}")
    # What's On refuses long windows, so walk it a month at a time.
    events = []
    cursor = today
    while cursor.isoformat() < end_iso:
        chunk_end = min(cursor + timedelta(days=27), today + timedelta(days=LOOKAHEAD_DAYS))
        page = get_json(f"{WHATSON}/calendar/events/list.json", {"startDate": cursor.isoformat(), "endDate": chunk_end.isoformat()})
        if isinstance(page, list):
            events.extend(e for e in page if isinstance(e, dict))
        cursor = chunk_end + timedelta(days=1)
    nonsitting = get_json(f"{WHATSON}/calendar/events/nonsitting.json", {"startDate": today_iso, "endDate": end_iso})
    nonsitting = [n for n in nonsitting if isinstance(n, dict)] if isinstance(nonsitting, list) else []
    print(f"  {len(events)} events, {len(nonsitting)} non-sitting entries")

    houses = {}
    for house in HOUSES:
        chamber_days = sorted({(e.get("StartDate") or "")[:10] for e in events
                               if e.get("House") == house and e.get("Type") == "Main Chamber"})
        next_day = chamber_days[0] if chamber_days else None
        # Why the gap, if there is one: the first non-sitting entry that
        # covers today or the days between now and the next sitting.
        reason = None
        for n in nonsitting:
            if n.get("House") != house:
                continue
            start, end = (n.get("StartDate") or "")[:10], (n.get("EndDate") or "")[:10]
            if start <= today_iso <= end or (next_day and today_iso < start < next_day):
                cat = (n.get("Category") or "").split(" - ")[0]
                reason = {"category": cat, "from": start, "to": end}
                break
        houses[house] = {
            "nextSitting": next_day,
            "isToday": next_day == today_iso,
            "gap": reason,
            "business": chamber_business(events, house, next_day) if next_day else [],
        }
        print(f"  {house}: next sitting {next_day}, {len(houses[house]['business'])} items")

    week_end = (today + timedelta(days=WEEK_DAYS)).isoformat()
    sessions = committee_sessions(today_iso, week_end)
    print(f"  {len(sessions)} committee sessions this week")
    week = []
    for i in range(WEEK_DAYS + 1):
        day = (today + timedelta(days=i)).isoformat()
        chamber = []
        for house in HOUSES:
            for e in events:
                if e.get("House") == house and (e.get("StartDate") or "")[:10] == day \
                        and e.get("Type") == "Main Chamber" and e.get("Category") in HIGHLIGHT_CATEGORIES:
                    chamber.append(item_for(e))
        mine = [s for s in sessions if s["date"] == day]
        if chamber or mine:
            week.append({"date": day, "chamber": chamber[:8], "committees": mine})

    out = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "today": today_iso,
        "houses": houses,
        "week": week,
    }
    OUT_PATH.parent.mkdir(exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {OUT_PATH.relative_to(REPO_ROOT)} ({OUT_PATH.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
