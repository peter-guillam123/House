// House — Deep Dive
// One ranked monthly grid of how parliament has discussed a term over time,
// with party stacking, top members and top debates filling in as the data
// streams. Hansard /timeline-stats gives the overall shape in one call;
// each month is then fetched in parallel (concurrency 4) for the
// individual contributions feeding the leaderboards and headline list.

import { timelineStats, searchSpoken, memberById } from './api.js?v=7';
import { formatDate, snippetHtml, escapeHtml, partyColor, unquoteTerm } from './format.js?v=5';
import { buildMarkdownExport, exportFilename, downloadMarkdown } from './export.js?v=1';

// ---------- config -----------------------------------------------------

const CONCURRENCY = 4;          // parallel month fetches
const PER_MONTH = 50;           // contributions sampled per month
const MAX_HEADLINES = 1500;     // hard cap for the headline list

// ---------- state ------------------------------------------------------

const state = {
  term: '',
  preset: 'year',           // 'month' | 'year' | 'five' | 'custom'
  customFrom: '',
  customTo: '',
  house: 'Both',            // 'Both' | 'Commons' | 'Lords'
  // Resolved range for the current dive — set in runDive, used by render.
  startDate: '',
  endDate: '',
  cancelToken: 0,
  // Filled by /timeline-stats (definitive monthly totals)
  monthlyTotals: new Map(),    // 'YYYY-MM' → total spoken count
  // Filled progressively as each month's contributions arrive
  monthlyByParty: new Map(),   // 'YYYY-MM' → Map<party, count>
  byMember: new Map(),         // memberId → { name, party, count, link }
  byDebate: new Map(),         // debateExtId → { title, link, count }
  headlines: [],               // flat-copied items, newest first
  totalContributions: 0,       // sum of all monthly totals
  monthsTotal: 0,
  monthsLoaded: 0,
  // Click-to-filter — the leaderboards, legend, co-terms panel and
  // chart bars all double as filter surfaces. AND-combined across the
  // five axes.
  filters: {
    memberIds: new Set(),      // Set<number>
    debateIds: new Set(),      // Set<string>
    parties:   new Set(),      // Set<string>
    terms:     new Set(),      // Set<string> — phrases from the co-terms panel
    months:    new Set(),      // Set<string> — 'YYYY-MM' from chart bar clicks
  },
};

// ---------- DOM refs ---------------------------------------------------

const $form          = document.getElementById('dd-form');
const $q             = document.getElementById('dd-q');
const $datePresets   = document.getElementById('dd-date-presets');
const $customDates   = document.getElementById('dd-custom-dates');
const $fromDate      = document.getElementById('dd-from-date');
const $toDate        = document.getElementById('dd-to-date');
const $house         = document.getElementById('dd-house');
const $ftSummary     = document.getElementById('dd-ft-summary');
const $status        = document.getElementById('dd-status');
const $statTotal     = document.getElementById('dd-stat-total');
const $statPeak      = document.getElementById('dd-stat-peak');
const $statPeakSub   = document.getElementById('dd-stat-peak-sub');
const $statFirst     = document.getElementById('dd-stat-first');
const $statFirstSub  = document.getElementById('dd-stat-first-sub');
const $statLast      = document.getElementById('dd-stat-last');
const $statLastSub   = document.getElementById('dd-stat-last-sub');
const $chart       = document.getElementById('dd-chart');
const $legend      = document.getElementById('dd-legend');
const $caveat      = document.getElementById('dd-caveat');
const $topMembers  = document.getElementById('dd-top-members');
const $topDebates  = document.getElementById('dd-top-debates');
const $coTerms     = document.getElementById('dd-co-terms');
const $topMembersMore = document.getElementById('dd-top-members-more');
const $topDebatesMore = document.getElementById('dd-top-debates-more');
const $coTermsMore    = document.getElementById('dd-co-terms-more');
const $headlines   = document.getElementById('dd-headlines');
const $results     = document.getElementById('dd-results');
const $filterBar   = document.getElementById('dd-filter-bar');
const $exportBtn   = document.getElementById('dd-export-md');

function wireRankToggle(btn, list) {
  btn.addEventListener('click', () => {
    const expanded = list.classList.toggle('is-expanded');
    btn.setAttribute('aria-expanded', String(expanded));
    btn.textContent = expanded ? 'Show fewer' : 'Show all';
  });
}
wireRankToggle($topMembersMore, $topMembers);
wireRankToggle($topDebatesMore, $topDebates);
wireRankToggle($coTermsMore, $coTerms);

function resetRankToggle(btn, list) {
  list.classList.remove('is-expanded');
  btn.setAttribute('aria-expanded', 'false');
  btn.textContent = 'Show all';
  btn.hidden = true;
}

function syncRankToggle(btn, count) {
  btn.hidden = count <= 5;
}

