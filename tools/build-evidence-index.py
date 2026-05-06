#!/usr/bin/env python3
"""
Build a static search index of committee oral evidence transcripts.

Walks the committees-api OralEvidence list for the last N days, fetches
each session's HTML transcript, parses it into speaker-attributed
segments, and writes evidence-index.json at the repo root. The client
loads that file on Committees and runs full-text search entirely in
the browser.

Run by .github/workflows/build-evidence-index.yml on a daily cron, but
also runnable locally (uses only Python stdlib so no `pip install`).
"""

import sys
import json
import base64
import re
import time
from datetime import date, timedelta
from pathlib import Path
import urllib.request
import urllib.parse

API = "https://committees-api.parliament.uk"
WINDOW_DAYS = 30              # Last month — keeps the index file under ~12MB
PAGE_SIZE = 100
TRANSCRIPT_THROTTLE = 0.05    # be polite between fetches
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "evidence-index.json"


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
        except Exception as e:
            last = e
            print(f"  retry {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)
    raise RuntimeError(f"failed after retries: {url} ({last})")


def list_sessions(start_iso, end_iso):
    sessions = []
    skip = 0
    while True:
        page = get_json(
            "/api/OralEvidence",
            {
                "StartDate": start_iso,
                "EndDate": end_iso,
                "ShowOnWebsiteOnly": "true",
                "Take": PAGE_SIZE,
                "Skip": skip,
            },
        )
        items = page.get("items") or []
        if not items:
            break
        sessions.extend(items)
        total = page.get("totalResults", 0)
        skip = len(sessions)
        if skip >= total:
            break
    return sessions


def fetch_transcript_html(session_id):
    d = get_json(f"/api/OralEvidence/{session_id}/Document/Html")
    if not d or "data" not in d:
        return ""
    binary = base64.b64decode(d["data"])
    html = binary.decode("utf-8", errors="replace")
    # Drop inline base64 images (parliament boilerplate, no signal)
    html = re.sub(r'(src|href)="data:image/[^"]+"', "", html)
    return html


PARA_RE = re.compile(r"<p[^>]*>([\s\S]*?)</p>")
BOLD_RE = re.compile(r'<span[^>]*font-weight:\s*bold[^>]*>([^<]*?)</span>', re.I)
SPEAKER_LIKE = re.compile(r"^[A-Z][\w\s().,\-'’]{0,90}:$")
TAG_RE = re.compile(r"<[^>]+>")
ENTITY_RE = re.compile(r"&(?:#x([0-9a-fA-F]+)|#(\d+)|nbsp|amp|lt|gt|quot|#39);")


def decode_entity(m):
    s = m.group(0)
    if s == "&nbsp;": return " "
    if s == "&amp;":  return "&"
    if s == "&lt;":   return "<"
    if s == "&gt;":   return ">"
    if s == "&quot;": return '"'
    if s == "&#39;":  return "'"
    if m.group(1):
        try: return chr(int(m.group(1), 16))
        except (ValueError, OverflowError): return ""
    if m.group(2):
        try: return chr(int(m.group(2)))
        except (ValueError, OverflowError): return ""
    return s


def decode_entities(s): return ENTITY_RE.sub(decode_entity, s)
def strip_tags(s):      return TAG_RE.sub(" ", s)


def parse_segments(html):
    """Mirror the JS parser in src/api.js — paragraph-by-paragraph,
    attributing each to a speaker using the bold-prefix convention."""
    segments = []
    current_speaker = ""
    for m in PARA_RE.finditer(html):
        inner = m.group(1)
        bold = BOLD_RE.search(inner)
        if bold and bold.start() < 240:
            candidate = strip_tags(decode_entities(bold.group(1))).strip()
            if SPEAKER_LIKE.match(candidate):
                current_speaker = candidate.rstrip(":").strip()
                inner = inner[: bold.start()] + inner[bold.end():]
        text = strip_tags(decode_entities(inner))
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            segments.append({"sp": current_speaker, "tx": text})
    return segments


def witness_label(w):
    name = (w.get("name") or "").strip()
    orgs = ", ".join((o.get("name") or "").strip() for o in (w.get("organisations") or []) if o.get("name"))
    if name and orgs: return f"{name} ({orgs})"
    if name:          return name
    if orgs:          return orgs
    return ""


def build_session_record(session_meta):
    sid = session_meta.get("id")
    if sid is None:
        return None
    try:
        html = fetch_transcript_html(sid)
    except Exception as e:
        print(f"\n  ! transcript {sid}: {e}", file=sys.stderr)
        return None
    segments = parse_segments(html)
    if not segments:
        return None
    biz = (session_meta.get("committeeBusinesses") or [{}])[0] or {}
    witnesses = []
    for w in (session_meta.get("witnesses") or []):
        label = witness_label(w)
        if label:
            witnesses.append(label)
    return {
        "id": sid,
        "d": (session_meta.get("meetingDate") or "")[:10],
        "iId": biz.get("id"),
        "iT": biz.get("title") or "",
        "w": "; ".join(witnesses[:6]),
        "segs": segments,
    }


def main():
    today = date.today()
    start = (today - timedelta(days=WINDOW_DAYS)).isoformat()
    end = today.isoformat()
    print(f"Building index for {start} → {end} (window: {WINDOW_DAYS} days)")

    sessions_meta = list_sessions(start, end)
    print(f"Found {len(sessions_meta)} oral-evidence sessions")

    out = []
    for i, s in enumerate(sessions_meta):
        sid = s.get("id")
        date_label = (s.get("meetingDate") or "")[:10]
        print(f"[{i + 1:>4}/{len(sessions_meta)}] {sid:>6} {date_label}", file=sys.stderr)
        rec = build_session_record(s)
        if rec is not None:
            out.append(rec)
        time.sleep(TRANSCRIPT_THROTTLE)

    payload = {
        "buildDate": today.isoformat(),
        "windowDays": WINDOW_DAYS,
        "sessionCount": len(out),
        "sessions": out,
    }
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    size = OUTPUT_PATH.stat().st_size
    print(f"\nWrote {OUTPUT_PATH.name}: {len(out)} sessions, {size:,} bytes")


if __name__ == "__main__":
    main()
