// House — Committees
// Search the parliamentary committee record: inquiries by name on the
// left, oral evidence sessions by witness/organisation on the right.
// The committees API doesn't expose transcript content for search, so
// this is a navigator into the record rather than a substitute for
// reading transcripts. The page UI says so plainly.

import {
  searchInquiries,
  searchOralEvidence,
  inquiryById,
  oralEvidenceTranscript,
  upcomingSessions,
  allUpcomingSessions,
} from './api.js?v=10';
import { formatDate, formatDayLong, formatTime, escapeHtml, snippetHtml, buildSearchRegex } from './format.js?v=8';

// ---------- state ----------

const state = {
  // Discovery view (top-level search)
  term: '',
  preset: 'year',
  customFrom: '',
  customTo: '',
  startDate: '',
  endDate: '',
  inquiries: [],
  sessions: [],
  inquiriesTotal: 0,
  sessionsTotal: 0,
  searchToken: 0,
  // View routing
  view: 'list',                  // 'list' | 'inquiry'
  // Drill-in view (one inquiry)
  currentInquiry: null,          // { id, title, ... }
  inquirySessions: [],
  inquiryTerm: '',               // within-inquiry search term
  inquiryMatches: [],            // [{ session, snippets: [{ index, html }] }]
  inquiryTranscripts: new Map(), // sessionId → { text, html }
  inquiryToken: 0,
  // Cache of inquiry scope/descriptions, keyed by inquiry id. Filled
  // lazily after a search renders so result rows can show a one-line
  // summary of what the inquiry is actually about.
  inquiryDescriptions: new Map(),
  // Upcoming oral evidence. `upcoming` is the next seven days, shown as
  // the Coming up strip in browse mode. `upcomingPool` is a wider window
  // fetched once per visit and filtered client-side when a search runs,
  // because the Events endpoint can't search witness names itself.
  upcoming: [],
  upcomingLoaded: false,
  upcomingExpanded: false,
  upcomingPool: null,
  upcomingPoolAt: 0,
  upcomingMatches: [],
  inquiryUpcoming: [],
};

const TRANSCRIPT_CONCURRENCY = 4;
const MAX_SNIPPETS_PER_SESSION = 8;
const UPCOMING_WEEK_DAYS = 7;
const UPCOMING_POOL_DAYS = 42;
const UPCOMING_COLLAPSED = 6;
const UPCOMING_POOL_TTL_MS = 5 * 60_000;

// ---------- DOM ----------

const $form         = document.getElementById('cm-form');
const $q            = document.getElementById('cm-q');
const $datePresets  = document.getElementById('cm-date-presets');
const $customDates  = document.getElementById('cm-custom-dates');
const $fromDate     = document.getElementById('cm-from-date');
const $toDate       = document.getElementById('cm-to-date');
const $ftSummary    = document.getElementById('cm-ft-summary');
const $status       = document.getElementById('cm-status');
const $results      = document.getElementById('cm-results');
const $inquiries    = document.getElementById('cm-inquiries');
const $sessions     = document.getElementById('cm-sessions');
const $inquiriesLabel = document.getElementById('cm-inquiries-label');
const $sessionsLabel  = document.getElementById('cm-sessions-label');
const $inquiriesNote  = document.getElementById('cm-inquiries-note');
const $sessionsNote   = document.getElementById('cm-sessions-note');
const $upcoming       = document.getElementById('cm-upcoming');
const $upcomingList   = document.getElementById('cm-upcoming-list');
const $upcomingMore   = document.getElementById('cm-upcoming-more');

// Drill-in view DOM
const $inquiryView   = document.getElementById('cm-inquiry-view');
const $back          = document.getElementById('cm-back');
const $inqMeta       = document.getElementById('cm-inquiry-meta');
const $inqTitle      = document.getElementById('cm-inquiry-title');
const $inqExtLink    = document.getElementById('cm-inquiry-extlink-a');
const $inqForm       = document.getElementById('cm-inquiry-form');
const $itInput       = document.getElementById('cm-it-input');
const $itStatus      = document.getElementById('cm-it-status');
const $inqSessions   = document.getElementById('cm-inquiry-sessions-list');
const $inqSessionsLabel = document.getElementById('cm-inquiry-sessions-label');
const $inqMatchesWrap = document.getElementById('cm-inquiry-matches');
const $inqMatches    = document.getElementById('cm-inquiry-matches-list');

// ---------- filter wiring ----------

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

function updateFiltersSummary() {
  const presetLabels = { month: 'Last month', year: 'Last year', five: 'Last 5 years' };
  if (state.preset === 'custom') {
    if (state.customFrom || state.customTo) $ftSummary.textContent = `· ${state.customFrom || '…'} – ${state.customTo || '…'}`;
    else $ftSummary.textContent = '· Custom range';
  } else {
    $ftSummary.textContent = presetLabels[state.preset] ? `· ${presetLabels[state.preset]}` : '';
  }
}