// ---------- helpers ----------------------------------------------------

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthsInRange(startDate, endDate) {
  // Cap the end at today — guard against custom ranges in the future
  // and protect the chart from a hard right-edge gap.
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const safeEnd = endDate > todayIso ? todayIso : endDate;
  const out = [];
  let y = Number(startDate.slice(0, 4));
  let m = Number(startDate.slice(5, 7));
  const endY = Number(safeEnd.slice(0, 4));
  const endM = Number(safeEnd.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

// Resolve the active preset to a concrete { startDate, endDate } pair.
// Mirrors the equivalent in app.js so Search and Deep Dive feel the same.
function dateRange() {
  if (state.preset === 'custom') {
    return {
      startDate: state.customFrom || $fromDate.value,
      endDate:   state.customTo   || $toDate.value,
    };
  }
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  const start = new Date(today);
  if (state.preset === 'month')      start.setMonth(start.getMonth() - 1);
  else if (state.preset === 'year')  start.setFullYear(start.getFullYear() - 1);
  else if (state.preset === 'five')  start.setFullYear(start.getFullYear() - 5);
  return { startDate: start.toISOString().slice(0, 10), endDate: end };
}

function formatMonth(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return `${MONTH_NAMES[+m - 1]} ${y}`;
}

function lastDayOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

// ---------- click-to-filter -------------------------------------------

function hasFilters() {
  const f = state.filters;
  return f.memberIds.size + f.debateIds.size + f.parties.size + f.terms.size + f.months.size > 0;
}

// AND across the five axes; OR within an axis (e.g. two parties picked
// = "either party").
function matchesFilters(h) {
  const f = state.filters;
  if (f.memberIds.size && !f.memberIds.has(h.memberId)) return false;
  if (f.debateIds.size && !f.debateIds.has(h.debateExtId)) return false;
  if (f.parties.size   && !f.parties.has(h.party || 'Unknown')) return false;
  if (f.months.size && !(h.date && f.months.has(h.date.slice(0, 7)))) return false;
  if (f.terms.size) {
    const hay = ((h.fullText || h.snippet || '') + ' ' + (h.title || '')).toLowerCase();
    for (const t of f.terms) if (!hay.includes(t.toLowerCase())) return false;
  }
  return true;
}

function resetFilters() {
  state.filters.memberIds.clear();
  state.filters.debateIds.clear();
  state.filters.parties.clear();
  state.filters.terms.clear();
  state.filters.months.clear();
}

function toggleFilter(kind, value) {
  const set =
    kind === 'member' ? state.filters.memberIds :
    kind === 'debate' ? state.filters.debateIds :
    kind === 'party'  ? state.filters.parties   :
    kind === 'term'   ? state.filters.terms     :
    kind === 'month'  ? state.filters.months    : null;
  if (!set) return;
  // Member ids are numbers; keep as-is. Others stay strings.
  const v = kind === 'member' ? Number(value) : value;
  if (set.has(v)) set.delete(v); else set.add(v);
  pushUrlState();
  renderFilterBar();
  renderHeadlines();
  renderTopMembers();
  renderTopDebates();
  renderLegend();
  renderCoTerms();
  // Re-render the chart so any active-month outline reflects the new state.
  renderTimeline();
}

function clearAllFilters() {
  if (!hasFilters()) return;
  resetFilters();
  pushUrlState();
  renderFilterBar();
  renderHeadlines();
  renderTopMembers();
  renderTopDebates();
  renderLegend();
  renderCoTerms();
  renderTimeline();
}

// Event delegation — wire once at module load
$topMembers.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-member-id]');
  if (!btn) return;
  toggleFilter('member', btn.dataset.memberId);
});
$topDebates.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-debate-id]');
  if (!btn) return;
  toggleFilter('debate', btn.dataset.debateId);
});
$coTerms.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-term]');
  if (!btn) return;
  toggleFilter('term', btn.dataset.term);
});
$legend.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-party]');
  if (!btn) return;
  toggleFilter('party', btn.dataset.party);
});
$chart.addEventListener('click', (e) => {
  const g = e.target.closest('[data-month]');
  if (!g) return;
  toggleFilter('month', g.dataset.month);
});
$filterBar.addEventListener('click', (e) => {
  const clearAll = e.target.closest('[data-clear-all]');
  if (clearAll) { clearAllFilters(); return; }
  const chip = e.target.closest('[data-kind][data-value]');
  if (!chip) return;
  toggleFilter(chip.dataset.kind, chip.dataset.value);
});

// Filter wiring — preset pills, custom dates, House selector.
$datePresets.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-preset]');
  if (!btn) return;
  for (const b of $datePresets.querySelectorAll('button')) {
    b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
  }
  state.preset = btn.dataset.preset;
  $customDates.hidden = state.preset !== 'custom';
  updateFiltersSummary();
});

$fromDate.addEventListener('change', () => { state.customFrom = $fromDate.value; updateFiltersSummary(); });
$toDate.addEventListener('change',   () => { state.customTo   = $toDate.value;   updateFiltersSummary(); });

$house.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-house]');
  if (!btn) return;
  for (const b of $house.querySelectorAll('button')) {
    b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
  }
  state.house = btn.dataset.house;
  updateFiltersSummary();
});

function updateFiltersSummary() {
  const parts = [];
  const presetLabels = { month: 'Last month', year: 'Last year', five: 'Last 5 years' };
  if (state.preset === 'custom') {
    if (state.customFrom || state.customTo) parts.push(`${state.customFrom || '…'} – ${state.customTo || '…'}`);
    else parts.push('Custom range');
  } else if (presetLabels[state.preset]) {
    parts.push(presetLabels[state.preset]);
  }
  if (state.house && state.house !== 'Both') parts.push(state.house);
  $ftSummary.textContent = parts.length ? `· ${parts.join(' · ')}` : '';
}

// Reset accumulators between dives
function resetState() {
  state.monthlyTotals = new Map();
  state.monthlyByParty = new Map();
  state.byMember = new Map();
  state.byDebate = new Map();
  state.headlines = [];
  state.totalContributions = 0;
  state.monthsTotal = 0;
  state.monthsLoaded = 0;
  resetFilters();
}

// ---------- rendering: timeline chart ---------------------------------

