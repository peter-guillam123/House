#!/usr/bin/env python3
"""
Build a structured summary of one sitting day in Parliament.

For each House, reads the day's Hansard (every debate, with who spoke,
for how long and in what words), the divisions with each member's vote,
written statements and answers, committee sessions and reports, and bill
stages, and writes days/YYYY-MM-DD.json plus days/index.json. The page
day.html reads those files; nothing is fetched live.

"Words that spiked" compares the day's vocabulary with the previous
sitting days' files already in days/, so the baseline is free and gets
better as the archive grows.

    python3 tools/build-day.py                 # the last sitting day of each House
    python3 tools/build-day.py --date 2026-10-14
    python3 tools/build-day.py --backfill 15   # the last 15 sitting days per House

Stdlib only, so no `pip install` step.
"""

import argparse
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HANSARD = "https://hansard-api.parliament.uk"
CVOTES = "https://commonsvotes-api.parliament.uk"
LVOTES = "https://lordsvotes-api.parliament.uk"
QS = "https://questions-statements-api.parliament.uk"
COMMITTEES = "https://committees-api.parliament.uk"
BILLS = "https://bills-api.parliament.uk"
MEMBERS = "https://members-api.parliament.uk"

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "days"
INDEX_PATH = OUT_DIR / "index.json"
VOCAB_DIR = OUT_DIR / "vocab"
MEMBERS_CACHE_PATH = OUT_DIR / "members.json"

HOUSES = ("Commons", "Lords")
BASELINE_DAYS = 15          # sitting days behind the spike comparison
VOCAB_KEEP = 1000           # terms kept per day for the baseline
SPIKES_KEEP = 14
TOP_SPEAKERS = 10
REBUILD_WITHIN_DAYS = 3     # re-run a day's file while Hansard may still be filling in
THROTTLE = 0.05


# ---------- HTTP ----------

def get_json(url, params=None):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read())
                time.sleep(THROTTLE)
                return data
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  retry {attempt + 1}: {url[:90]} ({e})", file=sys.stderr)
            time.sleep(2 ** attempt)
    raise RuntimeError(f"failed after retries: {url} ({last})")


def try_json(url, params=None, default=None):
    try:
        return get_json(url, params)
    except Exception as e:  # noqa: BLE001
        print(f"  skipped: {url[:90]} ({e})", file=sys.stderr)
        return default


# ---------- text ----------

TAG_RE = re.compile(r"<[^>]+>")
ENTITY_RE = re.compile(r"&(?:#x([0-9a-fA-F]+)|#(\d+)|nbsp|amp|lt|gt|quot|#39|rsquo|lsquo|rdquo|ldquo|hellip|ndash|mdash);")
ENTITY_MAP = {"&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
              "&rsquo;": "’", "&lsquo;": "‘", "&rdquo;": "”", "&ldquo;": "“",
              "&hellip;": "…", "&ndash;": "–", "&mdash;": "—"}


def decode_entity(m):
    s = m.group(0)
    if s in ENTITY_MAP:
        return ENTITY_MAP[s]
    try:
        return chr(int(m.group(1), 16)) if m.group(1) else chr(int(m.group(2)))
    except (ValueError, OverflowError, TypeError):
        return ""


def plain_text(html):
    return re.sub(r"\s+", " ", ENTITY_RE.sub(decode_entity, TAG_RE.sub(" ", html or ""))).strip()


WORD_RE = re.compile(r"[A-Za-z][A-Za-z'’-]+")