// ---------- date range helper (mirrors Search/Deep Dive) ----------

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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function plusDays(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

// ---------- search ----------

async function runSearch(pushUrl) {
  const myToken = ++state.searchToken;
  state.term = $q.value.trim();
  // Empty search → drop back to the browse view rather than scolding.
  if (!state.term) {
    if (pushUrl) pushUrlState();
    runBrowse();
    return;
  }
  setPanelLabels('search');
  const { startDate, endDate } = dateRange();
  state.startDate = startDate;
  state.endDate   = endDate;

  if (pushUrl) pushUrlState();
  setStatus('Searching…');
  $form.classList.add('is-loading');
  syncUpcomingVisibility();
  // Only paint the discovery view if we're actually in it — drill-in
  // view stays on top.
  if (state.view === 'list') $results.hidden = false;
  $inquiries.innerHTML = '';
  $sessions.innerHTML = '';

  try {
    const [inqRes, sesRes, upRes] = await Promise.allSettled([
      searchInquiries({ searchTerm: state.term, startDate, endDate, take: 20 }),
      searchOralEvidence({ searchTerm: state.term, startDate, endDate, take: 30 }),
      upcomingPool(),
    ]);
    if (myToken !== state.searchToken) return;

    // Upcoming matches ride along in the sessions panel. The pool is a
    // bonus, so a failure here is silent: the past record still renders.
    state.upcomingMatches = upRes.status === 'fulfilled'
      ? upRes.value.filter((s) => upcomingMatches(s, state.term))
      : [];

    const errors = [];
    if (inqRes.status === 'fulfilled') {
      state.inquiries = inqRes.value.items;
      state.inquiriesTotal = inqRes.value.total;
    } else {
      state.inquiries = [];
      state.inquiriesTotal = 0;
      errors.push(`inquiries: ${inqRes.reason?.message || 'failed'}`);
    }
    if (sesRes.status === 'fulfilled') {
      state.sessions = sesRes.value.items;
      state.sessionsTotal = sesRes.value.total;
    } else {
      state.sessions = [];
      state.sessionsTotal = 0;
      errors.push(`sessions: ${sesRes.reason?.message || 'failed'}`);
    }

    renderInquiries();
    renderSessions();
    enrichInquiriesWithDescriptions(myToken);

    const upN = state.upcomingMatches.length;
    const upLabel = upN ? `, plus ${upN} upcoming` : '';
    if (errors.length) {
      setStatus(`Some results failed to load: ${errors.join('; ')}.`, true);
    } else if (state.inquiries.length === 0 && state.sessions.length === 0 && upN === 0) {
      setStatus(`No inquiries or sessions matched “${state.term}”. Try a different name, organisation, or date range.`);
    } else {
      const inqLabel = state.inquiriesTotal === 1 ? '1 inquiry' : `${state.inquiriesTotal.toLocaleString('en-GB')} inquiries`;
      const sesLabel = state.sessionsTotal === 1 ? '1 session' : `${state.sessionsTotal.toLocaleString('en-GB')} sessions`;
      setStatus(`Showing the most recent ${state.inquiries.length} of ${inqLabel} and ${state.sessions.length} of ${sesLabel}${upLabel}.`);
    }
  } finally {
    if (myToken === state.searchToken) $form.classList.remove('is-loading');
  }
}

// ---------- browse mode (empty-state landing) ----------
//
// When the page loads with no search term, fill the two panels with
// "what's been happening at committees lately" so the page is useful
// for browse-discovery, not just for users with a specific query in
// mind. Search submission switches us back to results mode.

async function runBrowse() {
  const myToken = ++state.searchToken;
  state.term = '';
  setStatus('Loading recent committee activity…');
  $form.classList.add('is-loading');
  if (state.view === 'list') $results.hidden = false;
  $inquiries.innerHTML = '';
  $sessions.innerHTML = '';
  state.upcomingMatches = [];
  setPanelLabels('browse');
  try {
    const today = todayIso();
    const ago = (days) => plusDays(-days);
    const [inqRes, sesRes, upRes] = await Promise.allSettled([
      // Most-recently-opened inquiries (whether or not currently taking
      // evidence) — tells the user what the committees are working on.
      searchInquiries({ startDate: ago(180), endDate: today, take: 15 }),
      searchOralEvidence({ startDate: ago(60), endDate: today, take: 30 }),
      // And what's on the calendar for the coming week.
      upcomingSessions({ startDate: today, endDate: plusDays(UPCOMING_WEEK_DAYS), take: 100 }),
    ]);
    if (myToken !== state.searchToken) return;
    state.inquiries = inqRes.status === 'fulfilled' ? inqRes.value.items : [];
    state.sessions  = sesRes.status === 'fulfilled' ? sesRes.value.items : [];
    state.inquiriesTotal = inqRes.status === 'fulfilled' ? inqRes.value.total : 0;
    state.sessionsTotal  = sesRes.status === 'fulfilled' ? sesRes.value.total : 0;
    // A failed upcoming fetch hides the strip rather than showing an
    // error; the record below is the main event.
    state.upcoming = upRes.status === 'fulfilled' ? upRes.value.items : [];
    state.upcomingLoaded = upRes.status === 'fulfilled';
    renderInquiries();
    renderSessions();
    renderUpcoming();
    syncUpcomingVisibility();
    loadFeedManifest();
    enrichInquiriesWithDescriptions(myToken);
    setStatus('Recent activity. Type a term to search the committee record.');
  } finally {
    if (myToken === state.searchToken) $form.classList.remove('is-loading');
  }
}

// ---------- upcoming (Coming up strip + search matches) ----------

// The strip shows only in browse mode, in the list view, once loaded.
function syncUpcomingVisibility() {
  $upcoming.hidden = state.view !== 'list' || !!state.term || !state.upcomingLoaded;
}

// Six weeks of upcoming sessions, fetched once and reused for the life
// of the page (or five minutes, whichever is shorter).
async function upcomingPool() {
  const fresh = state.upcomingPool && (Date.now() - state.upcomingPoolAt) < UPCOMING_POOL_TTL_MS;
  if (fresh) return state.upcomingPool;
  const items = await allUpcomingSessions({ startDate: todayIso(), endDate: plusDays(UPCOMING_POOL_DAYS) });
  state.upcomingPool = items;
  state.upcomingPoolAt = Date.now();
  return items;
}

// Same matching rule as the transcript search: acronyms match whole
// words case-sensitively, anything else is a case-insensitive substring.
// Checked against witness names, their organisations, the committee and
// the inquiry title — the same fields the past-sessions search covers.
function upcomingMatches(s, term) {
  const re = buildSearchRegex(term);
  const fields = [s.committee, s.inquiryTitle];
  for (const w of s.witnesses) fields.push(w.name, w.context, ...w.organisations);
  return fields.some((f) => f && re.test(f));
}

function renderUpcoming() {
  if (!state.upcoming.length) {
    $upcomingList.innerHTML = '<p class="cm-empty-li">No public oral evidence sessions are scheduled for the next seven days.</p>';
    $upcomingMore.hidden = true;
    return;
  }
  const items = state.upcoming;
  const shown = state.upcomingExpanded ? items : items.slice(0, UPCOMING_COLLAPSED);
  const today = todayIso();
  const tomorrow = plusDays(1);
  const byDay = new Map();
  for (const s of shown) {
    if (!byDay.has(s.date)) byDay.set(s.date, []);
    byDay.get(s.date).push(s);
  }
  $upcomingList.innerHTML = [...byDay.entries()].map(([date, list]) => {
    const when = date === today ? '<span class="cm-tag cm-tag-upcoming">Today</span>'
      : date === tomorrow ? '<span class="cm-tag">Tomorrow</span>' : '';
    return `<section class="cm-upcoming-day">
      <h3 class="cm-upcoming-day-label">${escapeHtml(formatDayLong(date))} ${when}</h3>
      <ol class="cm-list">${list.map(upcomingRowHtml).join('')}</ol>
    </section>`;
  }).join('');
  $upcomingMore.hidden = items.length <= UPCOMING_COLLAPSED;
  $upcomingMore.textContent = state.upcomingExpanded
    ? 'Show fewer'
    : `Show all ${items.length} sessions this week`;
  $upcomingMore.setAttribute('aria-expanded', String(state.upcomingExpanded));
}

function upcomingRowHtml(s) {
  const title = s.inquiryTitle || s.committee || 'Oral evidence';
  const titleEl = s.inquiryId
    ? `<button type="button" class="cm-drill-btn" data-inquiry-id="${s.inquiryId}">${escapeHtml(title)}</button>`
    : escapeHtml(title);
  const where = [s.committee, s.location].filter(Boolean).map(escapeHtml).join(' · ');
  return `<li class="cm-upcoming-item">
    <p class="cm-upcoming-time">${escapeHtml(formatTime(s.time))}</p>
    <div class="cm-upcoming-body">
      <p class="cm-upcoming-committee">${where}</p>
      <p class="cm-upcoming-title">${titleEl}</p>
      ${witnessesHtml(s.witnesses, 4)}
      <p class="cm-meta-line">${calendarLinkHtml(s)}</p>
    </div>
  </li>`;
}

// An upcoming session in the same shape as a past one, for the sessions
// panel and the inquiry view. Tagged, and with a calendar link where a
// past session has its transcript link.
function upcomingSessionItemHtml(s, { showInquiry = true } = {}) {
  const dateLabel = `${escapeHtml(formatDate(s.date))}${s.time ? `, ${escapeHtml(formatTime(s.time))}` : ''}`;
  const titleEl = s.inquiryId
    ? `<button type="button" class="cm-drill-btn" data-inquiry-id="${s.inquiryId}">${dateLabel}</button>`
    : dateLabel;
  const inquiryBit = showInquiry && s.inquiryTitle
    ? `<p class="cm-meta-line">${s.inquiryId
        ? `<button type="button" class="cm-meta-inquiry-btn" data-inquiry-id="${s.inquiryId}">${escapeHtml(s.inquiryTitle)}</button>`
        : `<span class="cm-meta-inquiry">${escapeHtml(s.inquiryTitle)}</span>`}</p>`
    : '';
  const witnesses = s.witnesses.length
    ? witnessesHtml(s.witnesses, 4)
    : '<p class="cm-witnesses"><span class="cm-witness-more">Witnesses to be announced</span></p>';
  return `<li class="cm-item">
    <h3 class="cm-item-title">${titleEl}</h3>
    <p class="cm-meta"><span class="cm-tag cm-tag-upcoming">Upcoming</span><span class="cm-meta-committee">${escapeHtml(s.committee)}</span></p>
    ${inquiryBit}
    ${witnesses}
    <p class="cm-meta-line">${calendarLinkHtml(s)}</p>
  </li>`;
}

// A calendar entry for one upcoming session, as a data: link the
// browser saves as an .ics file. Parliament publishes its own file per
// event but titles every one "Untitled", so this one carries the
// inquiry, the committee, the room and the witnesses. Times are written
// as London wall-clock time with no zone, the same convention as
// Parliament's file: the sessions happen in Westminster and that's the
// time a reader wants to see.
function calendarHref(s) {
  const stamp = (date, hhmm) => `${date.replace(/-/g, '')}T${(hhmm || '00:00').replace(':', '')}00`;
  const endTime = s.endTime && s.endTime > s.time ? s.endTime : addMinutes(s.time, 120);
  const who = s.witnesses.map((w) => {
    const orgs = w.organisations.join(', ');
    return w.name ? (orgs ? `${w.name} (${orgs})` : w.name) : orgs;
  }).filter(Boolean);
  const summary = [s.inquiryTitle || 'Oral evidence', s.committee].filter(Boolean).join(' · ');
  const description = [
    `Oral evidence session, ${s.committee}.`,
    who.length ? `Witnesses: ${who.join('; ')}.` : 'Witnesses to be announced.',
    s.eventLink,
  ].join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//House//Committees//EN',
    'BEGIN:VEVENT',
    `UID:house-committee-event-${s.id}@peter-guillam123.github.io`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART:${stamp(s.date, s.time)}`,
    `DTEND:${stamp(s.date, endTime)}`,
    `SUMMARY:${icsText(summary)}`,
    s.location ? `LOCATION:${icsText(s.location)}` : '',
    `DESCRIPTION:${icsText(description)}`,
    `URL:${s.eventLink}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).map(icsFold);
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join('\r\n') + '\r\n')}`;
}

function calendarFilename(s) {
  const slug = String(s.inquiryTitle || s.committee || 'oral-evidence')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `${s.date}-${slug}.ics`;
}

function addMinutes(hhmm, mins) {
  const [h, m] = (hhmm || '00:00').split(':').map((n) => parseInt(n, 10) || 0);
  const total = Math.min(h * 60 + m + mins, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// iCalendar escaping: backslash, newline, comma and semicolon.
function icsText(t) {
  return String(t || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

// Lines longer than 75 octets are folded with a CRLF + space.
function icsFold(line) {
  const out = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ' ' + rest.slice(74);
  }
  out.push(rest);
  return out.join('\r\n');
}

function calendarLinkHtml(s) {
  return `<a class="cm-secondary-link" href="${escapeHtml(calendarHref(s))}" download="${escapeHtml(calendarFilename(s))}">Add to calendar</a>`;
}

function witnessesHtml(witnesses, max) {
  if (!witnesses.length) return '';
  const bits = witnesses.slice(0, max).map((w) => {
    const orgs = w.organisations.length ? w.organisations.join(', ') : '';
    const primary = w.name || orgs || '?';
    const ctx = w.name ? (orgs || w.context) : '';
    return `<span class="cm-witness">${escapeHtml(primary)}${ctx ? ` <span class="cm-witness-ctx">(${escapeHtml(ctx)})</span>` : ''}</span>`;
  }).join('');
  const more = witnesses.length > max ? `<span class="cm-witness-more">+ ${witnesses.length - max} more</span>` : '';
  return `<p class="cm-witnesses">${bits}${more}</p>`;
}

$upcomingMore.addEventListener('click', () => {
  state.upcomingExpanded = !state.upcomingExpanded;
  renderUpcoming();
  // Collapsing can leave the button far below the strip; bring the
  // strip's top back into view so the reader isn't stranded.
  if (!state.upcomingExpanded) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $upcoming.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }
});

$upcomingList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-inquiry-id]');
  if (!btn) return;
  enterInquiryView(Number(btn.dataset.inquiryId), { pushUrl: true });
});

// ---------- subscribable feeds ----------
//
// tools/build-calendar.py writes calendar/committees.json and one .ics
// per committee; GitHub Actions rebuilds them four times a day. The
// manifest is fetched relative to the page so the same code works on
// GitHub Pages and on localhost. If it isn't there (a fresh checkout
// before the first build), the subscribe block simply stays hidden.

const $subscribe       = document.getElementById('cm-subscribe');
const $subscribeSelect = document.getElementById('cm-subscribe-select');
const $subscribeLink   = document.getElementById('cm-subscribe-link');
const $subscribeCopy   = document.getElementById('cm-subscribe-copy');
const $subscribeNote   = document.getElementById('cm-subscribe-note');
const CALENDAR_BASE = new URL('calendar/', location.href);
let subscribeNoteDefault = $subscribeNote.textContent;

async function loadFeedManifest() {
  if ($subscribeSelect.options.length > 1) return;
  let manifest;
  try {
    const r = await fetch(new URL('committees.json', CALENDAR_BASE), { cache: 'no-cache' });
    if (!r.ok) return;
    manifest = await r.json();
  } catch { return; }
  if (!manifest || !Array.isArray(manifest.committees)) return;
  $subscribeSelect.options[0].dataset.file = manifest.all || 'committees.ics';
  // Group by House so a long list stays scannable.
  const groups = new Map();
  for (const c of manifest.committees) {
    const key = c.house || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const house of ['Commons', 'Lords', 'Joint', 'Other']) {
    const list = groups.get(house);
    if (!list) continue;
    const og = document.createElement('optgroup');
    og.label = house;
    for (const c of list) {
      const opt = document.createElement('option');
      opt.value = String(c.id);
      opt.dataset.file = c.file;
      opt.textContent = c.upcoming ? `${c.name} (${c.upcoming})` : c.name;
      og.appendChild(opt);
    }
    $subscribeSelect.appendChild(og);
  }
  syncSubscribeLink();
  $subscribe.hidden = false;
}

function feedUrl() {
  const opt = $subscribeSelect.selectedOptions[0];
  const file = opt?.dataset.file || 'committees.ics';
  return new URL(file, CALENDAR_BASE);
}

function syncSubscribeLink() {
  const https = feedUrl();
  // webcal:// is what Apple Calendar and Outlook listen for; it's the
  // same address with the scheme swapped.
  $subscribeLink.href = https.href.replace(/^https?:/, 'webcal:');
  $subscribeNote.textContent = subscribeNoteDefault;
  $subscribeNote.classList.remove('is-done');
}

$subscribeSelect.addEventListener('change', syncSubscribeLink);

$subscribeCopy.addEventListener('click', async () => {
  const address = feedUrl().href;
  try {
    await navigator.clipboard.writeText(address);
    $subscribeNote.textContent = `Copied. In Google Calendar, choose Other calendars, From URL, and paste it in.`;
  } catch {
    $subscribeNote.textContent = `Copy this address: ${address}`;
  }
  $subscribeNote.classList.add('is-done');
});

function setPanelLabels(mode) {
  if (mode === 'browse') {
    $inquiriesLabel.textContent = 'Recent inquiries';
    $inquiriesNote.textContent  = 'Started in the last 6 months.';
    $sessionsLabel.textContent  = 'Recent oral evidence';
    $sessionsNote.textContent   = 'Sessions in the last 60 days.';
  } else {
    $inquiriesLabel.textContent = 'Inquiries & sessions';
    $inquiriesNote.textContent  = 'Matched on title.';
    $sessionsLabel.textContent  = 'Oral evidence';
    $sessionsNote.textContent   = 'Matched on witness name or organisation.';
  }
}

// ---------- rendering ----------

function renderInquiries() {
  if (!state.inquiries.length) {
    $inquiries.innerHTML = '<li class="cm-empty-li">No inquiries matched the term in their name.</li>';
    return;
  }
  $inquiries.innerHTML = state.inquiries.map((inq) => {
    const status = inquiryStatus(inq);
    const dateRange = inq.openDate
      ? (inq.closeDate && inq.closeDate !== inq.openDate
          ? `${formatDate(inq.openDate)} – ${formatDate(inq.closeDate)}`
          : formatDate(inq.openDate))
      : '';
    const reportBit = inq.latestReport && inq.latestReport.title
      ? `<p class="cm-meta-line">Latest report: ${escapeHtml(inq.latestReport.title)}${inq.latestReport.date ? ` (${formatDate(inq.latestReport.date)})` : ''}</p>`
      : '';
    const desc = state.inquiryDescriptions.get(inq.id);
    const descBit = desc
      ? `<p class="cm-inquiry-desc">${escapeHtml(truncateText(desc, 240))}</p>`
      : '';
    return `<li class="cm-item">
      <h3 class="cm-item-title"><button type="button" class="cm-drill-btn" data-inquiry-id="${inq.id}">${escapeHtml(inq.title || '(untitled)')}</button></h3>
      <p class="cm-meta">
        <span class="cm-tag">${escapeHtml(inq.typeName || 'Inquiry')}</span>
        ${status ? `<span class="cm-tag cm-tag-${status.cls}">${escapeHtml(status.label)}</span>` : ''}
        ${dateRange ? `<span class="cm-meta-date">${escapeHtml(dateRange)}</span>` : ''}
      </p>
      ${descBit}
      ${reportBit}
    </li>`;
  }).join('');
}

function truncateText(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

// Fire-and-forget: after a search/browse renders the inquiries panel,
// fetch the detail endpoint for any inquiry whose scope description
// we haven't cached yet, then re-render so the descriptions appear.
// Skips quietly if the response is missing scope.
async function enrichInquiriesWithDescriptions(myToken) {
  const todo = state.inquiries.filter((i) => !state.inquiryDescriptions.has(i.id));
  if (!todo.length) return;
  await Promise.all(todo.map(async (inq) => {
    try {
      const detail = await inquiryById(inq.id);
      if (detail && detail.scope) state.inquiryDescriptions.set(inq.id, detail.scope);
      else state.inquiryDescriptions.set(inq.id, '');
    } catch { /* swallow — row just renders without description */ }
  }));
  if (myToken !== state.searchToken) return;
  renderInquiries();
}

// Click delegation — a title click drills into the inquiry view.
$inquiries.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-inquiry-id]');
  if (!btn) return;
  enterInquiryView(Number(btn.dataset.inquiryId), { pushUrl: true });
});

function inquiryStatus(inq) {
  if (!inq.openDate) return null;
  const today = new Date().toISOString().slice(0, 10);
  // Some "Inquiry" rows have openDate === closeDate (legacy/imported
  // records) — treat those as closed, otherwise we'd flag them open.
  if (inq.closeDate && inq.closeDate !== inq.openDate && inq.closeDate < today) {
    return { label: 'Closed', cls: 'closed' };
  }
  if (inq.closeDate && inq.closeDate !== inq.openDate) return { label: 'Open', cls: 'open' };
  return null;
}

function renderSessions() {
  const upcoming = state.upcomingMatches || [];
  if (!state.sessions.length && !upcoming.length) {
    $sessions.innerHTML = '<li class="cm-empty-li">No sessions matched the term in witness or organisation metadata.</li>';
    return;
  }
  // Upcoming first (soonest at the top), then the record newest first.
  const upcomingHtml = [...upcoming]
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || ''))
    .map((s) => upcomingSessionItemHtml(s))
    .join('');
  const sorted = [...state.sessions].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  $sessions.innerHTML = upcomingHtml + sorted.map((s) => {
    const witnessBits = s.witnesses.slice(0, 4).map((w) => {
      const orgs = w.organisations.length ? w.organisations.join(', ') : '';
      const primary = w.name || orgs || '?';
      const ctx = w.name ? (orgs || w.context) : '';
      return `<span class="cm-witness">${escapeHtml(primary)}${ctx ? ` <span class="cm-witness-ctx">(${escapeHtml(ctx)})</span>` : ''}</span>`;
    }).join('');
    const moreBit = s.witnesses.length > 4 ? `<span class="cm-witness-more">+ ${s.witnesses.length - 4} more</span>` : '';
    // Title: drill into the parent inquiry's view (where the within-inquiry
    // search lives). Fall back to opening the transcript directly if the
    // session has no parent inquiry.
    const dateLabel = s.date ? escapeHtml(formatDate(s.date)) : 'Oral evidence';
    const titleEl = s.inquiryId
      ? `<button type="button" class="cm-drill-btn" data-inquiry-id="${s.inquiryId}" data-session-id="${s.id}">${dateLabel}</button>`
      : `<a href="${escapeHtml(s.transcriptLink)}" target="_blank" rel="noopener">${dateLabel}</a>`;
    const inquiryBit = s.inquiryTitle
      ? (s.inquiryId
          ? `<button type="button" class="cm-meta-inquiry-btn" data-inquiry-id="${s.inquiryId}">${escapeHtml(s.inquiryTitle)}</button>`
          : `<span class="cm-meta-inquiry">${escapeHtml(s.inquiryTitle)}</span>`)
      : '';
    return `<li class="cm-item">
      <h3 class="cm-item-title">${titleEl}</h3>
      ${inquiryBit ? `<p class="cm-meta-line">${inquiryBit}</p>` : ''}
      <p class="cm-witnesses">${witnessBits}${moreBit}</p>
      <p class="cm-meta-line"><a class="cm-secondary-link" href="${escapeHtml(s.transcriptLink)}" target="_blank" rel="noopener">Read transcript ↗</a></p>
    </li>`;
  }).join('');
}

// Click delegation — title or inquiry-meta on a session row drills into
// that session's parent inquiry (and remembers which session you came
// from so we can scroll to it once the inquiry view's session list
// has rendered).
$sessions.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-inquiry-id]');
  if (!btn) return;
  const inquiryId = Number(btn.dataset.inquiryId);
  const sessionId = btn.dataset.sessionId ? Number(btn.dataset.sessionId) : null;
  enterInquiryView(inquiryId, { pushUrl: true, focusSessionId: sessionId });
});

// ---------- status ----------

function setStatus(msg, isError = false) {
  $status.textContent = msg;
  $status.classList.toggle('error', !!isError);
}

function setItStatus(msg, isError = false) {
  $itStatus.textContent = msg;
  $itStatus.classList.toggle('error', !!isError);
}

// ---------- view routing ----------

function renderView() {
  const isInquiry = state.view === 'inquiry';
  $inquiryView.hidden = !isInquiry;
  $results.hidden = isInquiry || state.inquiries.length === 0 && state.sessions.length === 0 && state.upcomingMatches.length === 0;
  syncUpcomingVisibility();
}

// ---------- drill-in view ----------

async function enterInquiryView(id, { pushUrl = false, focusSessionId = null } = {}) {
  const myToken = ++state.inquiryToken;
  state.view = 'inquiry';
  state.focusSessionId = focusSessionId;

  // Look up cached metadata first; fetch if we don't have it (direct URL load).
  let inquiry = state.inquiries.find((i) => i.id === id);
  if (!inquiry) {
    // Show the drill-in view straight away with a loading header, so a
    // click from the Coming up strip (whose inquiries aren't in the
    // results list) gets a response before the detail fetch lands.
    renderInquiryHeader({ title: 'Loading inquiry…' });
    $inqSessions.innerHTML = '';
    renderView();
    scrollToInquiryView();
    try {
      inquiry = await inquiryById(id);
    } catch (e) {
      setItStatus(`Couldn't load inquiry ${id}. ${e.message || ''}`, true);
      return;
    }
    if (myToken !== state.inquiryToken) return;
  }
  state.currentInquiry = inquiry;
  state.inquirySessions = [];
  state.inquiryUpcoming = [];
  state.inquiryTerm = '';
  state.inquiryMatches = [];
  // Don't clear inquiryTranscripts — they're keyed by session id and
  // persist across re-entries to the same inquiry, saving fetches.
  $itInput.value = '';
  $inqMatchesWrap.hidden = true;
  setItStatus('');

  if (pushUrl) pushUrlState();
  renderInquiryHeader(inquiry);
  renderView();
  scrollToInquiryView();

  // Fetch the inquiry's sessions, past and scheduled.
  try {
    $inqSessions.innerHTML = '<li class="cm-empty-li">Loading sessions…</li>';
    const [result, upRes] = await Promise.allSettled([
      searchOralEvidence({ committeeBusinessId: id, take: 100 }),
      upcomingSessions({ committeeBusinessId: id, startDate: todayIso(), endDate: plusDays(180), take: 50 }),
    ]);
    if (myToken !== state.inquiryToken) return;
    if (result.status !== 'fulfilled') throw result.reason;
    // Newest first
    state.inquirySessions = result.value.items.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    state.inquiryUpcoming = upRes.status === 'fulfilled' ? upRes.value.items : [];
    renderInquirySessions();
    // If URL carried a within-inquiry term, run it now.
    const urlTerm = new URLSearchParams(location.search).get('it') || '';
    if (urlTerm) {
      $itInput.value = urlTerm;
      searchWithinInquiry(urlTerm);
    }
  } catch (e) {
    $inqSessions.innerHTML = `<li class="cm-empty-li">Couldn't load sessions. ${escapeHtml(e.message || '')}</li>`;
  }
}