function renderTimeline() {
  if (state.monthlyTotals.size === 0) {
    $chart.innerHTML = '';
    $legend.innerHTML = '';
    return;
  }
  const months = monthsInRange(state.startDate, state.endDate);
  const totals = months.map((m) => state.monthlyTotals.get(m) || 0);
  const peak = Math.max(...totals, 1);

  // SVG dims — viewBox lets it scale fluidly
  const W = 1000;
  const H = 220;
  const PAD_L = 36, PAD_R = 8, PAD_T = 12, PAD_B = 32;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const barW = innerW / months.length;
  const gap = Math.max(1, Math.min(2, barW * 0.18));
  const drawW = barW - gap;

  const yLabels = peak > 1
    ? `<text x="${PAD_L - 6}" y="${PAD_T + 4}" class="dd-axis" text-anchor="end">${peak.toLocaleString('en-GB')}</text>
       <text x="${PAD_L - 6}" y="${PAD_T + innerH}" class="dd-axis" text-anchor="end">0</text>`
    : '';

  // X-axis year ticks: only at January boundaries
  const xTicks = months.map((m, i) => {
    if (!m.endsWith('-01')) return '';
    const y = m.slice(0, 4);
    const x = PAD_L + i * barW + drawW / 2;
    return `<text x="${x}" y="${PAD_T + innerH + 18}" class="dd-axis" text-anchor="middle">${y}</text>`;
  }).join('');

  // Bars: each bar is a stack of party rects (or one grey rect if we
  // haven't streamed that month yet). Total height comes from
  // monthlyTotals (definitive) so the chart is "complete" from second one.
  const allPartiesSeen = new Set();
  for (const mp of state.monthlyByParty.values()) for (const p of mp.keys()) allPartiesSeen.add(p);
  const sortedParties = [...allPartiesSeen].sort((a, b) => {
    // Roughly stable order: established parties first, alphabetic within
    const order = ['Lab', 'Labour', 'Con', 'Conservative', 'LD', 'Lib Dem', 'SNP',
                   'Reform', 'Reform UK', 'Green', 'DUP', 'PC', 'Plaid Cymru',
                   'SF', 'Sinn Féin', 'Alliance', 'UUP', 'SDLP', 'Bishops',
                   'Crossbench', 'Speaker', 'Ind', 'Independent'];
    const ai = order.indexOf(a), bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const bars = months.map((m, i) => {
    const total = state.monthlyTotals.get(m) || 0;
    if (total === 0) return '';
    const x = PAD_L + i * barW;
    const totalH = (total / peak) * innerH;
    const yTop = PAD_T + innerH - totalH;
    const isActive = state.filters.months.has(m);
    // 1.5px stroke outline drawn over the bar for the active state.
    const activeOutline = isActive
      ? `<rect x="${x.toFixed(2)}" y="${yTop.toFixed(2)}" width="${drawW.toFixed(2)}" height="${totalH.toFixed(2)}" fill="none" stroke="var(--accent)" stroke-width="1.5" pointer-events="none"/>`
      : '';
    const groupClass = `dd-bar-group${isActive ? ' is-active' : ''}`;
    const byParty = state.monthlyByParty.get(m);
    if (!byParty || byParty.size === 0) {
      // Skeleton bar — we have the count but no party split yet
      return `<g data-month="${m}" class="${groupClass}"><rect x="${x.toFixed(2)}" y="${yTop.toFixed(2)}" width="${drawW.toFixed(2)}" height="${totalH.toFixed(2)}" fill="var(--rule)" class="dd-bar dd-bar-skeleton"><title>${formatMonth(m)} — ${total.toLocaleString('en-GB')} contributions (loading…)</title></rect>${activeOutline}</g>`;
    }
    // Sample-based: scale party slices to total contributed (timeline-stats truth),
    // but party PROPORTIONS come from what we sampled.
    const sampled = [...byParty.values()].reduce((a, b) => a + b, 0);
    const segs = sortedParties.map((p) => {
      const c = byParty.get(p) || 0;
      if (!c) return null;
      return { p, c };
    }).filter(Boolean);
    let runningY = yTop;
    const titleParts = [`${formatMonth(m)} — ${total.toLocaleString('en-GB')} contributions`];
    let svg = '';
    for (const { p, c } of segs) {
      const segH = (c / sampled) * totalH;
      svg += `<rect x="${x.toFixed(2)}" y="${runningY.toFixed(2)}" width="${drawW.toFixed(2)}" height="${segH.toFixed(2)}" fill="${partyColor(p)}" class="dd-bar"></rect>`;
      runningY += segH;
      titleParts.push(`${p}: ~${Math.round((c / sampled) * total)}`);
    }
    // One <title> tag inside an outer <g> so hover gives a unified tooltip
    return `<g data-month="${m}" class="${groupClass}"><title>${escapeHtml(titleParts.join(' · '))}</title>${svg}${activeOutline}</g>`;
  }).join('');

  $chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Monthly volume of contributions, party-stacked.">
    <line x1="${PAD_L}" y1="${PAD_T + innerH}" x2="${W - PAD_R}" y2="${PAD_T + innerH}" stroke="var(--rule)" />
    ${yLabels}
    ${bars}
    ${xTicks}
  </svg>`;

  renderLegend(sortedParties);
}

// Legend doubles as a party filter — chips are buttons.
function renderLegend(sortedPartiesArg) {
  const allPartiesSeen = new Set();
  const totalsByParty = new Map();
  for (const mp of state.monthlyByParty.values()) {
    for (const [p, c] of mp) {
      allPartiesSeen.add(p);
      totalsByParty.set(p, (totalsByParty.get(p) || 0) + c);
    }
  }
  const sortedParties = sortedPartiesArg || sortPartiesForLegend([...allPartiesSeen]);
  if (!sortedParties.length) {
    $legend.innerHTML = '<span class="dd-legend-chip dd-legend-loading">Party split filling in as months load…</span>';
    return;
  }
  $legend.innerHTML = sortedParties.map((p) => {
    const active = state.filters.parties.has(p);
    const count = totalsByParty.get(p) || 0;
    return `<button type="button" class="dd-legend-chip${active ? ' is-active' : ''}" data-party="${escapeHtml(p)}" aria-pressed="${active}" style="--c:${partyColor(p)}">
      <span class="dd-legend-swatch"></span>
      <span class="dd-legend-name">${escapeHtml(p)}</span>
      <span class="dd-legend-count" aria-hidden="true">${count.toLocaleString('en-GB')}</span>
    </button>`;
  }).join('');
}

function sortPartiesForLegend(arr) {
  const order = ['Lab', 'Labour', 'Con', 'Conservative', 'LD', 'Lib Dem', 'SNP',
                 'Reform', 'Reform UK', 'Green', 'DUP', 'PC', 'Plaid Cymru',
                 'SF', 'Sinn Féin', 'Alliance', 'UUP', 'SDLP', 'Bishops',
                 'Crossbench', 'Speaker', 'Ind', 'Independent'];
  return [...arr].sort((a, b) => {
    const ai = order.indexOf(a), bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

// ---------- rendering: stats -------------------------------------------

function renderStats() {
  const months = [...state.monthlyTotals.keys()].sort();
  const totals = months.map((m) => state.monthlyTotals.get(m));
  const total = totals.reduce((a, b) => a + b, 0);
  state.totalContributions = total;
  $statTotal.textContent = total.toLocaleString('en-GB');
  if (!total) {
    $statPeak.textContent = '—';
    $statFirst.textContent = '—';
    $statLast.textContent = '—';
    $statPeakSub.textContent = '';
    $statFirstSub.textContent = '';
    $statLastSub.textContent = '';
    return;
  }
  let peakIdx = 0, peakVal = 0;
  for (let i = 0; i < totals.length; i++) {
    if (totals[i] > peakVal) { peakVal = totals[i]; peakIdx = i; }
  }
  $statPeak.textContent = formatMonth(months[peakIdx]);
  $statPeakSub.textContent = `${peakVal.toLocaleString('en-GB')} contribution${peakVal === 1 ? '' : 's'}`;

  const firstIdx = totals.findIndex((v) => v > 0);
  const lastIdx  = totals.length - 1 - [...totals].reverse().findIndex((v) => v > 0);
  $statFirst.textContent = firstIdx >= 0 ? formatMonth(months[firstIdx]) : '—';
  $statLast.textContent  = lastIdx  >= 0 ? formatMonth(months[lastIdx])  : '—';

  // First / last attribution — pulled from the streamed sample. The
  // earliest-dated headline is who-said-it-first within the year range.
  // Note: contributions per month are sampled (newest 50), so on dense
  // months the absolute earliest may sit just outside our sample —
  // close enough as an editorial signal, the existing dd-caveat
  // explains the sampling.
  if (state.headlines.length) {
    const sorted = [...state.headlines].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    $statFirstSub.textContent = describeContributor(sorted[0]);
    $statLastSub.textContent  = describeContributor(sorted[sorted.length - 1]);
  } else {
    $statFirstSub.textContent = '';
    $statLastSub.textContent  = '';
  }
}

function describeContributor(h) {
  if (!h) return '';
  // Prefer the bare name from byMember (set up from shortName) over the
  // role-led memberName so long minister attributions don't blow out the
  // stat cell.
  const m = h.memberId != null ? state.byMember.get(h.memberId) : null;
  const name = (m && m.name) || h.memberName;
  if (!name) return '';
  const party = (m && m.party) || h.party;
  return party ? `${name} (${party})` : name;
}

// ---------- rendering: top members & top debates ----------------------

function renderTopMembers() {
  const top = [...state.byMember.entries()]
    .map(([id, m]) => ({ id, ...m }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
  if (!top.length) {
    $topMembers.innerHTML = '<li class="dd-empty-li">Filling in as contributions load…</li>';
    syncRankToggle($topMembersMore, 0);
    return;
  }
  $topMembers.innerHTML = top.map((m) => {
    const active = state.filters.memberIds.has(m.id);
    return `<li>
      <button type="button" class="dd-rank-row${active ? ' is-active' : ''}" data-member-id="${m.id}" aria-pressed="${active}">
        <span class="dd-rank-count" style="--c:${partyColor(m.party)}">${m.count.toLocaleString('en-GB')}</span>
        <span class="dd-rank-name">${escapeHtml(m.name || '—')}</span>
        ${m.party ? `<span class="party-tag" style="--c:${partyColor(m.party)}">${escapeHtml(m.party)}</span>` : ''}
      </button>
    </li>`;
  }).join('');
  syncRankToggle($topMembersMore, top.length);
}

function renderTopDebates() {
  const top = [...state.byDebate.entries()]
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  if (!top.length) {
    $topDebates.innerHTML = '<li class="dd-empty-li">Filling in as contributions load…</li>';
    syncRankToggle($topDebatesMore, 0);
    return;
  }
  $topDebates.innerHTML = top.map((d) => {
    const active = state.filters.debateIds.has(d.id);
    return `<li>
      <button type="button" class="dd-rank-row${active ? ' is-active' : ''}" data-debate-id="${escapeHtml(d.id)}" aria-pressed="${active}">
        <span class="dd-rank-count">${d.count.toLocaleString('en-GB')}</span>
        <span class="dd-rank-name">${escapeHtml(d.title || '—')}</span>
      </button>
    </li>`;
  }).join('');
  syncRankToggle($topDebatesMore, top.length);
}

// ---------- co-occurring terms ----------------------------------------
//
// First-pass approach: pull capitalised multi-word phrases out of each
// contribution (proper-noun-ish), drop boilerplate parliamentary
// titles, count once per contribution. Single words are ignored on the
// first pass — the noise floor on common English ("government",
// "minister", "member") drowns out signal without a heavier weighting
// scheme. If multi-word phrases turn out editorially shaped, single
// words can be reintroduced with a stopword list later.

// Boilerplate that shows up on every topic and tells you nothing about
// this one. Tightened from real samples (Waiting list / Armed Forces).
// The principle: anything already represented in another panel
// (parties, procedural roles, venues, generic government-of-the-day) is
// duplication, not signal.
const STOP_PHRASES = new Set([
  // Honorifics + forms of address
  'Hon Member', 'Hon Members', 'Hon Friend', 'Hon Friends',
  'Hon Lady', 'Hon Gentleman', 'Hon Ladies', 'Hon Gentlemen',
  'Right Hon', 'Right Honourable',
  'Honourable Lady', 'Honourable Gentleman', 'Honourable Friend', 'Honourable Member',
  'Noble Lord', 'Noble Lords', 'Noble Lady', 'Noble Friend', 'Noble Baroness', 'Noble Earl', 'Noble Friends',
  'My Lords', 'My Lord', 'My Right',

  // Speaker/chair roles
  'Mr Speaker', 'Madam Speaker',
  'Deputy Speaker', 'Mr Deputy Speaker', 'Madam Deputy Speaker',
  'Mr Deputy', 'Madam Deputy',

  // Cabinet / minister titles that are boilerplate even on topic-aligned
  // searches. PM and senior portfolios appear in nearly every debate.
  // Topic-aligned secretaries (Defence, Health, Education, etc.) are
  // left in — on a Defence search "Defence Secretary" is signal, not
  // noise; same logic for Health Secretary on healthcare topics.
  'Member of Parliament',
  'Prime Minister', 'Deputy Prime Minister',

  // Houses + procedural venues
  'House of Commons', 'House of Lords',
  'Westminster Hall',

  // Procedural session/agenda labels
  'Topical Questions', 'Oral Questions', 'Written Questions',
  'Order Paper', 'Hansard Online',
  'Budget Resolutions', 'Budget Resolution', 'Budget Statement',
  'King Speech', 'Queen Speech',
  'Business Statement',

  // Generic question/heading templates that show up as Hansard
  // titling rather than topic-specific signal.
  'Recent Developments', 'Recent Events', 'Recent Reports',
  'Topical Issues',
  'First Reading', 'Second Reading', 'Third Reading',
  'Royal Assent',
  'Point of Order', 'Points of Order',

  // Procedural committees (kept Defence Committee / Health Committee etc
  // so topic-specific committees still surface)
  'Select Committee', 'Public Accounts Committee', 'Public Bill Committee',
  'Backbench Business Committee', 'Liaison Committee',
  'European Scrutiny Committee', 'Statutory Instruments Committee',
  'Procedure Committee', 'Standards Committee', 'Privileges Committee',

  // Geographical / national boilerplate
  'United Kingdom', 'Great Britain',

  // Parties — already represented in the chart's party stack, surfacing
  // them here is wasted real estate. Plurals + variants included.
  'Labour Party', 'Conservative Party', 'Conservative Party Conference',
  'Liberal Democrats', 'Liberal Democrat',
  'Green Party', 'Reform UK', 'Reform Party',
  'Scottish National Party',
  'Plaid Cymru',
  'Sinn Féin', 'Sinn Fein',

  // [Party] Government / [Region] Government / [Term] Government — almost
  // always throat-clearing political framing rather than signal.
  'Labour Government', 'Conservative Government', 'Tory Government',
  'Coalition Government', 'SNP Government',
  'UK Government', 'Scottish Government', 'Welsh Government',
  'US Government', 'United States Government',
  'Previous Government', 'Current Government', 'This Government', 'Last Government',

  // Pronoun + verb constructions (sentence starts that slip through)
  'I am', 'I have', 'I will', 'I would', 'I was', 'I do',
  'There is', 'There are', 'There was', 'There were',
  'It is', 'It was', 'It will',
  'We are', 'We have', 'We will', 'We need', 'We must', 'We can',
  'They are', 'They have', 'They will',
]);


const PHRASE_LEAD_DROP = /^(The|A|An|This|That|These|Those|My|Our|Their|His|Her|Its)\s+/i;
// Allow hyphenated word parts so "Mid-Wales" / "Non-payment" etc don't
// truncate at the dash. The trailing space-separated pieces follow the
// same pattern so multi-word phrases survive intact.
const PHRASE_RE = /\b([A-Z][a-zA-Z]+(?:-[a-zA-Z]+)*(?:\s+[A-Z][a-zA-Z]+(?:-[a-zA-Z]+)*){1,3})\b/g;

function extractPhrases(text, termLower) {
  if (!text) return [];
  const found = new Set();
  for (const m of text.matchAll(PHRASE_RE)) {
    let p = m[1].replace(PHRASE_LEAD_DROP, '');
    if (!p || p.split(/\s+/).length < 2) continue;
    if (STOP_PHRASES.has(p)) continue;
    if (termLower && p.toLowerCase() === termLower) continue;
    found.add(p);
  }
  return [...found];
}

function computeCoTerms() {
  const items = hasFilters() ? state.headlines.filter(matchesFilters) : state.headlines;
  // Strip wrapping quotes so a phrase search like "Armed Forces" still
  // matches the bare-search-term filter inside extractPhrases.
  const termLower = unquoteTerm(state.term || '').toLowerCase();
  const counts = new Map();
  for (const h of items) {
    const text = (h.fullText || h.snippet || '') + ' ' + (h.title || '');
    for (const p of extractPhrases(text, termLower)) {
      counts.set(p, (counts.get(p) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)                 // singletons are noise
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([term, count]) => ({ term, count }));
}

function renderCoTerms() {
  if (!state.headlines.length) {
    $coTerms.innerHTML = '<li class="dd-empty-li">Filling in as contributions load…</li>';
    syncRankToggle($coTermsMore, 0);
    return;
  }
  const top = computeCoTerms();
  if (!top.length) {
    $coTerms.innerHTML = '<li class="dd-empty-li">No phrases stood out in this set.</li>';
    syncRankToggle($coTermsMore, 0);
    return;
  }
  $coTerms.innerHTML = top.map((t) => {
    const active = state.filters.terms.has(t.term);
    return `<li>
      <button type="button" class="dd-rank-row${active ? ' is-active' : ''}" data-term="${escapeHtml(t.term)}" aria-pressed="${active}">
        <span class="dd-rank-count">${t.count.toLocaleString('en-GB')}</span>
        <span class="dd-rank-name">${escapeHtml(t.term)}</span>
      </button>
    </li>`;
  }).join('');
  syncRankToggle($coTermsMore, top.length);
}

// ---------- rendering: headline list ----------------------------------

function renderHeadlines() {
  if (!state.headlines.length) {
    $headlines.innerHTML = '<li class="dd-empty-li">Headlines will appear here as months load.</li>';
    $exportBtn.hidden = true;
    return;
  }
  $exportBtn.hidden = false;
  const filtered = hasFilters() ? state.headlines.filter(matchesFilters) : state.headlines;
  if (!filtered.length) {
    $headlines.innerHTML = '<li class="dd-empty-li">No contributions match the current filter.</li>';
    return;
  }
  // Newest first
  const sorted = [...filtered].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const visible = sorted.slice(0, 250); // render cap for the list itself
  const more = sorted.length - visible.length;
  $headlines.innerHTML = visible.map((h) => {
    const partyBit = h.party ? `<span class="party-tag" style="--c:${partyColor(h.party)}">${escapeHtml(h.party)}</span>` : '';
    const houseBit = h.house ? `<span class="house-tag">${escapeHtml(h.house)}</span>` : '';
    const memberBit = h.memberName ? `<span class="dd-hl-member">${escapeHtml(h.memberName)}</span>` : '';
    return `<li class="dd-hl">
      <p class="dd-hl-meta">
        <span class="dd-hl-date">${escapeHtml(formatDate(h.date))}</span>
        ${memberBit}
        ${partyBit}
        ${houseBit}
      </p>
      <h3 class="dd-hl-title"><a href="${escapeHtml(h.link)}" target="_blank" rel="noopener">${escapeHtml(h.title || '(untitled)')}</a></h3>
      <p class="dd-hl-snippet">${snippetHtml(h.snippet || h.fullText, state.term, 240)}</p>
    </li>`;
  }).join('') + (more > 0
    ? `<li class="dd-empty-li">${more.toLocaleString('en-GB')} more contributions matched. Refine the date range to see fewer.</li>`
    : '');
}

// Filter bar — shows active filters as removable chips above the
// contributions list. Hidden when no filters are active.
function renderFilterBar() {
  if (!hasFilters()) {
    $filterBar.hidden = true;
    $filterBar.innerHTML = '';
    return;
  }
  const chips = [];
  for (const id of state.filters.memberIds) {
    const m = state.byMember.get(id);
    chips.push(filterChipHtml('member', id, m ? m.name : `member ${id}`, m ? partyColor(m.party) : null));
  }
  for (const id of state.filters.debateIds) {
    const d = state.byDebate.get(id);
    chips.push(filterChipHtml('debate', id, d ? d.title : 'debate', null));
  }
  for (const p of state.filters.parties) {
    chips.push(filterChipHtml('party', p, p, partyColor(p)));
  }
  for (const t of state.filters.terms) {
    chips.push(filterChipHtml('term', t, t, null));
  }
  for (const m of state.filters.months) {
    chips.push(filterChipHtml('month', m, formatMonth(m), null));
  }
  const matchCount = state.headlines.filter(matchesFilters).length;
  const clearAll = chips.length >= 2
    ? `<button type="button" class="dd-filter-clear" data-clear-all>Clear all</button>`
    : '';
  $filterBar.hidden = false;
  $filterBar.innerHTML = `
    <span class="dd-filter-bar-label">Filtered to</span>
    ${chips.join('')}
    <span class="dd-filter-bar-count">${matchCount.toLocaleString('en-GB')} contribution${matchCount === 1 ? '' : 's'}</span>
    ${clearAll}
  `;
}

function filterChipHtml(kind, value, label, color) {
  const colorAttr = color ? ` style="--c:${color}"` : '';
  return `<button type="button" class="dd-filter-chip" data-kind="${kind}" data-value="${escapeHtml(String(value))}"${colorAttr} aria-label="Remove filter: ${escapeHtml(label || '')}">
    <span class="dd-filter-chip-label">${escapeHtml(label || '—')}</span>
    <span class="dd-filter-chip-x" aria-hidden="true">×</span>
  </button>`;
}

// ---------- export ----------

function describeDeepDiveFilters() {
  const parts = [];
  for (const id of state.filters.memberIds) {
    const m = state.byMember.get(id);
    parts.push(`Member: ${m ? m.name : `id ${id}`}`);
  }
  for (const id of state.filters.debateIds) {
    const d = state.byDebate.get(id);
    parts.push(`Debate: ${d ? d.title : `id ${id}`}`);
  }
  for (const p of state.filters.parties) parts.push(`Party: ${p}`);
  for (const t of state.filters.terms)   parts.push(`Mentions: "${t}"`);
  for (const m of state.filters.months)  parts.push(`Month: ${formatMonth(m)}`);
  return parts.join(' · ');
}

$exportBtn.addEventListener('click', () => {
  // Honour the active filters — newest first matches the on-screen order.
  const items = (hasFilters() ? state.headlines.filter(matchesFilters) : state.headlines)
    .slice()
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const md = buildMarkdownExport({
    pageTitle: 'Deep Dive export',
    term: state.term,
    dateRange: describeRange(),
    filtersLabel: describeDeepDiveFilters(),
    recreateUrl: location.href,
    items,
  });
  downloadMarkdown(exportFilename('house-deep-dive', state.term), md);
});

// Human-readable rendering of the active range, used in export headers
// and the no-results message.
function describeRange() {
  const presetLabels = { month: 'Last month', year: 'Last year', five: 'Last 5 years' };
  if (state.preset === 'custom') {
    return `${formatDate(state.startDate)} – ${formatDate(state.endDate)}`;
  }
  return presetLabels[state.preset] || `${formatDate(state.startDate)} – ${formatDate(state.endDate)}`;
}

// ---------- rAF coalescing --------------------------------------------

let renderRaf = 0;
function scheduleRender(parts = ['chart', 'stats', 'members', 'debates', 'headlines', 'filterBar', 'coTerms']) {
  if (renderRaf) cancelAnimationFrame(renderRaf);
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    if (parts.includes('chart')) renderTimeline();
    if (parts.includes('stats')) renderStats();
    if (parts.includes('members')) renderTopMembers();
    if (parts.includes('debates')) renderTopDebates();
    if (parts.includes('headlines')) renderHeadlines();
    if (parts.includes('filterBar')) renderFilterBar();
    if (parts.includes('coTerms')) renderCoTerms();
  });
}

// ---------- streaming --------------------------------------------------

async function processMonth(month, myToken) {
  if (myToken !== state.cancelToken) return;
  if (state.headlines.length >= MAX_HEADLINES) return;
  const startDate = `${month}-01`;
  const endDate = lastDayOfMonth(month);
  try {
    const { items } = await searchSpoken({
      searchTerm: state.term,
      startDate, endDate,
      house: state.house,
      take: PER_MONTH,
      orderBy: 'SittingDateDesc',
    });
    if (myToken !== state.cancelToken) return;

    const partyMap = state.monthlyByParty.get(month) || new Map();
    for (const it of items) {
      // For the chart bucket we need a key, so unknown rolls up under
      // 'Unknown'. For byMember we keep the raw (possibly empty) party
      // so ministers don't get a misleading 'Unknown' badge.
      const chartParty = it.party || 'Unknown';
      partyMap.set(chartParty, (partyMap.get(chartParty) || 0) + 1);

      if (it.memberId != null) {
        const cur = state.byMember.get(it.memberId);
        if (cur) {
          cur.count++;
          // Ministers attribute as "Role (Name)" → no party. Upgrade if a
          // later contribution from the same MP carries one.
          if (!cur.party && it.party) cur.party = it.party;
        } else {
          state.byMember.set(it.memberId, {
            name: it.shortName || it.memberName,
            party: it.party,
            count: 1,
          });
        }
      }

      // Aggregate by debate (use externalId so we have a stable key + can link)
      if (it.debateExtId) {
        const cur = state.byDebate.get(it.debateExtId);
        if (cur) cur.count++;
        else state.byDebate.set(it.debateExtId, {
          title: it.title, link: it.link, count: 1,
        });
      }

      // Headlines — flat copy so the streamed shard objects can be GC'd
      if (state.headlines.length < MAX_HEADLINES) {
        state.headlines.push({
          date: it.date, memberName: it.memberName, party: it.party,
          house: it.house,
          memberId: it.memberId, debateExtId: it.debateExtId,
          title: it.title, link: it.link,
          snippet: it.snippet, fullText: it.fullText,
        });
      }
    }
    state.monthlyByParty.set(month, partyMap);
  } catch (e) {
    console.warn(`Deep Dive: ${month} fetch failed`, e);
  }
  state.monthsLoaded++;
  setProgress();
  scheduleRender();
}

function setProgress() {
  if (state.monthsLoaded < state.monthsTotal) {
    $status.textContent = `Loading month ${state.monthsLoaded}/${state.monthsTotal} · ${state.headlines.length.toLocaleString('en-GB')} contributions sampled`;
  } else if (state.totalContributions > state.headlines.length) {
    const pct = Math.round((state.headlines.length / state.totalContributions) * 100);
    $status.textContent = `${state.totalContributions.toLocaleString('en-GB')} total contributions · party split based on a ${state.headlines.length.toLocaleString('en-GB')}-row sample (${pct}%)`;
  } else {
    $status.textContent = `${state.totalContributions.toLocaleString('en-GB')} contributions loaded`;
  }
}

async function runDive(pushUrl) {
  const myToken = ++state.cancelToken;
  resetState();
  // If the URL carries filter params (e.g. shareable filtered link, or
  // navigating back via popstate), restore them now so they apply as
  // headlines stream in.
  if (!pushUrl) applyFiltersFromUrl();

  state.term = $q.value.trim();
  const { startDate, endDate } = dateRange();
  state.startDate = startDate;
  state.endDate = endDate;
  if (state.startDate > state.endDate) [state.startDate, state.endDate] = [state.endDate, state.startDate];

  if (!state.term) {
    $status.textContent = 'Enter a term to dive into.';
    $results.hidden = true;
    return;
  }

  if (pushUrl) pushUrlState();
  $results.hidden = false;
  $caveat.hidden = true;
  $chart.innerHTML = '';
  $legend.innerHTML = '';
  $headlines.innerHTML = '';
  $topMembers.innerHTML = '';
  $topDebates.innerHTML = '';
  $coTerms.innerHTML = '';
  resetRankToggle($topMembersMore, $topMembers);
  resetRankToggle($topDebatesMore, $topDebates);
  resetRankToggle($coTermsMore, $coTerms);
  renderFilterBar();
  $exportBtn.hidden = true;
  $status.textContent = 'Fetching the timeline…';
  $form.classList.add('is-loading');

  try {
    // Step 1: timeline-stats — instant overall shape
    let stats;
    try {
      stats = await timelineStats({
        searchTerm: state.term,
        startDate: state.startDate,
        endDate: state.endDate,
        house: state.house,
        grouping: 'Month',
        contributionType: 'Spoken',
      });
    } catch (e) {
      $status.textContent = `Couldn't load the timeline. ${e.message || ''}`;
      return;
    }
    if (myToken !== state.cancelToken) return;
    for (const b of stats.buckets) state.monthlyTotals.set(b.month, b.count);

    if (stats.total === 0) {
      $status.textContent = `No contributions matched "${state.term}" in ${describeRange()}.`;
      return;
    }
    renderTimeline();
    renderStats();

    // Step 2: stream months that actually have hits
    const monthsWithHits = monthsInRange(state.startDate, state.endDate)
      .filter((m) => (state.monthlyTotals.get(m) || 0) > 0);
    // Newest first so the most recent contributions appear first in the
    // list as it grows.
    monthsWithHits.reverse();
    state.monthsTotal = monthsWithHits.length;

    setProgress();
    if (state.totalContributions > MAX_HEADLINES) $caveat.hidden = false;

    const queue = [...monthsWithHits];
    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push((async () => {
        while (queue.length && myToken === state.cancelToken) {
          const m = queue.shift();
          await processMonth(m, myToken);
        }
      })());
    }
    await Promise.all(workers);
    if (myToken !== state.cancelToken) return;

    setProgress();
    // Final guaranteed render in case rAF skipped the last tick
    renderTimeline();
    renderTopMembers();
    renderTopDebates();
    renderCoTerms();
    renderHeadlines();
    renderFilterBar();

    // Top-12 leaderboard members whose party is still empty are typically
    // ministers attributed by role. Look them up via the Members API in
    // parallel and upgrade the leaderboard once we know.
    fillMissingTopMemberParties(myToken);
  } finally {
    // Only clear if this run is still the current one — otherwise a newer
    // dive is in flight and owns the bar.
    if (myToken === state.cancelToken) $form.classList.remove('is-loading');
  }
}

