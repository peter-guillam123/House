// House — Yesterday
// One sitting day, read from the files tools/build-day.py writes each
// morning. Nothing is fetched live: the page loads days/index.json to
// find the day, then days/<date>.json, and renders from that.

import { formatDate, formatDayLong, formatDayFull, formatTime, escapeHtml, partyColor, partyShortName } from './format.js?v=9';

const state = { index: null, day: null, date: '', house: 'Commons' };

const $ = (id) => document.getElementById(id);
const $kicker = $('dy-kicker'), $title = $('dy-title'), $sub = $('dy-sub');
const $prev = $('dy-prev'), $next = $('dy-next');
const $house = $('dy-house'), $status = $('dy-status'), $body = $('dy-body');
const $numbers = $('dy-numbers');
const $spikesNote = $('dy-spikes-note'), $spikesList = $('dy-spikes-list');
const $divisions = $('dy-divisions'), $divisionsList = $('dy-divisions-list');
const $sectionsList = $('dy-sections-list');
const $speakersList = $('dy-speakers-list'), $statementsList = $('dy-statements-list');
const $committeesList = $('dy-committees-list'), $billsList = $('dy-bills-list'), $reportsList = $('dy-reports-list');

const DAYS_BASE = new URL('days/', location.href);

const KIND_LABELS = [
  ['pmqs', 'Prime Minister’s Questions'],
  ['uq', 'Urgent questions'],
  ['statement', 'Statements'],
  ['questions', 'Questions to ministers'],
  ['opposition', 'Opposition day'],
  ['legislation', 'Legislation'],
  ['debate', 'Debates'],
  ['westminster-hall', 'Westminster Hall'],
  ['adjournment', 'Adjournment debate'],
];

// ---------- loading ----------