function exitInquiryView({ pushUrl = true } = {}) {
  state.view = 'list';
  state.currentInquiry = null;
  state.inquirySessions = [];
  state.inquiryTerm = '';
  state.inquiryMatches = [];
  state.inquiryToken++;        // cancel any in-flight transcript fetches
  if (pushUrl) pushUrlState();
  renderView();
  if (state.inquiries.length || state.sessions.length) $results.hidden = false;
  // Arrived by a shared inquiry link, so there's nothing behind us yet:
  // fill the browse view rather than leaving an empty page.
  else if (!state.term) runBrowse();
}

function renderInquiryHeader(inq) {
  if (!inq) return;
  const meta = [];
  if (inq.typeName) meta.push(inq.typeName);
  const status = inquiryStatus(inq);
  if (status) meta.push(status.label);
  if (inq.openDate) {
    const range = inq.closeDate && inq.closeDate !== inq.openDate
      ? `${formatDate(inq.openDate)} – ${formatDate(inq.closeDate)}`
      : formatDate(inq.openDate);
    meta.push(range);
  }
  $inqMeta.textContent = meta.join(' · ');
  $inqTitle.textContent = inq.title || '—';
  if (inq.link) {
    $inqExtLink.href = inq.link;
    $inqExtLink.parentElement.hidden = false;
  } else {
    $inqExtLink.parentElement.hidden = true;
  }
}

