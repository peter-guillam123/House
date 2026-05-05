// House — Deep Dive
// One ranked monthly grid of how parliament has discussed a term over time,
// with party stacking, top members and top debates filling in as the data
// streams. Hansard /timeline-stats gives the overall shape in one call;
// each month is then fetched in parallel (concurrency 4) for the
// individual contributions feeding the leaderboards and headline list.

import { timelineStats, searchSpoken, memberById } from './api.js?v=7';
import { formatDate, snippetHtml, escapeHtml, partyColor } from './format.js?v=5';

// ---------- config -----------------------------------------------------

const CONCURRENCY = 4;          // parallel month fetches
const PER_MONTH = 50;           // contributions sampled per month
const MAX_HEADLINES = 1500;     // hard cap for the headline list

// ---------- state ------------------------------------------------------

const state = {
  term: '',
  yearFrom: 0,
  yearTo: 0,
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
  // Click-to-filter — the leaderboards and legend double as filter
  // surfaces. AND-combined across the three axes.
  filters: {
    memberIds: new Set(),      // Set<number>
    debateIds: new Set(),      // Set<string>
    parties:   new Set(),      // Set<string>
  },
};

// ---------- DOM refs ---------------------------------------------------

const $form        = document.getElementById('dd-form');
const $q           = document.getElementById('dd-q');
const $from        = document.getElementById('dd-from');
const $to          = document.getElementById('dd-to');
const $status      = document.getElementById('dd-status');
const $statTotal   = document.getElementById('dd-stat-total');
const $statPeak    = document.getElementById('dd-stat-peak');
const $statFirst   = document.getElementById('dd-stat-first');
const $statLast    = document.getElementById('dd-stat-last');
const $chart       = document.getElementById('dd-chart');
const $legend      = document.getElementById('dd-legend');
const $caveat      = document.getElementById('dd-caveat');
const $topMembers  = document.getElementById('dd-top-members');
const $topDebates  = document.getElementById('dd-top-debates');
const $topMembersMore = document.getElementById('dd-top-members-more');
const $topDebatesMore = document.getElementById('dd-top-debates-more');
const $headlines   = document.getElementById('dd-headlines');
const $results     = document.getElementById('dd-results');
const $filterBar   = document.getElementById('dd-filter-bar');

function wireRankToggle(btn, list) {
  btn.addEventListener('click', () => {
    const expanded = list.classList.toggle('is-expanded');
    btn.setAttribute('aria-expanded', String(expanded));
    btn.textContent = expanded ? 'Show fewer' : 'Show all';
  });
}
wireRankToggle($topMembersMore, $topMembers);
wireRankToggle($topDebatesMore, $topDebates);

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

function monthsInRange(yFrom, yTo) {
  const out = [];
  for (let y = yFrom; y <= yTo; y++) {
    for (let m = 1; m <= 12; m++) out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
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
  return f.memberIds.size + f.debateIds.size + f.parties.size > 0;
}

// AND across the three axes; OR within an axis (e.g. two parties picked
// = "either party").
function matchesFilters(h) {
  const f = state.filters;
  if (f.memberIds.size && !f.memberIds.has(h.memberId)) return false;
  if (f.debateIds.size && !f.debateIds.has(h.debateExtId)) return false;
  if (f.parties.size   && !f.parties.has(h.party || 'Unknown')) return false;
  return true;
}

function resetFilters() {
  state.filters.memberIds.clear();
  state.filters.debateIds.clear();
  state.filters.parties.clear();
}

function toggleFilter(kind, value) {
  const set =
    kind === 'member' ? state.filters.memberIds :
    kind === 'debate' ? state.filters.debateIds :
    kind === 'party'  ? state.filters.parties   : null;
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
$legend.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-party]');
  if (!btn) return;
  toggleFilter('party', btn.dataset.party);
});
$filterBar.addEventListener('click', (e) => {
  const clearAll = e.target.closest('[data-clear-all]');
  if (clearAll) { clearAllFilters(); return; }
  const chip = e.target.closest('[data-kind][data-value]');
  if (!chip) return;
  toggleFilter(chip.dataset.kind, chip.dataset.value);
});