# Everyday English plus the chamber's own boilerplate. Anything here can
# never be a "word that spiked"; it is the furniture of every sitting.
STOPWORDS = set("""
a about above after again against all also am an and any are as at be because been before being below between
both but by can cannot could did do does doing done down during each either few for from further had has have
having he her here hers herself him himself his how i if in into is it its itself just let me more most much must
my myself no nor not now of off on once only or other ought our ours ourselves out over own same she should so
some such than that the their theirs them themselves then there these they this those through to too under until
up upon us very was we were what when where which while who whom whose why will with within without would yes
you your yours yourself yourselves one two three four five six seven eight nine ten first second third last next
new old many well may might shall still already even ever never often always sometimes however therefore thus
whether although though since yet across along among around behind beside beyond despite except inside outside
toward towards via per also another every anything everything nothing something someone anyone everyone
hon honourable friend friends member members minister ministers house commons lords lord lords lady ladies
noble noble's baroness baronesses viscount earl duke learned gallant reverend primate bishop lordships lordship
gentleman gentlemen speaker deputy chair madam mr mrs ms sir dame right secretary state government opposition
question questions answer answers point points order debate debates motion amendment amendments clause bill
bills act section schedule committee committees report reports statement statements urgent time today yesterday
tomorrow week weeks month months year years day days ago back forward make makes made making take takes taken
taking give gives given giving get gets got getting go goes going went gone come comes came coming put puts say
says said saying see sees seen seeing know knows known knowing think thinks thought thinking want wants wanted
look looks looked need needs needed work works worked working way ways thing things lot lots part parts place
places people person sure course case cases fact facts important issue issues matter matters number numbers
support supports supported supporting ensure ensures ensured clear clearly absolutely really very quite rather
indeed whole great good better best bad worse worst big small large long short high low able unable
agree agreed welcome welcomes thank thanks grateful pleased glad happy sorry delighted
country countries nation national british britain uk united kingdom england scotland wales northern ireland
constituency constituents constituent local area areas community communities public private
prime pm chancellor leader party parties labour conservative conservatives liberal democrat democrats tory tories
reform snp green greens plaid cymru dup sinn fein independent independents crossbench
told tell tells telling ask asks asked asking call calls called calling raise raises raised raising
mention mentions mentioned mentioning hear hears heard hearing listen listens listened
set sets setting put putting bring brings brought bringing continue continues continued continuing
believe believes believed believing hope hopes hoped hoping feel feels felt feeling mean means meant meaning
seem seems seemed seeming find finds found finding keep keeps kept keeping leave leaves left leaving
provide provides provided providing include includes included including follow follows followed following
allow allows allowed allowing help helps helped helping move moves moved moving
across along end ends ended ending start starts started starting begin begins began beginning
plan plans planned planning deliver delivers delivered delivering change changes changed changing
whether while until unless against through throughout around within without
""".split())

PARTY_WORDS = set("labour conservative liberal democrat snp reform green dup plaid cymru sinn fein crossbench".split())


def tokens(text):
    out = []
    for w in WORD_RE.findall(text):
        t = w.lower().replace("’", "'").strip("'-")
        if len(t) < 3 or t in STOPWORDS or t.endswith("'s") and t[:-2] in STOPWORDS:
            continue
        out.append((t, w))
    return out


def count_terms(texts):
    """Unigram and bigram counts, plus the most common surface form of each."""
    uni, bi = Counter(), Counter()
    surface = defaultdict(Counter)
    for text in texts:
        toks = tokens(text)
        prev = None
        for t, w in toks:
            uni[t] += 1
            surface[t][w] += 1
            if prev is not None:
                key = f"{prev[0]} {t}"
                bi[key] += 1
                surface[key][f"{prev[1]} {w}"] += 1
            prev = (t, w)
        # Bigrams shouldn't span sentences, roughly: reset on long gaps is
        # overkill; contributions are short enough that this is fine.
    return uni, bi, surface


# ---------- Hansard ----------

KNOWN_PARTIES = {
    "Lab", "Labour", "Lab/Co-op", "Co-op", "Lab Co-op", "Con", "Conservative", "Conservative Independent",
    "LD", "Lib Dem", "Liberal Democrat", "SNP", "Scottish National Party", "Reform", "Reform UK", "Green",
    "Green Party", "DUP", "UUP", "TUV", "PC", "Plaid Cymru", "SF", "Sinn Féin", "SDLP", "Alliance", "APNI",
    "Ind", "Independent", "CB", "Crossbench", "Bishops", "Bishop", "Lord Bishop", "Speaker", "Non-Afl",
    "Non-affiliated", "UKIP",
}
PARTY_SHORT = {
    "Labour": "Lab", "Conservative": "Con", "Liberal Democrat": "LD", "Lib Dem": "LD",
    "Scottish National Party": "SNP", "Reform UK": "Reform", "Green Party": "Green", "Plaid Cymru": "PC",
    "Sinn Féin": "SF", "Independent": "Ind", "Crossbench": "CB", "Non-affiliated": "Non-Afl",
    "Co-op": "Lab/Co-op", "Lab Co-op": "Lab/Co-op", "Conservative Independent": "Con Ind",
    "Bishop": "Bishops", "Lord Bishop": "Bishops", "APNI": "Alliance", "Labour (Co-op)": "Lab/Co-op",
    "Democratic Unionist Party": "DUP", "Ulster Unionist Party": "UUP", "Traditional Unionist Voice": "TUV",
    "Social Democratic & Labour Party": "SDLP", "Alliance Party of Northern Ireland": "Alliance",
}
CHAIR_RE = re.compile(r"\b(Speaker|Deputy Speaker|Chair|Chairman|Lord Speaker|Deputy Chairman)\b", re.I)


