import {
  searchSpoken, searchWrittenQuestions, searchWrittenStatements, searchCommitteeDebates,
  memberById,
} from './api.js?v=7';
import { resolvePartyToMemberIds, getPartyList, memberAutocomplete } from './filters.js?v=6';
import { formatDate, snippetHtml, escapeHtml, SOURCE_CLASS, partyColor } from './format.js?v=5';
import { buildMarkdownExport, exportFilename, downloadMarkdown } from './export.js?v=1';

// ---------- state ----------

const state = {
  term: '',
  preset: 'year',
  customFrom: '',
  customTo: '',
  sources: new Set(['spoken', 'wq', 'ws', 'committee']),
  house: 'Both',
  party: null,
  member: null,
  pageSize: 20,
  // per-source pagination
  offsets: { spoken: 0, wq: 0, ws: 0, committee: 0 },
  totals:  { spoken: 0, wq: 0, ws: 0, committee: 0 },
  // accumulated results
  items: [],
  searchToken: 0,
};

// ---------- DOM ----------

const $form = document.getElementById('search-form');
const $q = document.getElementById('q');
const $status = document.getElementById('status');
const $results = document.getElementById('results');
const $more = document.getElementById('load-more');
const $datePresets = document.getElementById('date-presets');
const $customDates = document.getElementById('custom-dates');
const $fromDate = document.getElementById('from-date');
const $toDate = document.getElementById('to-date');
const $sources = document.getElementById('sources');
const $house = document.getElementById('house');
const $party = document.getElementById('party');
const $memberInput = document.getElementById('member-input');
const $memberSuggestions = document.getElementById('member-suggestions');
const $selectedMember = document.getElementById('selected-member');
const $selectedMemberLabel = document.getElementById('selected-member-label');
const $clearMember = document.getElementById('clear-member');
const $exportBtn = document.getElementById('export-md');

// ---------- filter wiring ----------

$datePresets.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-preset]');
  if (!btn) return;
  for (const b of $datePresets.querySelectorAll('button')) {
    b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
  }
  state.preset = btn.dataset.preset;
  $customDates.hidden = state.preset !== 'custom';
});

$sources.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-source]');
  if (!btn) return;
  const s = btn.dataset.source;
  if (state.sources.has(s)) state.sources.delete(s);
  else state.sources.add(s);
  btn.setAttribute('aria-pressed', state.sources.has(s) ? 'true' : 'false');
});

$house.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-house]');
  if (!btn) return;
  for (const b of $house.querySelectorAll('button')) {
    b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
  }
  state.house = btn.dataset.house;
});

$party.addEventListener('change', () => {
  const opt = $party.selectedOptions[0];
  state.party = opt && opt.value ? { id: Number(opt.value), name: opt.textContent } : null;
});

memberAutocomplete($memberInput, (members) => {
  $memberSuggestions.innerHTML = '';
  if (!members.length) { $memberSuggestions.hidden = true; return; }
  for (const m of members) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.innerHTML = `${escapeHtml(m.name)} <span class="meta">${escapeHtml(m.party)} · ${escapeHtml(m.house)}</span>`;
    li.addEventListener('click', () => selectMember(m));
    li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') selectMember(m); });
    $memberSuggestions.appendChild(li);
  }
  $memberSuggestions.hidden = false;
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.member-box')) $memberSuggestions.hidden = true;
});

function selectMember(m) {
  state.member = m;
  $selectedMemberLabel.textContent = `${m.name} (${m.party})`;
  $selectedMember.hidden = false;
  $memberInput.value = '';
  $memberInput.hidden = true;
  $memberSuggestions.hidden = true;
}
$clearMember.addEventListener('click', () => {
  state.member = null;
  $selectedMember.hidden = true;
  $memberInput.hidden = false;
  $memberInput.focus();
});

// ---------- shareable URLs ----------

const ALL_SOURCES = ['spoken', 'wq', 'ws', 'committee'];

