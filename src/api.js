// Cloudflare Worker that proxies the four parliament APIs and adds CORS.
// Source: worker/src/index.js. For local dev, run `wrangler dev` in worker/
// and switch this to 'http://localhost:8787'.
export const PROXY = 'https://house-proxy.peter-guillam.workers.dev';

const HANSARD = 'https://hansard-api.parliament.uk';
const QS = 'https://questions-statements-api.parliament.uk';
const MEMBERS = 'https://members-api.parliament.uk';

function viaProxy(upstream) {
  return `${PROXY}/?u=${encodeURIComponent(upstream)}`;
}

function buildHansardSearch(path, opts) {
  const p = new URLSearchParams();
  if (opts.searchTerm) p.set('queryParameters.searchTerm', opts.searchTerm);
  if (opts.startDate) p.set('queryParameters.startDate', opts.startDate);
  if (opts.endDate) p.set('queryParameters.endDate', opts.endDate);
  if (opts.house && opts.house !== 'Both') p.set('queryParameters.house', opts.house);
  // Hansard's `queryParameters.memberIds` (plural) is silently ignored by
  // the search endpoints — only the singular `memberId` works. We never
  // pass more than one anyway (party filter is client-side).
  const id = opts.memberId ?? (opts.memberIds && opts.memberIds[0]);
  if (id != null) p.set('queryParameters.memberId', String(id));
  p.set('queryParameters.take', String(opts.take ?? 20));
  p.set('queryParameters.skip', String(opts.skip ?? 0));
  p.set('queryParameters.orderBy', 'SittingDateDesc');
  return `${HANSARD}${path}?${p.toString()}`;
}

async function getJson(url) {
  const r = await fetch(viaProxy(url));
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on ${url}`);
  return r.json();
}

// ---------- Hansard: timeline-stats (per-month counts) ----------

// Returns monthly counts for a search across the date range. Single call
// regardless of how big the result is — drives the Deep Dive bar chart.
export async function timelineStats(opts) {
  const p = new URLSearchParams();
  p.set('queryParameters.searchTerm', opts.searchTerm || '');
  if (opts.startDate) p.set('queryParameters.startDate', opts.startDate);
  if (opts.endDate)   p.set('queryParameters.endDate',   opts.endDate);
  if (opts.house && opts.house !== 'Both') p.set('queryParameters.house', opts.house);
  p.set('queryParameters.timelineGroupingSize', opts.grouping || 'Month');
  const contributionType = opts.contributionType || 'Spoken';
  const url = `${HANSARD}/timeline-stats.json?contributionType=${encodeURIComponent(contributionType)}&${p.toString()}`;
  const data = await getJson(url);
  return {
    total: data.TotalResultCount ?? 0,
    buckets: (data.Results ?? []).map((r) => ({
      month: (r.GroupingDate || '').slice(0, 7),
      count: r.Count ?? 0,
    })),
  };
}

// ---------- Hansard: spoken contributions ----------

export async function searchSpoken(opts) {
  const url = buildHansardSearch('/search/contributions/Spoken.json', opts);
  const data = await getJson(url);
  return {
    total: data.TotalResultCount ?? 0,
    items: (data.Results ?? []).map((r) => hansardContribution('Spoken', opts.searchTerm, r)),
  };
}

// ---------- Hansard: written contributions in Hansard (incl. WMS) ----------

export async function searchWrittenHansard(opts) {
  const url = buildHansardSearch('/search/contributions/Written.json', opts);
  const data = await getJson(url);
  return {
    total: data.TotalResultCount ?? 0,
    items: (data.Results ?? []).map((r) => hansardContribution('Written', opts.searchTerm, r)),
  };
}

// ---------- Hansard: committee debates (Public Bill, Westminster Hall etc.) ----------

export async function searchCommitteeDebates(opts) {
  const url = buildHansardSearch('/search/committeedebates.json', opts);
  const data = await getJson(url);
  return {
    total: data.TotalResultCount ?? 0,
    items: (data.Results ?? []).map((r) => hansardContribution('Committee', opts.searchTerm, r)),
  };
}

// Hansard's AttributedTo comes in two flavours:
//   "Apsana Begum (Poplar and Limehouse) (Lab)"   — backbenchers / Lords
//   "The Minister for Secondary Care (Karin Smyth)" — ministers (role-led)
// We only want to extract a *party* from the trailing parens — never a name.
// A whitelist is the only safe way to tell them apart.
const KNOWN_PARTIES = new Set([
  'Lab', 'Labour', 'Lab/Co-op', 'Co-op', 'Lab Co-op',
  'Con', 'Conservative', 'Conservative Independent',
  'LD', 'Lib Dem', 'Liberal Democrat',
  'SNP', 'Reform', 'Reform UK',
  'Green', 'Green Party',
  'DUP', 'UUP', 'TUV',
  'PC', 'Plaid Cymru',
  'SF', 'Sinn Féin', 'SF (Sinn Féin)',
  'SDLP', 'Alliance', 'APNI',
  'Ind', 'Independent',
  'CB', 'Crossbench',
  'Bishops', 'Bishop', 'Lord Bishop',
  'Speaker',
  'Non-Afl', 'Non-affiliated',
  'UKIP',
]);

function parseAttribution(attribution) {
  if (!attribution) return { display: '', party: '' };
  const matches = [...attribution.matchAll(/\(([^()]+)\)/g)];
  if (!matches.length) return { display: attribution, party: '' };
  const last = matches[matches.length - 1];
  const inside = last[1].trim();
  if (KNOWN_PARTIES.has(inside)) {
    return {
      display: attribution.slice(0, last.index).trim(),
      party: inside,
    };
  }
  return { display: attribution, party: '' };
}

function hansardContribution(source, searchTerm, r) {
  const date = r.SittingDate ? r.SittingDate.slice(0, 10) : '';
  const debateExt = r.DebateSectionExtId || '';
  const contribExt = r.ContributionExtId || '';
  const house = (r.House || '').toLowerCase();
  const fullText = stripHtml(r.ContributionTextFull || r.ContributionText || '');
  let link = 'https://hansard.parliament.uk/';
  if (debateExt) {
    link = `https://hansard.parliament.uk/${capitalise(house)}/${date}/debates/${debateExt}/${slugify(r.DebateSection || '')}`;
    if (searchTerm) link += `?highlight=${encodeURIComponent(searchTerm)}`;
    if (contribExt) link += `#contribution-${contribExt}`;
  }
  const { display, party } = parseAttribution(r.AttributedTo || r.MemberName || '');
  return {
    source,
    id: contribExt || `${date}-${r.ItemId}`,
    date,
    house: r.House || '',
    memberId: r.MemberId || null,
    memberName: display,                       // for inline display (with constituency / role)
    shortName: r.MemberName || display,        // bare name (for leaderboards)
    party,
    title: r.DebateSection || r.Section || '',
    section: r.Section || '',
    debateExtId: debateExt,
    snippet: fullText,
    fullText,
    link,
  };
}