def parse_attribution(attr):
    """'Apsana Begum (Poplar and Limehouse) (Lab)' -> ('Apsana Begum', 'Lab');
    'The Prime Minister' -> ('The Prime Minister', '')."""
    attr = (attr or "").strip()
    parens = list(re.finditer(r"\(([^()]+)\)", attr))
    party = ""
    if parens and parens[-1].group(1).strip() in KNOWN_PARTIES:
        party = PARTY_SHORT.get(parens[-1].group(1).strip(), parens[-1].group(1).strip())
        attr = attr[:parens[-1].start()].strip()
        parens = parens[:-1]
    # Drop the constituency too; keep role-led names whole.
    if parens and not attr.startswith("The "):
        attr = attr[:parens[-1].start()].strip()
    # 'The Minister for X (Jane Smith)' -> 'Jane Smith (Minister for X)'
    m = re.match(r"^The (.+?) \(([^()]+)\)$", attr)
    if m:
        attr = f"{m.group(2)} ({m.group(1)})"
    return attr, party


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s or "").lower()).strip("-")[:80]


def hansard_link(house, day, ext, title):
    return f"https://hansard.parliament.uk/{house}/{day}/debates/{ext}/{slugify(title)}"


# Section kinds by Hansard's HRSTag. Containers (headings with no
# contributions of their own) are skipped.
CONTAINER_TAGS = {"hs_3MainHdg", "hs_6bPetitions", "hs_Venue", "Division", "DeferredDivision", None}
KIND_BY_TAG = {
    "hs_8Question": "questions",
    "hs_2cStatement": "statement",
    "hs_2cUrgentQuestion": "uq",
    "hs_2cBillTitle": "legislation",
    "hs_2BillTitle": "legislation",
    "hs_2DebatedMotion": "debate",
    "hs_2cDebatedMotion": "debate",
    "hs_2BusinessWODebate": "business",
    "hs_8Petition": "petition",
    "hs_2DebBill": "other",
    "hs_2cGenericHdg": "other",
    "hs_2GenericHdg": "other",
    "NewDebate": "debate",
}


def tree_leaves(tree):
    """Flatten the day's section tree to (tag, title, ext, parent_title, grandparent_title)."""
    out = []

    def walk(items, path):
        for s in items:
            kids = s.get("SectionTreeItems") or []
            if kids:
                walk(kids, path + [(s.get("HRSTag"), s.get("Title") or "")])
            elif s.get("ExternalId") and s.get("HRSTag") not in CONTAINER_TAGS:
                out.append({
                    "tag": s.get("HRSTag"),
                    "title": (s.get("Title") or "").strip(),
                    "ext": s["ExternalId"],
                    "timecode": s.get("Timecode"),
                    "parent": path[-1] if path else (None, ""),
                    "grandparent": path[-2] if len(path) > 1 else (None, ""),
                })
    walk(tree if isinstance(tree, list) else [tree], [])
    return out


def good_time(tc, day=None):
    if not tc or tc.endswith("T00:00:00"):
        return False
    return day is None or tc.startswith(day)


def summarise_debate(house, day, leaf, debate, members_cache):
    items = debate.get("Items") or []
    spoken = [i for i in items if i.get("ItemType") == "Contribution" and i.get("MemberId")]
    per_member = {}
    texts = []
    times = [i["Timecode"] for i in items if good_time(i.get("Timecode"), day)]
    if leaf.get("timecode") and good_time(leaf["timecode"], day):
        times.append(leaf["timecode"])
    contributions = 0
    words = 0
    for i in spoken:
        name, party = parse_attribution(i.get("AttributedTo"))
        text = plain_text(i.get("Value"))
        if not text:
            continue
        n = len(text.split())
        if CHAIR_RE.search(i.get("AttributedTo") or ""):
            continue  # the chair's procedural lines aren't speeches
        contributions += 1
        words += n
        texts.append(text)
        mid = i["MemberId"]
        rec = per_member.setdefault(mid, {"memberId": mid, "name": name, "party": party, "words": 0, "contributions": 0})
        rec["words"] += n
        rec["contributions"] += 1
        if not rec["party"] and party:
            rec["party"] = party
    top = sorted(per_member.values(), key=lambda r: -r["words"])[:3]
    return {
        "kind": None,  # set by caller
        "title": leaf["title"],
        "ext": leaf["ext"],
        "link": hansard_link(house, day, leaf["ext"], leaf["title"]),
        "department": None,
        "speakers": len(per_member),
        "contributions": contributions,
        "words": words,
        "from": min(times)[11:16] if times else None,
        "to": max(times)[11:16] if times else None,
        "top": [{k: v for k, v in r.items() if k != "contributions"} for r in top],
    }, per_member, texts