function renderInquirySessions() {
  const upcoming = state.inquiryUpcoming || [];
  if (!state.inquirySessions.length && !upcoming.length) {
    $inqSessions.innerHTML = '<li class="cm-empty-li">No oral evidence sessions in this inquiry.</li>';
    $inqSessionsLabel.textContent = 'Oral evidence sessions';
    return;
  }
  const past = state.inquirySessions.length;
  $inqSessionsLabel.textContent = upcoming.length
    ? `Oral evidence sessions · ${past} past · ${upcoming.length} upcoming`
    : `Oral evidence sessions · ${past}`;
  const upcomingHtml = [...upcoming]
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || ''))
    .map((s) => upcomingSessionItemHtml(s, { showInquiry: false }))
    .join('');
  $inqSessions.innerHTML = upcomingHtml + state.inquirySessions.map((s) => {
    const witnessBits = s.witnesses.slice(0, 5).map((w) => {
      const orgs = w.organisations.length ? w.organisations.join(', ') : '';
      const primary = w.name || orgs || '?';
      const ctx = w.name ? (orgs || w.context) : '';
      return `<span class="cm-witness">${escapeHtml(primary)}${ctx ? ` <span class="cm-witness-ctx">(${escapeHtml(ctx)})</span>` : ''}</span>`;
    }).join('');
    const more = s.witnesses.length > 5 ? `<span class="cm-witness-more">+ ${s.witnesses.length - 5} more</span>` : '';
    const isFocus = state.focusSessionId === s.id;
    return `<li class="cm-item${isFocus ? ' is-focus' : ''}" data-session-id="${s.id}">
      <h3 class="cm-item-title"><a href="${escapeHtml(s.transcriptLink)}" target="_blank" rel="noopener">${s.date ? escapeHtml(formatDate(s.date)) : 'Oral evidence'}</a></h3>
      <p class="cm-witnesses">${witnessBits}${more}</p>
    </li>`;
  }).join('');
  // If we entered via clicking a specific session, scroll it into view.
  if (state.focusSessionId) {
    const el = $inqSessions.querySelector(`[data-session-id="${state.focusSessionId}"]`);
    if (el) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    }
    state.focusSessionId = null;
  }
}

