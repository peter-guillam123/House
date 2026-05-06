#!/usr/bin/env python3
"""
Build static search indexes of committee oral evidence transcripts.

Two modes:

  • Rolling (default): walks the last N days, writes evidence-index.json.
    Run daily by GitHub Actions; covers the current quarter and most of
    the previous one.

      python3 tools/build-evidence-index.py

  • Quarterly archive: walks one specific completed quarter, writes
    evidence-YYYY-QN.json. Run manually (or via workflow_dispatch) at
    the start of each new quarter to seal the previous one.

      python3 tools/build-evidence-index.py --quarter 2025-Q4

After either mode, regenerates evidence-archives.json so the client
knows what's available without server-side directory listing.

Stdlib only, so no `pip install` step.
"""

import sys
import json
import base64
import re
import time
import argparse
from datetime import date, timedelta
from pathlib import Path
import urllib.request
import urllib.parse

API = "https://committees-api.parliament.uk"
WINDOW_DAYS = 90              # Rolling window — covers current quarter and most of the previous one
PAGE_SIZE = 100
TRANSCRIPT_THROTTLE = 0.05    # be polite between fetches

REPO_ROOT      = Path(__file__).resolve().parent.parent
ROLLING_PATH   = REPO_ROOT / "evidence-index.json"
MANIFEST_PATH  = REPO_ROOT / "evidence-archives.json"
QUARTER_RE     = re.compile(r"^(\d{4})-Q([1-4])$")
QUARTER_FILE_GLOB = "evidence-[0-9][0-9][0-9][0-9]-Q[1-4].json"
MONTH_NAMES    = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


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


def parse_quarter_arg(s):
    m = QUARTER_RE.match(s.strip())
    if not m:
        raise argparse.ArgumentTypeError(f"expected YYYY-QN (e.g. 2025-Q4), got {s!r}")
    year = int(m.group(1))
    quarter = int(m.group(2))
    return year, quarter


def quarter_dates(year, quarter):
    """Inclusive start/end dates for a quarter (e.g. 2025-Q4 → Oct 1 – Dec 31)."""
    start_month = (quarter - 1) * 3 + 1
    end_month   = start_month + 2
    start = date(year, start_month, 1)
    if end_month == 12:
        end = date(year, 12, 31)
    else:
        end = date(year, end_month + 1, 1) - timedelta(days=1)
    return start, end


def quarter_label(year, quarter):
    start_month = (quarter - 1) * 3 + 1
    return f"{MONTH_NAMES[start_month - 1]}–{MONTH_NAMES[start_month + 1]} {year}"


def build_index(start_iso, end_iso, output_path, *, label_extra="", header_extra=None):
    print(f"Building index for {start_iso} → {end_iso}{label_extra}")
    sessions_meta = list_sessions(start_iso, end_iso)
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
        "buildDate": date.today().isoformat(),
        "sessionCount": len(out),
        "sessions": out,
    }
    if header_extra:
        payload.update(header_extra)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    size = output_path.stat().st_size
    print(f"\nWrote {output_path.name}: {len(out)} sessions, {size:,} bytes")
    return payload, size


def read_index_meta(path):
    """Pull just the small header fields out of a built index without
    parsing the whole sessions array."""
    try:
        data = json.loads(path.read_text())
    except Exception:
        return None
    return {
        "buildDate":    data.get("buildDate", ""),
        "sessionCount": data.get("sessionCount", 0),
        "windowDays":   data.get("windowDays"),
        "quarter":      data.get("quarter"),
        "label":        data.get("label", ""),
    }


def rebuild_manifest():
    """Scan repo root for built indexes and write evidence-archives.json
    listing what's available. Self-healing — if a quarter file gets
    deleted, it falls out of the manifest on the next run."""
    rolling = None
    if ROLLING_PATH.exists():
        m = read_index_meta(ROLLING_PATH)
        if m:
            rolling = {
                "url":          ROLLING_PATH.name,
                "label":        f"Last {m.get('windowDays', WINDOW_DAYS)} days",
                "windowDays":   m.get("windowDays"),
                "sessionCount": m["sessionCount"],
                "buildDate":    m["buildDate"],
                "size":         ROLLING_PATH.stat().st_size,
            }
    quarters = []
    for path in sorted(REPO_ROOT.glob(QUARTER_FILE_GLOB)):
        m = read_index_meta(path)
        if not m:
            continue
        qm = QUARTER_RE.match(path.stem.replace("evidence-", ""))
        if not qm:
            continue
        year = int(qm.group(1))
        quarter = int(qm.group(2))
        quarters.append({
            "id":           f"{year}-Q{quarter}",
            "label":        m.get("label") or quarter_label(year, quarter),
            "url":          path.name,
            "sessionCount": m["sessionCount"],
            "buildDate":    m["buildDate"],
            "size":         path.stat().st_size,
        })
    # Newest quarter first
    quarters.sort(key=lambda q: q["id"], reverse=True)
    payload = {"rolling": rolling, "quarters": quarters}
    MANIFEST_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"Manifest: rolling={'yes' if rolling else 'no'}, quarters={len(quarters)} → {MANIFEST_PATH.name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--quarter", type=parse_quarter_arg,
                        help="Build a sealed quarterly archive (e.g. 2025-Q4) instead of the rolling index")
    args = parser.parse_args()

    if args.quarter:
        year, quarter = args.quarter
        start, end = quarter_dates(year, quarter)
        out_path = REPO_ROOT / f"evidence-{year}-Q{quarter}.json"
        build_index(
            start.isoformat(), end.isoformat(), out_path,
            label_extra=f" ({year}-Q{quarter})",
            header_extra={
                "quarter": f"{year}-Q{quarter}",
                "label": quarter_label(year, quarter),
            },
        )
    else:
        today = date.today()
        start = (today - timedelta(days=WINDOW_DAYS)).isoformat()
        end = today.isoformat()
        build_index(
            start, end, ROLLING_PATH,
            label_extra=f" (rolling {WINDOW_DAYS}-day)",
            header_extra={"windowDays": WINDOW_DAYS},
        )

    rebuild_manifest()


if __name__ == "__main__":
    main()