// ---------- Written questions API ----------

// Q&A and Statements APIs tokenise the search term and AND the words
// (so "RAF Lakenheath" matches "RAF" anywhere). Quoting forces a phrase match.
function phraseQuote(term) {
  if (!term) return term;
  const t = term.trim();
  if (/\s/.test(t) && !t.startsWith('"')) return `"${t}"`;
  return t;
}

export async function searchWrittenQuestions(opts) {
  const p = new URLSearchParams();
  if (opts.searchTerm) p.set('searchTerm', phraseQuote(opts.searchTerm));
  if (opts.startDate) p.set('answeredWhenFrom', opts.startDate);
  if (opts.endDate) p.set('answeredWhenTo', opts.endDate);
  if (opts.house && opts.house !== 'Both') p.set('house', opts.house);
  if (opts.memberIds) for (const id of opts.memberIds) p.append('members', String(id));
  p.set('expandMember', 'true');
  p.set('take', String(opts.take ?? 20));
  p.set('skip', String(opts.skip ?? 0));
  const url = `${QS}/api/writtenquestions/questions?${p.toString()}`;
  const data = await getJson(url);
  return {
    total: data.totalResults ?? 0,
    items: (data.results ?? []).map(({ value: v }) => {
      // Display the answered date (when the answer went public), but the
      // canonical URL on questions-statements.parliament.uk is keyed by the
      // tabled date and a *lowercase* UIN. UINs get reused across sessions
      // (e.g. HL15513 in 2019 and again in 2026 are different questions),
      // so the date in the URL is load-bearing.
      const date = (v.dateAnswered || v.dateTabled || '').slice(0, 10);
      const tabledDate = (v.dateTabled || v.dateAnswered || '').slice(0, 10);
      const uin = (v.uin || '').toLowerCase();
      const m = v.askingMember || {};
      const q = v.questionText || '';
      const a = v.answerText || '[unanswered]';
      return {
        source: 'Written Q',
        id: `wq-${v.id}`,
        date,
        house: v.house || '',
        memberId: v.askingMemberId,
        memberName: m.name || '',
        party: m.party || '',
        title: v.heading || v.answeringBodyName || '',
        snippet: `Q: ${q}\nA: ${a}`,
        fullText: `Q: ${q}\nA: ${a}`,
        link: `https://questions-statements.parliament.uk/written-questions/detail/${tabledDate}/${uin}`,
      };
    }),
  };
}