function buildUrlFromState() {
  const p = new URLSearchParams();
  if (state.term) p.set('q', state.term);
  if (state.preset && state.preset !== 'year') p.set('range', state.preset);
  if (state.preset === 'custom') {
    const from = state.customFrom || $fromDate.value;
    const to = state.customTo || $toDate.value;
    if (from) p.set('from', from);
    if (to) p.set('to', to);
  }
  // omit sources param if all four are on (the default)
  if (state.sources.size !== ALL_SOURCES.length || ALL_SOURCES.some(s => !state.sources.has(s))) {
    p.set('sources', [...state.sources].join(','));
  }
  if (state.house && state.house !== 'Both') p.set('house', state.house);
  if (state.party) p.set('party', String(state.party.id));
  if (state.member) p.set('member', String(state.member.id));
  return p.toString();
}

function pushUrlState() {
  const qs = buildUrlFromState();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  // Don't pollute history with duplicates
  if (url === location.pathname + location.search) return;
  history.pushState({ houseSearch: true }, '', url);
}

// Apply ?q= ?range= … to state + DOM. Returns true if there's a term to search.
async function applyParamsFromUrl() {
  const p = new URLSearchParams(location.search);

  // term
  const q = p.get('q') || '';
  state.term = q;
  $q.value = q;

  // date range
  const range = p.get('range');
  const validRanges = ['month', 'year', 'five', 'custom'];
  state.preset = validRanges.includes(range) ? range : 'year';
  for (const b of $datePresets.querySelectorAll('button')) {
    b.setAttribute('aria-checked', b.dataset.preset === state.preset ? 'true' : 'false');
  }
  $customDates.hidden = state.preset !== 'custom';
  state.customFrom = ''; state.customTo = '';
  $fromDate.value = ''; $toDate.value = '';
  if (state.preset === 'custom') {
    const from = p.get('from'); if (from) { state.customFrom = from; $fromDate.value = from; }
    const to = p.get('to'); if (to) { state.customTo = to; $toDate.value = to; }
  }

  // sources
  const sources = p.get('sources');
  state.sources = sources
    ? new Set(sources.split(',').filter(s => ALL_SOURCES.includes(s)))
    : new Set(ALL_SOURCES);
  for (const b of $sources.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', state.sources.has(b.dataset.source) ? 'true' : 'false');
  }

  // house
  const house = p.get('house');
  state.house = (house === 'Commons' || house === 'Lords') ? house : 'Both';
  for (const b of $house.querySelectorAll('button')) {
    b.setAttribute('aria-checked', b.dataset.house === state.house ? 'true' : 'false');
  }

  // party (the dropdown is populated async; we wait for the option to exist)
  const partyId = p.get('party');
  state.party = null;
  $party.value = 'Any';
  if (partyId) {
    const opt = Array.from($party.options).find(o => o.value === partyId);
    if (opt) {
      $party.value = partyId;
      state.party = { id: Number(partyId), name: opt.textContent };
    }
  }

  // member — fetch by ID so we can populate the chip
  state.member = null;
  $selectedMember.hidden = true;
  $memberInput.hidden = false;
  $memberInput.value = '';
  const memberIdParam = p.get('member');
  if (memberIdParam) {
    try {
      const m = await memberById(Number(memberIdParam));
      if (m) selectMember(m);
    } catch (e) {
      console.warn('member restore failed', e);
    }
  }

  return !!q;
}

window.addEventListener('popstate', () => {
  applyParamsFromUrl().then((hasQuery) => {
    if (hasQuery) {
      freshSearch(false);
    } else {
      // empty URL — clear results
      state.items = [];
      state.offsets = { spoken: 0, wq: 0, ws: 0, committee: 0 };
      state.totals  = { spoken: 0, wq: 0, ws: 0, committee: 0 };
      $results.innerHTML = '';
      setStatus('');
      $more.hidden = true;
    }
  });
});

// ---------- search ----------

function freshSearch(pushUrl) {
  state.term = $q.value.trim();
  if (!state.term) {
    setStatus('Enter a search term to start.');
    $results.innerHTML = '';
    $more.hidden = true;
    return;
  }
  state.items = [];
  state.offsets = { spoken: 0, wq: 0, ws: 0, committee: 0 };
  state.totals = { spoken: 0, wq: 0, ws: 0, committee: 0 };
  $results.innerHTML = '';
  if (pushUrl) pushUrlState();
  runSearch(true);
}

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  freshSearch(true);
});

$more.addEventListener('click', () => runSearch(false));

