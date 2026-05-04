import {
  searchSpoken, searchWrittenQuestions, searchWrittenStatements, searchCommitteeDebates,
} from './api.js?v=3';
import { resolvePartyToMemberIds, getPartyList, memberAutocomplete } from './filters.js?v=3';
import { formatDate, snippetHtml, escapeHtml, SOURCE_CLASS } from './format.js?v=3';

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

// ---------- party list ----------

(async () => {
  try {
    const parties = await getPartyList();
    for (const { id, name } of parties) {
      const opt = document.createElement('option');
      opt.value = String(id); opt.textContent = name;
      $party.appendChild(opt);
    }
  } catch (e) { console.warn('party list failed', e); }
})();

// ---------- search ----------

$form.addEventListener('submit', (e) => {
  e.preventDefault();
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
  runSearch(true);
});

$more.addEventListener('click', () => runSearch(false));

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
    const partyBit = item.party ? ` (${escapeHtml(item.party)})` : '';
    const houseBit = item.house ? ` · ${escapeHtml(item.house)}` : '';
    const memberBit = item.memberName
      ? `${escapeHtml(item.memberName)}${partyBit}`
      : '<span class="muted">No attribution</span>';
    li.innerHTML = `
      <h2 class="result-title"><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener">${escapeHtml(item.title || '(untitled)')}</a></h2>
      <div class="result-meta">
        <span class="badge ${cls}">${escapeHtml(item.source)}</span>
        <span>${memberBit}</span>
        <span>${escapeHtml(formatDate(item.date))}${houseBit}</span>
      </div>
      <p class="result-snippet">${snippetHtml(item.snippet || item.fullText, state.term)}</p>
    `;
    frag.appendChild(li);
  }
  $results.replaceChildren(frag);
}

function setStatus(msg, isError = false) {
  $status.textContent = msg;
  $status.classList.toggle('error', !!isError);
}

setStatus('');