async function loadJson(name) {
  const r = await fetch(new URL(name, DAYS_BASE), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${r.status} on ${name}`);
  return r.json();
}

async function init() {
  try {
    state.index = await loadJson('index.json');
  } catch (e) {
    setStatus('No day summaries have been built yet. The nightly job writes the first one the morning after a sitting.', true);
    return;
  }
  const p = new URLSearchParams(location.search);
  const days = state.index.days || [];
  const wanted = p.get('d');
  const date = days.find((d) => d.date === wanted)?.date
    || state.index.latest?.Commons || state.index.latest?.Lords || days[0]?.date;
  if (!date) {
    setStatus('No sitting days on file yet.', true);
    return;
  }
  state.house = p.get('house') === 'Lords' ? 'Lords' : 'Commons';
  await showDay(date, { push: false });
}

async function showDay(date, { push = true } = {}) {
  setStatus('Loading…');
  try {
    state.day = await loadJson(`${date}.json`);
  } catch (e) {
    setStatus(`Couldn’t load ${formatDate(date)}. ${e.message || ''}`, true);
    return;
  }
  state.date = date;
  const houses = Object.keys(state.day.houses || {});
  if (!houses.includes(state.house)) state.house = houses[0] || 'Commons';
  if (push) pushUrl();
  else history.replaceState(null, '', buildUrl());
  render();
  setStatus('');
}

function buildUrl() {
  const p = new URLSearchParams();
  p.set('d', state.date);
  if (state.house !== 'Commons') p.set('house', state.house);
  return `${location.pathname}?${p}`;
}
function pushUrl() {
  const url = buildUrl();
  if (url !== location.pathname + location.search) history.pushState({ day: true }, '', url);
}

// ---------- rendering ----------

function render() {
  renderHeader();
  renderHousePills();
  const h = state.day.houses[state.house];
  if (!h) { $body.hidden = true; return; }
  renderNumbers(h);
  renderSpikes(h);
  renderDivisions(h);
  renderSections(h);
  renderSpeakers(h);
  renderStatements(h);
  renderCommittees(state.day);
  renderBills(state.day);
  $body.hidden = false;
  document.title = `${formatDayLong(state.date)} — House`;
}

function renderHeader() {
  const d = state.day;
  const latest = state.index.days?.[0]?.date;
  $kicker.textContent = state.date === latest ? 'The last sitting' : 'A sitting day';
  $title.textContent = formatDayFull(state.date);
  const parts = [];
  for (const house of ['Commons', 'Lords']) {
    const h = d.houses[house];
    if (!h) continue;
    const sat = h.sat;
    parts.push(sat && sat.from && sat.to
      ? `the ${house} from ${formatTime(sat.from)} to ${formatTime(sat.to)}`
      : sat && sat.from ? `the ${house} from ${formatTime(sat.from)}` : `the ${house}`);
  }
  const both = parts.length === 2;
  $sub.textContent = parts.length
    ? `${both ? 'Both Houses sat: ' : 'Only '}${parts.join(both ? '; ' : '')}${both ? '.' : ' sat.'}`
    : '';
  // Earlier / later sitting days from the index.
  const days = state.index.days || [];
  const i = days.findIndex((x) => x.date === state.date);
  const older = i >= 0 ? days[i + 1] : null;
  const newer = i > 0 ? days[i - 1] : null;
  setNav($prev, older);
  setNav($next, newer);
}

function setNav($a, day) {
  if (!day) { $a.hidden = true; return; }
  $a.hidden = false;
  $a.href = `${location.pathname}?d=${day.date}${state.house !== 'Commons' ? '&house=Lords' : ''}`;
  $a.dataset.date = day.date;
  $a.querySelector('span').textContent = formatDayLong(day.date);
}

function renderHousePills() {
  const houses = state.day.houses || {};
  for (const b of $house.querySelectorAll('button')) {
    const has = !!houses[b.dataset.house];
    b.disabled = !has;
    b.setAttribute('aria-checked', b.dataset.house === state.house ? 'true' : 'false');
    b.title = has ? '' : `The ${b.dataset.house} did not sit`;
  }
}

const num = (n) => (n ?? 0).toLocaleString('en-GB');

function renderNumbers(h) {
  const n = h.numbers || {};
  const wh = (h.sections || []).filter((s) => s.kind === 'westminster-hall').length;
  const deferred = (h.divisions || []).filter((d) => d.deferred).length;
  const tiles = [
    ['Debates', num(n.sections), wh ? `${wh} in Westminster Hall` : 'in the chamber'],
    ['Speakers', num(n.speakers), `${num(n.contributions)} contributions`],
    ['Words', num(n.words), 'spoken, excluding the chair'],
    ['Divisions', num(n.divisions), deferred ? `${deferred} deferred` : (n.divisions ? 'in the lobbies' : 'none today')],
    ['Written statements', num(n.writtenStatements), 'by ministers, no debate'],
    ['Written answers', num(n.writtenAnswers), 'questions answered'],
  ];
  $numbers.innerHTML = tiles.map(([label, big, sub]) => `
    <div class="dd-stat-cell">
      <p class="dd-stat-label">${escapeHtml(label)}</p>
      <p class="dd-stat-big">${escapeHtml(big)}</p>
      <p class="dd-stat-sub">${escapeHtml(sub)}</p>
    </div>`).join('');
}

function renderSpikes(h) {
  const spikes = h.spikes || [];
  const days = h.baselineDays || 0;
  $spikesNote.textContent = days >= 3
    ? `Said far more than usual, against the previous ${days} sitting days. Each links to that day’s mentions.`
    : 'Most used today. Comparisons with previous days start once a few have been built.';
  if (!spikes.length) {
    $spikesList.innerHTML = '<li class="cm-empty-li">Nothing stood out.</li>';
    return;
  }
  $spikesList.innerHTML = spikes.map((s) => {
    const q = new URLSearchParams({ q: s.term, range: 'custom', from: state.date, to: state.date, house: state.house });
    return `<li><a class="dy-chip" href="./?${q}">${escapeHtml(s.term)} <span class="dy-chip-n">${num(s.count)}</span></a></li>`;
  }).join('');
}

function renderDivisions(h) {
  const divs = [...(h.divisions || [])].sort((a, b) => Math.abs(a.ayes - a.noes) - Math.abs(b.ayes - b.noes));
  if (!divs.length) {
    $divisionsList.innerHTML = `<li class="cm-empty-li">No divisions in the ${state.house}.</li>`;
    return;
  }
  const lords = state.house === 'Lords';
  $divisionsList.innerHTML = divs.map((d) => {
    const margin = Math.abs(d.ayes - d.noes);
    const sides = lords ? ['Content', 'Not content'] : ['Ayes', 'Noes'];
    const tags = [];
    if (d.deferred) tags.push('<span class="cm-tag">Deferred</span>');
    if (lords && d.governmentWin === false) tags.push('<span class="cm-tag cm-tag-upcoming">Government defeated</span>');
    const rebels = d.rebels || [];
    const rebelBits = rebels.slice(0, 12).map((r) =>
      `<span class="dy-rebel">${escapeHtml(r.name)} ${partyTag(r.party)} <span class="dy-rebel-voted">${escapeHtml(r.voted)}</span></span>`).join('');
    const more = rebels.length > 12 ? `<span class="cm-witness-more">+ ${rebels.length - 12} more</span>` : '';
    const rebelLine = rebels.length
      ? `<p class="dy-rebels"><span class="dy-rebels-label">Against their party:</span> ${rebelBits}${more}</p>`
      : '';
    return `<li class="cm-item">
      <h3 class="cm-item-title"><a href="${escapeHtml(d.link)}" target="_blank" rel="noopener">${escapeHtml(d.title)}</a></h3>
      <p class="cm-meta">
        <span class="dy-tally"><strong>${sides[0]} ${num(d.ayes)}</strong> &middot; <strong>${sides[1]} ${num(d.noes)}</strong> &middot; majority ${num(margin)}</span>
        ${d.time ? `<span class="cm-meta-date">${escapeHtml(formatTime(d.time))}</span>` : ''}
        ${tags.join('')}
      </p>
      ${rebelLine}
    </li>`;
  }).join('');
}

function partyTag(party) {
  if (!party) return '';
  return `<span class="party-tag" style="--c:${partyColor(party)}">${escapeHtml(partyShortName(party))}</span>`;
}

function renderSections(h) {
  const sections = h.sections || [];
  const groups = [];
  for (const [kind, label] of KIND_LABELS) {
    const list = sections.filter((s) => s.kind === kind);
    if (!list.length) continue;
    if (kind === 'questions') {
      // Fold a department's run of topics into one row.
      const byDept = new Map();
      for (const s of list) {
        const key = s.department || 'Questions';
        if (!byDept.has(key)) byDept.set(key, { ...s, title: `${key}${state.house === 'Commons' ? ' questions' : ''}`, topics: 0, speakers: 0, words: 0, top: [] });
        const g = byDept.get(key);
        g.topics += 1; g.speakers += s.speakers; g.words += s.words;
        if (!g.from || (s.from && s.from < g.from)) g.from = s.from;
        g.topicsList = (g.topicsList || []).concat(s.title);
      }
      groups.push([label, [...byDept.values()]]);
    } else {
      groups.push([label, list]);
    }
  }
  if (!groups.length) {
    $sectionsList.innerHTML = '<p class="cm-empty-li">Nothing on the record.</p>';
    return;
  }
  $sectionsList.innerHTML = groups.map(([label, list]) => `
    <section class="dy-group">
      <h3 class="dy-group-label">${escapeHtml(label)}</h3>
      <ol class="cm-list">${list.map(sectionRow).join('')}</ol>
    </section>`).join('');
}

function sectionRow(s) {
  const meta = [];
  if (s.from) meta.push(`from ${formatTime(s.from)}`);
  if (s.topics) meta.push(`${s.topics} topic${s.topics === 1 ? '' : 's'}`);
  if (s.speakers) meta.push(`${num(s.speakers)} speaker${s.speakers === 1 ? '' : 's'}`);
  if (s.words) meta.push(`${num(s.words)} words`);
  if (!s.contributions && !s.words && s.kind === 'legislation') meta.push('introduced, no debate');
  const top = (s.top || []).slice(0, 2).map((t) => `${escapeHtml(t.name)} ${partyTag(t.party)}`).join(', ');
  const topics = s.topicsList ? `<p class="cm-meta-line dy-topics">${s.topicsList.map(escapeHtml).join(' &middot; ')}</p>` : '';
  return `<li class="cm-item dy-section">
    <h4 class="cm-item-title"><a href="${escapeHtml(s.link)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a></h4>
    <p class="cm-meta-line">${meta.join(' · ')}${top ? ` · most from ${top}` : ''}</p>
    ${topics}
  </li>`;
}

function renderSpeakers(h) {
  const list = h.speakers || [];
  if (!list.length) { $speakersList.innerHTML = '<li class="cm-empty-li">Nobody spoke.</li>'; return; }
  $speakersList.innerHTML = list.slice(0, 8).map((s, i) => `
    <li class="dy-rank-row">
      <span class="dy-rank-n">${i + 1}</span>
      <span class="dy-rank-name">${escapeHtml(s.name)} ${partyTag(s.party)}</span>
      <span class="dy-rank-val">${num(s.words)} words<span class="dy-rank-sub"> in ${s.sections} debate${s.sections === 1 ? '' : 's'}</span></span>
    </li>`).join('');
}

function renderStatements(h) {
  const list = h.writtenStatements || [];
  if (!list.length) { $statementsList.innerHTML = '<li class="cm-empty-li">None today.</li>'; return; }
  $statementsList.innerHTML = list.map((s) => `
    <li class="cm-item">
      <p class="cm-item-title dy-small-title"><a href="${escapeHtml(s.link)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a></p>
      <p class="cm-meta-line">${escapeHtml(s.department)}${s.member ? ` · ${escapeHtml(s.member)}` : ''}</p>
    </li>`).join('');
}

function renderCommittees(d) {
  const list = [...(d.committees || [])].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (!list.length) { $committeesList.innerHTML = '<li class="cm-empty-li">No public evidence sessions.</li>'; return; }
  $committeesList.innerHTML = list.map((c) => {
    const who = (c.witnesses || []).slice(0, 4).map((w) => escapeHtml(w.name || w.org)).join(', ');
    const more = c.witnesses.length > 4 ? ` <span class="cm-witness-more">+ ${c.witnesses.length - 4} more</span>` : '';
    const title = c.inquiryId
      ? `<a href="committees.html?inquiry=${c.inquiryId}">${escapeHtml(c.inquiry || c.committee)}</a>`
      : escapeHtml(c.inquiry || c.committee);
    return `<li class="cm-item">
      <p class="cm-item-title dy-small-title">${title}</p>
      <p class="cm-meta-line">${c.time ? `${escapeHtml(formatTime(c.time))} · ` : ''}${escapeHtml(c.committee)}</p>
      ${who ? `<p class="cm-meta-line dy-witnesses">${who}${more}</p>` : ''}
    </li>`;
  }).join('');
}

function renderBills(d) {
  const bills = d.bills || [];
  const reports = d.reports || [];
  $billsList.innerHTML = bills.length
    ? bills.map((b) => `<li class="cm-item">
        <p class="cm-item-title dy-small-title"><a href="${escapeHtml(b.link)}" target="_blank" rel="noopener">${escapeHtml(b.title)}</a></p>
        <p class="cm-meta-line">${escapeHtml(b.stage)}${b.house ? `, ${escapeHtml(b.house)}` : ''}${b.government ? ' · government bill' : ''}</p>
      </li>`).join('')
    : '<li class="cm-empty-li">No bill stages.</li>';
  $reportsList.innerHTML = reports.length
    ? reports.map((r) => `<li class="cm-item">
        <p class="cm-item-title dy-small-title"><a href="${escapeHtml(r.link)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></p>
        <p class="cm-meta-line">${escapeHtml(r.type)} · ${escapeHtml(r.committee)}</p>
      </li>`).join('')
    : '';
}

function setStatus(msg, isError = false) {
  $status.textContent = msg;
  $status.classList.toggle('error', !!isError);
}

// ---------- wiring ----------

$house.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-house]');
  if (!btn || btn.disabled) return;
  state.house = btn.dataset.house;
  pushUrl();
  render();
});

for (const $a of [$prev, $next]) {
  $a.addEventListener('click', (e) => {
    e.preventDefault();
    showDay($a.dataset.date);
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
}

window.addEventListener('popstate', () => {
  const p = new URLSearchParams(location.search);
  state.house = p.get('house') === 'Lords' ? 'Lords' : 'Commons';
  const d = p.get('d');
  if (d && d !== state.date) showDay(d, { push: false });
  else render();
});

init();