def build_hansard(house, day, members_cache):
    tree = try_json(f"{HANSARD}/overview/sectiontrees.json", {"house": house, "date": day, "section": "Debate"})
    if not tree or isinstance(tree, dict) and tree.get("Message"):
        return None
    leaves = tree_leaves(tree)
    # Westminster Hall and other venues don't appear in the chamber tree;
    # the day's debate search lists everything with its venue.
    search = try_json(f"{HANSARD}/search/debates.json", {
        "queryParameters.startDate": day, "queryParameters.endDate": day,
        "queryParameters.house": house, "queryParameters.take": 200,
    }, {}) or {}
    seen = {l["ext"] for l in leaves}
    for r in search.get("Results") or []:
        venue = r.get("DebateSection") or ""
        ext = r.get("DebateSectionExtId") or ""
        if venue == "Westminster Hall" and ext and ext not in seen:
            leaves.append({"tag": "WestminsterHall", "title": (r.get("Title") or "").strip(), "ext": ext,
                           "parent": (None, "Westminster Hall"), "grandparent": (None, "")})
            seen.add(ext)
    if not leaves:
        return None

    sections = []
    speakers = {}
    texts = []
    in_opposition = False
    department = ""
    for leaf in leaves:
        tag = leaf["tag"]
        # Hansard's headings ("Opposition Day", "Oral Answers to
        # Questions", a department's name) sit beside the items they
        # introduce, not above them. Carry them forward as markers.
        if tag == "hs_3cOppositionDay":
            in_opposition = True
            continue
        if tag == "hs_3OralAnswers":
            department = ""
            continue
        if tag == "hs_6bDepartment":
            department = leaf["title"]
            continue
        if tag not in ("hs_2DebatedMotion", "hs_2cDebatedMotion"):
            in_opposition = False
        debate = try_json(f"{HANSARD}/debates/debate/{leaf['ext']}.json")
        if not debate or not debate.get("Items"):
            continue
        sec, per_member, sec_texts = summarise_debate(house, day, leaf, debate, members_cache)
        kind = KIND_BY_TAG.get(tag, "other")
        if tag == "WestminsterHall":
            kind = "westminster-hall"
        if kind == "questions":
            sec["department"] = department or leaf["parent"][1].strip()
            if sec["department"] == "Prime Minister":
                kind = "pmqs"
        if kind == "debate" and in_opposition:
            kind = "opposition"
        if house == "Lords" and kind == "debate" and re.search(r"\b(Bill|Regulations|Order|Rules)\b( \[HL\])?$", sec["title"]):
            kind = "legislation"
        # Nothing was said: a bill introduced, a heading, a procedural
        # line from the chair. Keep bills (an introduction is news); drop
        # the rest.
        if sec["contributions"] == 0 and kind != "legislation":
            continue
        sec["kind"] = kind
        sections.append(sec)
        texts.extend(sec_texts)
        for mid, rec in per_member.items():
            agg = speakers.setdefault(mid, {**rec, "words": 0, "contributions": 0, "sections": 0})
            agg["words"] += rec["words"]
            agg["contributions"] += rec["contributions"]
            agg["sections"] += 1
            if not agg["party"] and rec["party"]:
                agg["party"] = rec["party"]

    # Lords question time: up to four short questions at the start of
    # the sitting. Hansard tags them like any other debate.
    if house == "Lords":
        first = next((s["from"] for s in sections if s["from"]), None)
        if first:
            fh, fm = int(first[:2]), int(first[3:5])
            for s in sections[:4]:
                if s["from"] and (int(s["from"][:2]) * 60 + int(s["from"][3:5])) - (fh * 60 + fm) <= 45 and s["words"] < 3000:
                    s["kind"] = "questions"

    # The adjournment debate is the last debated motion in the Commons
    # chamber. Hansard doesn't tag it, but it's always last.
    chamber_motions = [s for s in sections if s["kind"] == "debate"]
    if house == "Commons" and chamber_motions:
        last = chamber_motions[-1]
        if last is sections[-1] or all(s["kind"] in ("westminster-hall", "business", "petition", "other") for s in sections[sections.index(last) + 1:]):
            last["kind"] = "adjournment"

    # Parties for ministers and anyone else Hansard didn't label.
    fill_parties(speakers, members_cache)
    for sec in sections:
        for t in sec["top"]:
            if not t["party"] and t["memberId"] in speakers:
                t["party"] = speakers[t["memberId"]]["party"]

    uni, bi, surface = count_terms(texts)
    chamber = [s for s in sections if s["kind"] != "westminster-hall"]
    starts = [s["from"] for s in chamber if s["from"]]
    adj = next((s for s in chamber if s["kind"] == "adjournment"), None)
    ends = [adj["to"]] if adj and adj["to"] else [s["to"] for s in chamber if s["to"]]
    return {
        "sat": {"from": min(starts), "to": max(ends) if ends else None} if starts else None,
        "sections": sections,
        "speakers": sorted(speakers.values(), key=lambda r: -r["words"])[:TOP_SPEAKERS],
        "numbers": {
            "sections": len([s for s in sections if s["kind"] not in ("business", "petition", "other")]),
            "speakers": len(speakers),
            "contributions": sum(s["contributions"] for s in sections),
            "words": sum(s["words"] for s in sections),
            "statements": len([s for s in sections if s["kind"] == "statement"]),
            "uqs": len([s for s in sections if s["kind"] == "uq"]),
        },
        "vocab": {
            "words": sum(uni.values()),
            "uni": {t: c for t, c in uni.most_common(VOCAB_KEEP)},
            "bi": {t: c for t, c in bi.most_common(VOCAB_KEEP)},
            # Surface forms are only needed while scoring spikes; they
            # aren't written to disk.
            "surface": {t: surface[t].most_common(1)[0][0] for t in list(dict(uni.most_common(VOCAB_KEEP))) + list(dict(bi.most_common(VOCAB_KEEP)))},
        },
    }