// ---------- init: load parties, then apply URL state ----------

(async () => {
  try {
    const parties = await getPartyList();
    for (const { id, name } of parties) {
      const opt = document.createElement('option');
      opt.value = String(id); opt.textContent = name;
      $party.appendChild(opt);
    }
  } catch (e) { console.warn('party list failed', e); }

  try {
    const hasQuery = await applyParamsFromUrl();
    if (hasQuery) freshSearch(false);
  } catch (e) { console.warn('URL state restore failed', e); }
})();

function dateRange() {
  if (state.preset === 'custom') return { startDate: state.customFrom || $fromDate.value, endDate: state.customTo || $toDate.value };
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  const start = new Date(today);
  if (state.preset === 'month') start.setMonth(start.getMonth() - 1);
  else if (state.preset === 'year') start.setFullYear(start.getFullYear() - 1);
  else if (state.preset === 'five') start.setFullYear(start.getFullYear() - 5);
  return { startDate: start.toISOString().slice(0, 10), endDate: end };
}

async function runSearch(isFresh) {
  const myToken = ++state.searchToken;
  setStatus('Searching…');
  $more.hidden = true;
  $form.classList.add('is-loading');

  try {
  const { startDate, endDate } = dateRange();
  const baseOpts = {
    searchTerm: state.term, startDate, endDate,
    house: state.house, take: state.pageSize,
  };

  // Pinning to one member: send the ID to the API. Pinning to a party can be
  // hundreds of IDs (Conservative ≈ 350) which blows past server URL limits,
  // so we resolve the party once and filter client-side.
  let memberIds = null;
  let partyIdSet = null;
  if (state.member) {
    memberIds = [state.member.id];
  } else if (state.party) {
    setStatus(`Resolving ${state.party.name} members…`);
    try {
      const ids = await resolvePartyToMemberIds(state.party.id);
      if (myToken !== state.searchToken) return;
      if (!ids.length) {
        setStatus(`No current members found for ${state.party.name}.`);
        return;
      }
      partyIdSet = new Set(ids);
    } catch (e) {
      setStatus('Could not resolve party members. Try again.', true);
      return;
    }
  }

  // When filtering client-side, fetch larger pages so we keep some results.
  const take = partyIdSet ? 50 : state.pageSize;
  const fetchOpts = { ...baseOpts, take };

  const fetchers = [];
  if (state.sources.has('spoken'))    fetchers.push(['spoken',    () => searchSpoken({ ...fetchOpts, skip: state.offsets.spoken, memberIds })]);
  if (state.sources.has('wq'))        fetchers.push(['wq',        () => searchWrittenQuestions({ ...fetchOpts, skip: state.offsets.wq, memberIds })]);
  if (state.sources.has('ws'))        fetchers.push(['ws',        () => searchWrittenStatements({ ...fetchOpts, skip: state.offsets.ws, memberIds })]);
  if (state.sources.has('committee')) fetchers.push(['committee', () => searchCommitteeDebates({ ...fetchOpts, skip: state.offsets.committee, memberIds })]);

  if (!fetchers.length) {
    setStatus('Pick at least one source.');
    return;
  }

  const results = await Promise.allSettled(fetchers.map(([, fn]) => fn()));
  if (myToken !== state.searchToken) return;

  let scannedThisRun = 0;
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    const [key] = fetchers[i];
    const r = results[i];
    if (r.status === 'fulfilled') {
      state.totals[key] = r.value.total;
      state.offsets[key] += r.value.items.length;
      scannedThisRun += r.value.items.length;
      const filtered = partyIdSet
        ? r.value.items.filter((it) => it.memberId && partyIdSet.has(it.memberId))
        : r.value.items;
      state.items.push(...filtered);
    } else {
      errors.push(`${key}: ${r.reason?.message || 'failed'}`);
    }
  }

  state.items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  scheduleRender();

  const totalAvailable = Object.values(state.totals).reduce((a, b) => a + b, 0);
  const haveMore = ['spoken', 'wq', 'ws', 'committee']
    .filter((k) => state.sources.has(k))
    .some((k) => state.offsets[k] < state.totals[k]);
  $more.hidden = !haveMore;

  if (errors.length) {
    setStatus(`Showing ${state.items.length} results. Some sources failed: ${errors.join('; ')}.`, true);
  } else if (state.items.length === 0) {
    if (partyIdSet) {
      setStatus(`No matches from ${state.party.name} in the first ${scannedThisRun} hits. Try "Load more" or broaden filters.`);
    } else {
      setStatus(`No results. Try broadening the date range or removing filters.`);
    }
  } else if (partyIdSet) {
    setStatus(`Showing ${state.items.length} ${state.party.name} results from the first ${state.offsets.spoken + state.offsets.wq + state.offsets.ws + state.offsets.committee} hits (${totalAvailable} hits total before party filter).`);
  } else {
    setStatus(`Showing ${state.items.length} of ${totalAvailable} results.`);
  }

  // After a fresh search, slide down to the results so the user sees them
  // (the hero + filter shell can push results below the fold on desktop).
  // Skip on Load more — that would yank the page back up.
  if (isFresh && state.items.length > 0) {
    requestAnimationFrame(() => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      $status.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    });
  }
  } finally {
    // Only clear the bar if this run is still the current one — otherwise a
    // newer search is already running and owns the bar.
    if (myToken === state.searchToken) $form.classList.remove('is-loading');
  }
}