async function fillMissingTopMemberParties(myToken) {
  const top = [...state.byMember.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 12)
    .filter(([, m]) => !m.party);
  if (!top.length) return;
  await Promise.all(top.map(async ([id, m]) => {
    try {
      const fetched = await memberById(id);
      if (fetched && fetched.party) m.party = fetched.party;
    } catch { /* swallow */ }
  }));
  if (myToken !== state.cancelToken) return;
  scheduleRender(['members']);
}

// ---------- URL state --------------------------------------------------

function buildUrlFromState() {
  const p = new URLSearchParams();
  if (state.term) p.set('q', state.term);
  if (state.preset && state.preset !== 'year') p.set('range', state.preset);
  if (state.preset === 'custom') {
    if (state.customFrom) p.set('from', state.customFrom);
    if (state.customTo)   p.set('to',   state.customTo);
  }
  if (state.house && state.house !== 'Both') p.set('house', state.house);
  if (state.filters.memberIds.size) p.set('fm', [...state.filters.memberIds].join(','));
  if (state.filters.debateIds.size) p.set('fd', [...state.filters.debateIds].join(','));
  if (state.filters.parties.size)   p.set('fp', [...state.filters.parties].join(','));
  if (state.filters.terms.size)     p.set('ft', [...state.filters.terms].join('|'));
  if (state.filters.months.size)    p.set('fmo', [...state.filters.months].join(','));
  return p.toString();
}