def fill_parties(speakers, cache, cap=40):
    todo = [mid for mid, r in speakers.items() if not r["party"]]
    for mid in todo[:cap]:
        key = str(mid)
        if key not in cache:
            data = try_json(f"{MEMBERS}/api/Members/{mid}")
            v = (data or {}).get("value") or {}
            party = (v.get("latestParty") or {}).get("name") or ""
            cache[key] = {"name": v.get("nameDisplayAs") or "", "party": PARTY_SHORT.get(party, party)}
        if cache[key].get("party"):
            speakers[mid]["party"] = cache[key]["party"]


# ---------- divisions ----------

def rebels_for(side_a, side_b, label_a, label_b, min_party=8, threshold=2 / 3):
    """Members who voted against the way at least two-thirds of their
    party voted, in parties with at least min_party voters."""
    by_party = defaultdict(lambda: {label_a: [], label_b: []})
    for m in side_a:
        by_party[m.get("Party") or m.get("party") or ""][label_a].append(m)
    for m in side_b:
        by_party[m.get("Party") or m.get("party") or ""][label_b].append(m)
    rebels = []
    for party, sides in by_party.items():
        if not party or party in ("Crossbench", "Non-affiliated", "Bishops", "Independent", "Speaker"):
            continue
        total = len(sides[label_a]) + len(sides[label_b])
        if total < min_party:
            continue
        for label, other in ((label_a, label_b), (label_b, label_a)):
            if len(sides[other]) / total >= threshold:
                for m in sides[label]:
                    rebels.append({
                        "name": m.get("Name") or m.get("name") or "",
                        "memberId": m.get("MemberId") or m.get("memberId"),
                        "party": PARTY_SHORT.get(party, m.get("PartyAbbreviation") or m.get("partyAbbreviation") or party),
                        "voted": label,
                    })
    return sorted(rebels, key=lambda r: (r["party"], r["name"]))