// ---------- render ----------

let renderRaf = 0;
function scheduleRender() {
  if (renderRaf) cancelAnimationFrame(renderRaf);
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    renderResults();
  });
}

function renderResults() {
  const frag = document.createDocumentFragment();
  for (const item of state.items) {
    const li = document.createElement('li');
    li.className = 'result';
    const cls = SOURCE_CLASS[item.source] || '';
    const memberBit = item.memberName
      ? `<span class="result-member">${escapeHtml(item.memberName)}</span>`
      : '<span class="result-member muted">No attribution</span>';
    const partyBit = item.party
      ? `<span class="party-tag" style="--c:${partyColor(item.party)}">${escapeHtml(item.party)}</span>`
      : '';
    const houseBit = item.house ? `<span class="house-tag">${escapeHtml(item.house)}</span>` : '';
    li.innerHTML = `
      <h2 class="result-title"><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener">${escapeHtml(item.title || '(untitled)')}</a></h2>
      <div class="result-meta">
        <span class="badge ${cls}">${escapeHtml(item.source)}</span>
        <span class="result-date">${escapeHtml(formatDate(item.date))}</span>
        ${memberBit}
        ${partyBit}
        ${houseBit}
      </div>
      <p class="result-snippet">${snippetHtml(item.snippet || item.fullText, state.term)}</p>
    `;
    frag.appendChild(li);
  }
  $results.replaceChildren(frag);
  $exportBtn.hidden = state.items.length === 0;
}

// ---------- export ----------

function describeDateRange() {
  const presetLabels = { month: 'Last month', year: 'Last year', five: 'Last 5 years' };
  if (state.preset === 'custom') {
    const { startDate, endDate } = dateRange();
    return `${formatDate(startDate)} – ${formatDate(endDate)}`;
  }
  return presetLabels[state.preset] || '';
}

function describeSearchFilters() {
  const parts = [];
  const allSources = ['spoken', 'wq', 'ws', 'committee'];
  if (state.sources.size && state.sources.size !== allSources.length) {
    const labels = { spoken: 'Spoken', wq: 'Written Q', ws: 'Written Stmt', committee: 'Committee' };
    parts.push(`Sources: ${[...state.sources].map((s) => labels[s] || s).join(', ')}`);
  }
  if (state.house && state.house !== 'Both') parts.push(`House: ${state.house}`);
  if (state.party) parts.push(`Party: ${state.party.name}`);
  if (state.member) parts.push(`Member: ${state.member.name}`);
  return parts.join(' · ');
}

$exportBtn.addEventListener('click', () => {
  const md = buildMarkdownExport({
    pageTitle: 'Search export',
    term: state.term,
    dateRange: describeDateRange(),
    filtersLabel: describeSearchFilters(),
    recreateUrl: location.href,
    items: state.items,
  });
  downloadMarkdown(exportFilename('house-search', state.term), md);
});

function setStatus(msg, isError = false) {
  $status.textContent = msg;
  $status.classList.toggle('error', !!isError);
}

setStatus('');