// Year selects
function populateYearSelects() {
  const now = new Date().getFullYear();
  for (let y = now; y >= 2010; y--) {
    $from.append(new Option(y, y));
    $to.append(new Option(y, y));
  }
  $from.value = String(now - 2);
  $to.value = String(now);
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
  const months = monthsInRange(state.yearFrom, state.yearTo);
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
    const byParty = state.monthlyByParty.get(m);
    if (!byParty || byParty.size === 0) {
      // Skeleton bar — we have the count but no party split yet
      return `<rect x="${x.toFixed(2)}" y="${yTop.toFixed(2)}" width="${drawW.toFixed(2)}" height="${totalH.toFixed(2)}" fill="var(--rule)" class="dd-bar dd-bar-skeleton"><title>${formatMonth(m)} — ${total.toLocaleString('en-GB')} contributions (loading…)</title></rect>`;
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
    return `<g><title>${escapeHtml(titleParts.join(' · '))}</title>${svg}</g>`;
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
    return;
  }
  let peakIdx = 0, peakVal = 0;
  for (let i = 0; i < totals.length; i++) {
    if (totals[i] > peakVal) { peakVal = totals[i]; peakIdx = i; }
  }
  $statPeak.textContent = formatMonth(months[peakIdx]);
  const firstIdx = totals.findIndex((v) => v > 0);
  const lastIdx  = totals.length - 1 - [...totals].reverse().findIndex((v) => v > 0);
  $statFirst.textContent = firstIdx >= 0 ? formatMonth(months[firstIdx]) : '—';
  $statLast.textContent  = lastIdx  >= 0 ? formatMonth(months[lastIdx])  : '—';
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

// ---------- rendering: headline list ----------------------------------

function renderHeadlines() {
  if (!state.headlines.length) {
    $headlines.innerHTML = '<li class="dd-empty-li">Headlines will appear here as months load.</li>';
    return;
  }
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

// ---------- rAF coalescing --------------------------------------------

let renderRaf = 0;
function scheduleRender(parts = ['chart', 'members', 'debates', 'headlines', 'filterBar']) {
  if (renderRaf) cancelAnimationFrame(renderRaf);
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    if (parts.includes('chart')) renderTimeline();
    if (parts.includes('members')) renderTopMembers();
    if (parts.includes('debates')) renderTopDebates();
    if (parts.includes('headlines')) renderHeadlines();
    if (parts.includes('filterBar')) renderFilterBar();
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
  state.yearFrom = Number($from.value);
  state.yearTo = Number($to.value);
  if (state.yearFrom > state.yearTo) [state.yearFrom, state.yearTo] = [state.yearTo, state.yearFrom];

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
  resetRankToggle($topMembersMore, $topMembers);
  resetRankToggle($topDebatesMore, $topDebates);
  renderFilterBar();
  $status.textContent = 'Fetching the timeline…';

  // Step 1: timeline-stats — instant overall shape
  let stats;
  try {
    stats = await timelineStats({
      searchTerm: state.term,
      startDate: `${state.yearFrom}-01-01`,
      endDate: `${state.yearTo}-12-31`,
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
    $status.textContent = `No contributions matched "${state.term}" in ${state.yearFrom}–${state.yearTo}.`;
    return;
  }
  renderTimeline();
  renderStats();

  // Step 2: stream months that actually have hits
  const monthsWithHits = monthsInRange(state.yearFrom, state.yearTo)
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
  renderHeadlines();
  renderFilterBar();

  // Top-12 leaderboard members whose party is still empty are typically
  // ministers attributed by role. Look them up via the Members API in
  // parallel and upgrade the leaderboard once we know.
  fillMissingTopMemberParties(myToken);
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
  const now = new Date().getFullYear();
  if (state.yearFrom && state.yearFrom !== now - 2) p.set('from', String(state.yearFrom));
  if (state.yearTo && state.yearTo !== now) p.set('to', String(state.yearTo));
  if (state.filters.memberIds.size) p.set('fm', [...state.filters.memberIds].join(','));
  if (state.filters.debateIds.size) p.set('fd', [...state.filters.debateIds].join(','));
  if (state.filters.parties.size)   p.set('fp', [...state.filters.parties].join(','));
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
  const now = new Date().getFullYear();
  const from = Number(p.get('from')) || (now - 2);
  const to = Number(p.get('to')) || now;
  $from.value = String(from);
  $to.value = String(to);
  return !!q;
}

// Pulled from URL after resetState, so filters persist through a dive.
function applyFiltersFromUrl() {
  const p = new URLSearchParams(location.search);
  const fm = p.get('fm');
  const fd = p.get('fd');
  const fp = p.get('fp');
  if (fm) for (const id of fm.split(',')) { const n = Number(id); if (Number.isFinite(n)) state.filters.memberIds.add(n); }
  if (fd) for (const id of fd.split(',')) if (id) state.filters.debateIds.add(id);
  if (fp) for (const p of fp.split(',')) if (p) state.filters.parties.add(p);
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

populateYearSelects();
const hasInitialQuery = applyParamsFromUrl();
if (hasInitialQuery) runDive(false);