def build_commons_divisions(day):
    rows = try_json(f"{CVOTES}/data/divisions.json/search", {"startDate": day, "endDate": day}, []) or []
    out = []
    for r in rows:
        if (r.get("Date") or "")[:10] != day:
            continue
        d = try_json(f"{CVOTES}/data/division/{r['DivisionId']}.json") or r
        ayes, noes = d.get("Ayes") or [], d.get("Noes") or []
        out.append({
            "id": r["DivisionId"],
            "number": r.get("Number"),
            "time": (r.get("Date") or "")[11:16] if good_time(r.get("Date")) else None,
            "title": (r.get("Title") or "").strip(),
            "ayes": r.get("AyeCount"), "noes": r.get("NoCount"),
            "result": "Ayes" if (r.get("AyeCount") or 0) > (r.get("NoCount") or 0) else "Noes",
            "deferred": bool(r.get("IsDeferred")),
            "rebels": rebels_for(ayes, noes, "Aye", "No"),
            "link": f"https://votes.parliament.uk/votes/commons/division/{r['DivisionId']}",
        })
    return out


def build_lords_divisions(day):
    rows = try_json(f"{LVOTES}/data/Divisions/search", {"startDate": day, "endDate": day}, []) or []
    out = []
    for r in rows:
        if (r.get("date") or "")[:10] != day:
            continue
        d = try_json(f"{LVOTES}/data/Divisions/{r['divisionId']}") or r
        c, n = d.get("contents") or [], d.get("notContents") or []
        cc, nc = r.get("authoritativeContentCount") or 0, r.get("authoritativeNotContentCount") or 0
        out.append({
            "id": r["divisionId"],
            "number": r.get("number"),
            "time": None,
            "title": (r.get("title") or "").strip(),
            "ayes": cc, "noes": nc,
            "result": "Contents" if cc > nc else "Not Contents",
            "governmentWin": r.get("isGovernmentWin"),
            "rebels": rebels_for(c, n, "Content", "Not Content"),
            "link": f"https://votes.parliament.uk/votes/lords/division/{r['divisionId']}",
        })
    return out


# ---------- the rest of the day ----------

def build_written(house, day):
    st = try_json(f"{QS}/api/writtenstatements/statements",
                  {"madeWhenFrom": day, "madeWhenTo": day, "house": house, "expandMember": "true", "take": 100}, {}) or {}
    statements = []
    for it in st.get("results") or []:
        v = it.get("value") or {}
        uin = (v.get("uin") or "").lower()
        m = v.get("member") or {}
        statements.append({
            "title": v.get("title") or "",
            "department": v.get("answeringBodyName") or "",
            "member": m.get("name") or v.get("memberRole") or "",
            "link": f"https://questions-statements.parliament.uk/written-statements/detail/{day}/{uin}",
        })
    answered = try_json(f"{QS}/api/writtenquestions/questions",
                        {"answeredWhenFrom": day, "answeredWhenTo": day, "house": house, "take": 1}, {}) or {}
    return statements, answered.get("totalResults") or 0


def build_committees(day):
    """Public oral evidence held that day, and reports published."""
    ev = try_json(f"{COMMITTEES}/api/Events", {
        "StartDateFrom": day, "StartDateTo": day, "IncludeEventAttendees": "true",
        "ShowOnWebsiteOnly": "true", "ExcludeCancelledEvents": "true", "SortAscending": "true", "Take": 100,
    }, {}) or {}
    sessions = []
    for e in ev.get("items") or []:
        panels = [a for a in e.get("activities") or [] if a.get("activityType") == "Oral evidence" and not a.get("isPrivate")]
        if not panels:
            continue
        business = next((b for a in panels for b in (a.get("committeeBusinesses") or [])), {}) or {}
        witnesses = []
        for a in panels:
            for w in sorted(a.get("attendees") or [], key=lambda x: x.get("displayOrder") or 0):
                orgs = ", ".join(o.get("name") for o in w.get("organisations") or [] if o.get("name"))
                witnesses.append({"name": w.get("name") or "", "org": orgs})
        start = panels[0].get("startDate") or e.get("startDate") or ""
        sessions.append({
            "id": e["id"],
            "time": start[11:16],
            "committee": ", ".join(c.get("name") for c in e.get("committees") or [] if c.get("name")),
            "house": (e.get("committees") or [{}])[0].get("house") or "",
            "inquiry": business.get("title") or "",
            "inquiryId": business.get("id"),
            "witnesses": witnesses,
            "link": f"https://api.parliament.uk/committees/events/{e['id']}",
        })
    pubs = try_json(f"{COMMITTEES}/api/Publications", {
        "StartDate": day, "EndDate": day, "ShowOnWebsiteOnly": "true", "Take": 100,
    }, {}) or {}
    reports = []
    for p in pubs.get("items") or []:
        tname = (p.get("type") or {}).get("name") or ""
        if tname not in ("Report", "Special Report", "Government Response", "Government response"):
            continue
        docs = p.get("documents") or []
        doc = docs[0].get("documentId") if docs else None
        link = f"https://committees.parliament.uk/publications/{p['id']}/documents/{doc}/report/" if doc else f"https://committees.parliament.uk/publications/{p['id']}/"
        reports.append({
            "title": (p.get("description") or "").strip(),
            "type": tname,
            "committee": (p.get("committee") or {}).get("name") or "",
            "inquiry": ((p.get("businesses") or [{}])[0].get("title") or ""),
            "link": link,
        })
    return sessions, reports