// ---------- Written ministerial statements ----------

export async function searchWrittenStatements(opts) {
  const p = new URLSearchParams();
  if (opts.searchTerm) p.set('searchTerm', phraseQuote(opts.searchTerm));
  if (opts.startDate) p.set('madeWhenFrom', opts.startDate);
  if (opts.endDate) p.set('madeWhenTo', opts.endDate);
  if (opts.house && opts.house !== 'Both') p.set('house', opts.house);
  if (opts.memberIds) for (const id of opts.memberIds) p.append('members', String(id));
  p.set('expandMember', 'true');
  p.set('take', String(opts.take ?? 20));
  p.set('skip', String(opts.skip ?? 0));
  const url = `${QS}/api/writtenstatements/statements?${p.toString()}`;
  const data = await getJson(url);
  return {
    total: data.totalResults ?? 0,
    items: (data.results ?? []).map(({ value: v }) => {
      // Same URL convention as written questions: lowercase UIN, dateMade
      // is the canonical key.
      const date = (v.dateMade || '').slice(0, 10);
      const uin = (v.uin || '').toLowerCase();
      const m = v.member || {};
      return {
        source: 'Written Stmt',
        id: `ws-${v.id}`,
        date,
        house: v.house || '',
        memberId: v.memberId,
        memberName: m.name || v.memberRole || '',
        party: m.party || '',
        title: v.title || '',
        snippet: stripHtml(v.text || ''),
        fullText: stripHtml(v.text || ''),
        link: `https://questions-statements.parliament.uk/written-statements/detail/${date}/${uin}`,
      };
    }),
  };
}

// ---------- Members ----------

export async function memberById(id) {
  if (!id && id !== 0) return null;
  const url = `${MEMBERS}/api/Members/${id}`;
  const data = await getJson(url);
  const v = data.value || data;
  if (!v || v.id == null) return null;
  return {
    id: v.id,
    name: v.nameDisplayAs || '',
    party: v.latestParty?.name || '',
    house: v.latestHouseMembership?.house === 1 ? 'Commons' : 'Lords',
  };
}

export async function membersByName(name) {
  if (!name || name.length < 2) return [];
  const url = `${MEMBERS}/api/Members/Search?Name=${encodeURIComponent(name)}&IsCurrentMember=true&take=10`;
  const data = await getJson(url);
  return (data.items ?? []).map((it) => ({
    id: it.value.id,
    name: it.value.nameDisplayAs,
    party: it.value.latestParty?.name || '',
    house: it.value.latestHouseMembership?.house === 1 ? 'Commons' : 'Lords',
  }));
}

// Fetch all current member IDs for a party. The Members/Search API caps page
// size at 20 and a big party (Conservative, Labour) has ~350 members across
// both houses, so we fan out and parallelise.
export async function membersByPartyId(partyId) {
  if (!partyId) return [];
  const first = await getJson(`${MEMBERS}/api/Members/Search?PartyId=${partyId}&IsCurrentMember=true&skip=0&take=20`);
  const total = first.totalResults ?? 0;
  const ids = (first.items ?? []).map((it) => it.value.id);
  if (total <= 20) return ids;
  const pages = [];
  for (let skip = 20; skip < total; skip += 20) {
    pages.push(getJson(`${MEMBERS}/api/Members/Search?PartyId=${partyId}&IsCurrentMember=true&skip=${skip}&take=20`));
  }
  const rest = await Promise.all(pages);
  for (const data of rest) {
    for (const it of data.items ?? []) ids.push(it.value.id);
  }
  return ids;
}

export async function listCurrentParties() {
  const map = new Map();
  for (const houseId of [1, 2]) {
    const url = `${MEMBERS}/api/Parties/GetActive/${houseId}`;
    try {
      const data = await getJson(url);
      for (const it of data.items ?? []) {
        const v = it.value ?? it;
        if (v.name && v.id != null) map.set(v.id, v.name);
      }
    } catch { /* fall back to caller's default */ }
  }
  return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- helpers ----------

function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function capitalise(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}