// ---------- within-inquiry full-text search ----------

async function searchWithinInquiry(rawTerm) {
  const myToken = state.inquiryToken;
  const term = (rawTerm || '').trim();
  state.inquiryTerm = term;
  pushUrlState();
  if (!term) {
    state.inquiryMatches = [];
    $inqMatchesWrap.hidden = true;
    setItStatus('');
    return;
  }
  if (!state.inquirySessions.length) {
    setItStatus('No sessions to search yet.');
    return;
  }

  // Identify which sessions still need their transcript fetched.
  const uncached = state.inquirySessions.filter((s) => !state.inquiryTranscripts.has(s.id));
  const total = state.inquirySessions.length;

  $inqForm.classList.add('is-loading');
  setItStatus(uncached.length
    ? `Fetching ${uncached.length} of ${total} transcripts…`
    : `Searching ${total} cached transcripts…`);
  $inqMatchesWrap.hidden = true;

  // Bounded-concurrency fetch — like Deep Dive's month streaming.
  let loaded = state.inquirySessions.length - uncached.length;
  const queue = [...uncached];
  await Promise.all(Array.from({ length: TRANSCRIPT_CONCURRENCY }, async () => {
    while (queue.length && myToken === state.inquiryToken) {
      const s = queue.shift();
      try {
        const doc = await oralEvidenceTranscript(s.id);
        if (myToken !== state.inquiryToken) return;
        state.inquiryTranscripts.set(s.id, doc);
      } catch (e) {
        // Mark as fetched-with-empty so we don't retry this session.
        state.inquiryTranscripts.set(s.id, { text: '', html: '' });
      }
      loaded++;
      setItStatus(`Loaded ${loaded} of ${total} transcripts…`);
    }
  }));
  if (myToken !== state.inquiryToken) return;

  // Search each cached transcript segment-by-segment so snippets carry
  // the speaker who said them.
  const matches = [];
  for (const session of state.inquirySessions) {
    const cached = state.inquiryTranscripts.get(session.id);
    if (!cached || !cached.segments || !cached.segments.length) continue;
    const { snippets, totalHits } = findAllMatchesInSegments(cached.segments, term);
    if (snippets.length) matches.push({ session, snippets, total: totalHits });
  }
  state.inquiryMatches = matches;
  renderInquiryMatches();

  const totalMatches = matches.reduce((acc, m) => acc + m.total, 0);
  $inqForm.classList.remove('is-loading');
  if (!totalMatches) {
    setItStatus(`No mentions of "${term}" in this inquiry's transcripts.`);
  } else {
    const sessionLabel = matches.length === 1 ? '1 session' : `${matches.length} sessions`;
    setItStatus(`${totalMatches.toLocaleString('en-GB')} mention${totalMatches === 1 ? '' : 's'} across ${sessionLabel}.`);
  }
}