def build_bills(day, stages_cache, bills_cache):
    sit = try_json(f"{BILLS}/api/v1/Sittings", {"DateFrom": day, "DateTo": day}, {}) or {}
    out = []
    seen = set()
    for s in sit.get("items") or []:
        bid = s.get("billId")
        if not bid or (bid, s.get("stageId")) in seen:
            continue
        seen.add((bid, s.get("stageId")))
        if str(bid) not in bills_cache:
            b = try_json(f"{BILLS}/api/v1/Bills/{bid}") or {}
            bills_cache[str(bid)] = {"title": b.get("shortTitle") or "", "isGovernment": b.get("isGovernmentBill")}
        st = stages_cache.get(str(s.get("stageId")), {})
        out.append({
            "billId": bid,
            "title": bills_cache[str(bid)]["title"],
            "government": bills_cache[str(bid)].get("isGovernment"),
            "stage": st.get("name") or "",
            "house": st.get("house") or "",
            "link": f"https://bills.parliament.uk/bills/{bid}",
        })
    return [b for b in out if b["title"]]


def load_stages():
    data = try_json(f"{BILLS}/api/v1/Stages", {"take": 100}, {}) or {}
    return {str(s["id"]): {"name": s.get("name") or "", "house": s.get("house") or ""} for s in data.get("items") or []}


# ---------- spikes ----------