function pushUrlState() {
  const qs = buildUrlFromState();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  if (url === location.pathname + location.search) return;
  history.pushState({ deepDive: true }, '', url);
}

function applyParamsFromUrl() {
  const p = new URLSearchParams(location.search);
  const q = p.get('q') || '';
  $q.value = q;

  // Backwards-compat: the previous Deep Dive URL model used year-only
  // from/to (e.g. ?from=2024&to=2026). Detect that shape and translate
  // into a custom date range so existing shared links still resolve.
  const fromRaw = p.get('from') || '';
  const toRaw = p.get('to') || '';
  const isOldYearOnly = /^\d{4}$/.test(fromRaw) || /^\d{4}$/.test(toRaw);
  let range = p.get('range');
  let customFrom = '';
  let customTo = '';
  if (isOldYearOnly) {
    range = 'custom';
    if (/^\d{4}$/.test(fromRaw)) customFrom = `${fromRaw}-01-01`;
    if (/^\d{4}$/.test(toRaw))   customTo   = `${toRaw}-12-31`;
  } else {
    if (fromRaw) customFrom = fromRaw;
    if (toRaw)   customTo   = toRaw;
  }
  const validRanges = ['month', 'year', 'five', 'custom'];
  state.preset = validRanges.includes(range) ? range : 'year';
  state.customFrom = customFrom;
  state.customTo   = customTo;

  // Reflect into the form pills + custom date inputs
  for (const b of $datePresets.querySelectorAll('button')) {
    b.setAttribute('aria-checked', b.dataset.preset === state.preset ? 'true' : 'false');
  }
  $customDates.hidden = state.preset !== 'custom';
  if (state.preset === 'custom') {
    $fromDate.value = state.customFrom;
    $toDate.value   = state.customTo;
  }

  // House
  const house = p.get('house');
  state.house = (house === 'Commons' || house === 'Lords') ? house : 'Both';
  for (const b of $house.querySelectorAll('button')) {
    b.setAttribute('aria-checked', b.dataset.house === state.house ? 'true' : 'false');
  }

  updateFiltersSummary();
  return !!q;
}

// Pulled from URL after resetState, so filters persist through a dive.
function applyFiltersFromUrl() {
  const p = new URLSearchParams(location.search);
  const fm = p.get('fm');
  const fd = p.get('fd');
  const fp = p.get('fp');
  const ft = p.get('ft');
  const fmo = p.get('fmo');
  if (fm) for (const id of fm.split(',')) { const n = Number(id); if (Number.isFinite(n)) state.filters.memberIds.add(n); }
  if (fd) for (const id of fd.split(',')) if (id) state.filters.debateIds.add(id);
  if (fp) for (const p of fp.split(',')) if (p) state.filters.parties.add(p);
  // Terms can contain commas in arbitrary phrasing; pipe is a safer separator.
  if (ft) for (const t of ft.split('|')) if (t) state.filters.terms.add(t);
  if (fmo) for (const m of fmo.split(',')) if (m) state.filters.months.add(m);
}

window.addEventListener('popstate', () => {
  const has = applyParamsFromUrl();
  if (has) runDive(false);
});

// ---------- wiring -----------------------------------------------------

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  runDive(true);
});

// ---------- init -------------------------------------------------------

updateFiltersSummary();
const hasInitialQuery = applyParamsFromUrl();
if (hasInitialQuery) runDive(false);