// Walk segments, collect up to MAX_SNIPPETS_PER_SESSION hits with the
// speaker who said each one — plus the previous speaker's turn for
// dialogic context. A match in a witness's answer comes paired with
// the question that prompted it; a match in a Chair's question comes
// paired with the answer that precedes it. Either way, the editorial
// unit is the speaker exchange around the term, not just the slice.
function findAllMatchesInSegments(segments, term, maxLen = 400, priorMax = 300) {
  if (!segments || !term) return { snippets: [], totalHits: 0 };
  const pattern = buildSearchRegex(term, 'g');
  const snippets = [];
  let totalHits = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(seg.text)) !== null) {
      totalHits++;
      if (snippets.length < MAX_SNIPPETS_PER_SESSION) {
        const before = Math.floor(maxLen / 3);
        const start = Math.max(0, m.index - before);
        const end = Math.min(seg.text.length, start + maxLen);
        let slice = seg.text.slice(start, end);
        if (start > 0)             slice = '…' + slice;
        if (end < seg.text.length) slice = slice + '…';
        const prior = findPriorTurn(segments, i);
        const priorFull = prior ? prior.text : '';
        snippets.push({
          speaker: seg.speaker,
          snippet: slice,
          priorSpeaker: prior ? prior.speaker : '',
          priorTextFull:      priorFull,
          priorTextTruncated: priorFull.length > priorMax ? truncateFromStart(priorFull, priorMax) : priorFull,
          priorIsTruncated:   priorFull.length > priorMax,
        });
      }
      pattern.lastIndex = m.index + Math.max(term.length, 1) + 200;
    }
  }
  return { snippets, totalHits };
}