def baseline_for(house, before_day, n=BASELINE_DAYS):
    uni, bi, words = Counter(), Counter(), 0
    days = 0
    for f in sorted(VOCAB_DIR.glob(f"????-??-??-{house}.json"), reverse=True):
        if f.stem[:10] >= before_day:
            continue
        try:
            v = json.loads(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        uni.update(v.get("uni") or {})
        bi.update(v.get("bi") or {})
        words += v.get("words") or 0
        days += 1
        if days >= n:
            break
    return uni, bi, words, days


def spikes_for(vocab, baseline):
    b_uni, b_bi, b_words, b_days = baseline
    today_words = vocab["words"] or 1
    cands = []

    def score(term, c, base_counts, min_count):
        if c < min_count:
            return None
        if any(p in term.split() for p in PARTY_WORDS):
            return None
        rate_t = c / today_words
        rate_b = (base_counts.get(term, 0) + 0.5) / (b_words + 1000)
        ratio = rate_t / rate_b
        if ratio < 3:
            return None
        return {"term": vocab["surface"].get(term, term), "key": term, "count": c,
                "ratio": round(ratio, 1), "score": math.log(ratio) * math.sqrt(c)}

    for t, c in vocab["bi"].items():
        s = score(t, c, b_bi, 3)
        if s:
            cands.append(s)
    for t, c in vocab["uni"].items():
        s = score(t, c, b_uni, 4)
        if s:
            cands.append(s)
    cands.sort(key=lambda s: -s["score"])
    out, used = [], set()
    for s in cands:
        parts = set(s["key"].split())
        # A unigram already inside a chosen bigram adds nothing, and
        # neither does the plural of a word already chosen.
        if len(parts) == 1 and any(parts <= set(u.split()) and u != s["key"] for u in used):
            continue
        key = s["key"]
        if key + "s" in used or key.endswith("s") and key[:-1] in used:
            continue
        used.add(s["key"])
        out.append({k: v for k, v in s.items() if k != "score"})
        if len(out) >= SPIKES_KEEP:
            break
    return out, b_days


# ---------- assembling a day ----------

def build_day(day, houses, members_cache, stages_cache, bills_cache):
    print(f"Building {day}")
    out = {"date": day, "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "houses": {}}
    committees_done = None
    for house in houses:
        print(f"  {house}: Hansard")
        h = build_hansard(house, day, members_cache)
        if not h:
            print(f"  {house}: no sitting found")
            continue
        print(f"    {len(h['sections'])} sections, {h['numbers']['words']} words")
        h["divisions"] = build_commons_divisions(day) if house == "Commons" else build_lords_divisions(day)
        h["writtenStatements"], h["writtenAnswers"] = build_written(house, day)
        h["numbers"]["divisions"] = len(h["divisions"])
        h["numbers"]["writtenStatements"] = len(h["writtenStatements"])
        h["numbers"]["writtenAnswers"] = h["writtenAnswers"]
        baseline = baseline_for(house, day)
        h["spikes"], h["baselineDays"] = spikes_for(h["vocab"], baseline)
        vocab = h.pop("vocab")
        VOCAB_DIR.mkdir(exist_ok=True)
        (VOCAB_DIR / f"{day}-{house}.json").write_text(
            json.dumps({"words": vocab["words"], "uni": vocab["uni"], "bi": vocab["bi"]}, ensure_ascii=False),
            encoding="utf-8")
        out["houses"][house] = h
    if out["houses"]:
        sessions, reports = build_committees(day)
        out["committees"] = sessions
        out["reports"] = reports
        out["bills"] = build_bills(day, stages_cache, bills_cache)
    return out


def sitting_days(house, start, end):
    """Days with any spoken contribution, from Hansard's timeline."""
    data = try_json(f"{HANSARD}/timeline-stats.json", {
        "contributionType": "Spoken", "queryParameters.searchTerm": "", "queryParameters.house": house,
        "queryParameters.startDate": start, "queryParameters.endDate": end,
        "queryParameters.timelineGroupingSize": "Day",
    }, {}) or {}
    return sorted({(r.get("GroupingDate") or "")[:10] for r in data.get("Results") or [] if (r.get("Count") or 0) > 0})


def last_sitting(house):
    v = try_json(f"{HANSARD}/overview/lastsittingdate.json", {"house": house})
    return (v or "")[:10] if isinstance(v, str) else None


def write_index():
    days = []
    for f in sorted(OUT_DIR.glob("????-??-??.json"), reverse=True):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        houses = d.get("houses") or {}
        days.append({
            "date": d["date"],
            "houses": list(houses.keys()),
            "words": sum((h.get("numbers") or {}).get("words", 0) for h in houses.values()),
            "divisions": sum((h.get("numbers") or {}).get("divisions", 0) for h in houses.values()),
        })
    latest = {}
    for h in HOUSES:
        for d in days:
            if h in d["houses"]:
                latest[h] = d["date"]
                break
    INDEX_PATH.write_text(json.dumps({"latest": latest, "days": days}, ensure_ascii=False), encoding="utf-8")
    print(f"Index: {len(days)} days, latest {latest}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date")
    ap.add_argument("--backfill", type=int, default=0)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    OUT_DIR.mkdir(exist_ok=True)
    members_cache = json.loads(MEMBERS_CACHE_PATH.read_text()) if MEMBERS_CACHE_PATH.exists() else {}
    stages_cache = load_stages()
    bills_cache = {}

    today = date.today()
    targets = []
    if args.date:
        targets = [args.date]
    elif args.backfill:
        found = set()
        for house in HOUSES:
            start = (today - timedelta(days=args.backfill * 3 + 14)).isoformat()
            found.update(sitting_days(house, start, today.isoformat())[-args.backfill:])
        targets = sorted(found)
    else:
        for house in HOUSES:
            d = last_sitting(house)
            if d:
                targets.append(d)
        targets = sorted(set(targets))

    for day in targets:
        path = OUT_DIR / f"{day}.json"
        if path.exists() and not args.force and not args.date:
            age = (today - date.fromisoformat(day)).days
            if age > REBUILD_WITHIN_DAYS:
                print(f"{day}: already built, skipping")
                continue
        result = build_day(day, HOUSES, members_cache, stages_cache, bills_cache)
        if not result["houses"]:
            print(f"{day}: nothing to write")
            continue
        path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        print(f"  wrote {path.relative_to(REPO_ROOT)} ({path.stat().st_size // 1024} KB)")

    MEMBERS_CACHE_PATH.write_text(json.dumps(members_cache, ensure_ascii=False), encoding="utf-8")
    write_index()


if __name__ == "__main__":
    main()