// Find the previous speaker's full turn, walking back across the
// continuation paragraphs of the matching speaker first, then collecting
// all adjacent paragraphs by the prior speaker.
function findPriorTurn(segments, i) {
  if (i <= 0) return null;
  const currentSpeaker = segments[i].speaker;
  let priorEnd = i - 1;
  while (priorEnd >= 0 && segments[priorEnd].speaker === currentSpeaker) priorEnd--;
  if (priorEnd < 0) return null;
  const priorSpeaker = segments[priorEnd].speaker;
  if (!priorSpeaker) return null;   // skip header/boilerplate with no speaker
  let priorStart = priorEnd;
  while (priorStart > 0 && segments[priorStart - 1].speaker === priorSpeaker) priorStart--;
  return {
    speaker: priorSpeaker,
    text: segments.slice(priorStart, priorEnd + 1).map((s) => s.text).join(' '),
  };
}

// Keep the END of the string (which is usually the actual question, after
// any preamble) when truncating the prior turn.
function truncateFromStart(s, max) {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - max).trimStart();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a text-fragment URL — modern browsers will scroll to and
// highlight the matching text on the destination page. The destination
// is .docx-converted HTML with non-breaking spaces and curly punctuation,
// so we keep the fragment short, strip punctuation that often drifts,
// and use the prefix/suffix syntax (`text=PREFIX-,start,-SUFFIX`) so the
// browser only has to match three plain words exactly. Falls back
// gracefully: if no match, the page just loads at the top.
function buildTextFragmentUrl(transcriptLink, snippet, term) {
  if (!transcriptLink || !snippet || !term) return transcriptLink;
  const clean = String(snippet).replace(/^…\s*|\s*…$/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return transcriptLink;
  const lower = clean.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx < 0) return `${transcriptLink}#:~:text=${encodeURIComponent(term)}`;
  // Two simple "anchor" words on each side of the match. Punctuation
  // stripped so commas, em-dashes etc. can't break matching.
  const wordify = (s) => s.replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const before = wordify(clean.slice(0, idx)).slice(-2);
  const match  = clean.slice(idx, idx + term.length);
  const after  = wordify(clean.slice(idx + term.length)).slice(0, 2);
  // Use prefix-,match,-suffix form when we have anchors — far more
  // tolerant of whitespace and entity differences than plain text=.
  let fragment;
  if (before.length && after.length) {
    fragment = `${before.join(' ')}-,${match},-${after.join(' ')}`;
  } else {
    fragment = match;
  }
  return `${transcriptLink}#:~:text=${encodeURIComponent(fragment)}`;
}

function renderInquiryMatches() {
  if (!state.inquiryMatches.length) {
    $inqMatchesWrap.hidden = true;
    return;
  }
  $inqMatchesWrap.hidden = false;
  $inqMatches.innerHTML = state.inquiryMatches.map(({ session, snippets, total }) => {
    const witnesses = session.witnesses.slice(0, 3).map((w) => {
      const orgs = w.organisations.length ? w.organisations.join(', ') : '';
      const primary = w.name || orgs || '?';
      return escapeHtml(primary);
    }).join(', ');
    const more = total > snippets.length ? ` <span class="cm-witness-more">+ ${total - snippets.length} more in this session</span>` : '';
    const snippetItems = snippets.map((sn) => {
      const deepLink = buildTextFragmentUrl(session.transcriptLink, sn.snippet, state.inquiryTerm);
      // Prior turn — three shapes:
      //   • no prior speaker: render nothing
      //   • prior fits in priorMax: plain static div
      //   • prior was truncated: a button that toggles between truncated
      //     and full text on click. Sits OUTSIDE the snippet's deep link
      //     <a> so the click doesn't navigate.
      let priorBlock = '';
      if (sn.priorSpeaker && sn.priorIsTruncated) {
        priorBlock = `<button type="button" class="cm-snippet-prior is-collapsed" aria-expanded="false">
          <span class="cm-snippet-speaker">${escapeHtml(sn.priorSpeaker)}</span>
          <span class="cm-snippet-prior-truncated">${escapeHtml(sn.priorTextTruncated)}</span>
          <span class="cm-snippet-prior-full">${escapeHtml(sn.priorTextFull)}</span>
          <span class="cm-snippet-prior-toggle"><span class="cm-toggle-show">Show full question</span><span class="cm-toggle-hide">Show less</span></span>
        </button>`;
      } else if (sn.priorSpeaker) {
        priorBlock = `<div class="cm-snippet-prior is-static">
          <span class="cm-snippet-speaker">${escapeHtml(sn.priorSpeaker)}</span>
          <span class="cm-snippet-text">${escapeHtml(sn.priorTextFull)}</span>
        </div>`;
      }
      return `<li class="cm-snippet">
        ${priorBlock}
        <a class="cm-snippet-link" href="${escapeHtml(deepLink)}" target="_blank" rel="noopener">
          <div class="cm-snippet-current">
            ${sn.speaker ? `<span class="cm-snippet-speaker">${escapeHtml(sn.speaker)}</span>` : ''}
            <span class="cm-snippet-text">${snippetHtml(sn.snippet, state.inquiryTerm, 400)}</span>
          </div>
        </a>
      </li>`;
    }).join('');
    return `<li class="cm-item">
      <h3 class="cm-item-title"><a href="${escapeHtml(session.transcriptLink)}" target="_blank" rel="noopener">${session.date ? escapeHtml(formatDate(session.date)) : 'Oral evidence'}</a></h3>
      ${witnesses ? `<p class="cm-meta-line">${witnesses}</p>` : ''}
      <ol class="cm-snippets">${snippetItems}</ol>
      ${more}
    </li>`;
  }).join('');
}

// Scroll the drill-in view's header into view so the user lands on the
// new context rather than at the global search form above it.
function scrollToInquiryView() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  $inquiryView.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

// ---------- URL state ----------

function buildUrlFromState() {
  const p = new URLSearchParams();
  if (state.term) p.set('q', state.term);
  if (state.preset && state.preset !== 'year') p.set('range', state.preset);
  if (state.preset === 'custom') {
    if (state.customFrom) p.set('from', state.customFrom);
    if (state.customTo)   p.set('to',   state.customTo);
  }
  if (state.view === 'inquiry' && state.currentInquiry) {
    p.set('inquiry', String(state.currentInquiry.id));
    if (state.inquiryTerm) p.set('it', state.inquiryTerm);
  }
  return p.toString();
}

function pushUrlState() {
  const qs = buildUrlFromState();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  if (url === location.pathname + location.search) return;
  history.pushState({ committees: true }, '', url);
}

function applyParamsFromUrl() {
  const p = new URLSearchParams(location.search);
  const q = p.get('q') || '';
  $q.value = q;
  const range = p.get('range');
  const validRanges = ['month', 'year', 'five', 'custom'];
  state.preset = validRanges.includes(range) ? range : 'year';
  state.customFrom = p.get('from') || '';
  state.customTo   = p.get('to') || '';
  for (const b of $datePresets.querySelectorAll('button')) {
    b.setAttribute('aria-checked', b.dataset.preset === state.preset ? 'true' : 'false');
  }
  $customDates.hidden = state.preset !== 'custom';
  if (state.preset === 'custom') {
    $fromDate.value = state.customFrom;
    $toDate.value   = state.customTo;
  }
  updateFiltersSummary();
  return !!q;
}

window.addEventListener('popstate', () => {
  hydrateFromUrl();
});

// ---------- wiring ----------

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  // Submitting the top-level form returns to discovery view. Don't push
  // an extra history entry for the exit — runSearch pushes the new one.
  if (state.view === 'inquiry') exitInquiryView({ pushUrl: false });
  runSearch(true);
});

$back.addEventListener('click', () => exitInquiryView());

$inqForm.addEventListener('submit', (e) => {
  e.preventDefault();
  searchWithinInquiry($itInput.value);
});

// Click-to-expand on truncated prior turns — the prior block is a
// sibling button, not nested inside the snippet's link, so a click
// here doesn't navigate.
$inqMatches.addEventListener('click', (e) => {
  const btn = e.target.closest('.cm-snippet-prior.is-collapsed, .cm-snippet-prior.is-expanded');
  if (!btn) return;
  const expanded = btn.classList.toggle('is-expanded');
  btn.classList.toggle('is-collapsed', !expanded);
  btn.setAttribute('aria-expanded', String(expanded));
});

// ---------- init ----------

// Drive both initial paint and back/forward navigation through one path.
async function hydrateFromUrl() {
  const hasQuery = applyParamsFromUrl();
  const inquiryId = Number(new URLSearchParams(location.search).get('inquiry') || '');
  if (Number.isFinite(inquiryId) && inquiryId > 0) {
    // Drill-in URL — top-level results may or may not be available yet.
    // If there's also a top-level q, run that in the background so Back
    // returns to populated results; otherwise just enter the inquiry view.
    if (hasQuery) runSearch(false);
    enterInquiryView(inquiryId, { pushUrl: false });
  } else if (hasQuery) {
    if (state.view === 'inquiry') exitInquiryView({ pushUrl: false });
    runSearch(false);
  } else {
    state.view = 'list';
    renderView();
    runBrowse();
  }
}

updateFiltersSummary();
hydrateFromUrl();
