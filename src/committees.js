// House — Committees
// Search the parliamentary committee record: inquiries by name on the
// left, oral evidence sessions by witness/organisation on the right.
// The committees API doesn't expose transcript content for search, so
// this is a navigator into the record rather than a substitute for
// reading transcripts. The page UI says so plainly.

import { searchInquiries, searchOralEvidence } from './api.js?v=8';
import { formatDate, escapeHtml } from './format.js?v=5';

// ---------- state ----------

const state = {
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
};

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
const $inquiriesNote = document.getElementById('cm-inquiries-note');
const $sessionsNote  = document.getElementById('cm-sessions-note');

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

// ---------- search ----------

async function runSearch(pushUrl) {
  const myToken = ++state.searchToken;
  state.term = $q.value.trim();
  if (!state.term) {
    setStatus('Enter a topic, witness name or organisation to search.');
    $results.hidden = true;
    return;
  }
  const { startDate, endDate } = dateRange();
  state.startDate = startDate;
  state.endDate   = endDate;

  if (pushUrl) pushUrlState();
  setStatus('Searching…');
  $form.classList.add('is-loading');
  $results.hidden = false;
  $inquiries.innerHTML = '';
  $sessions.innerHTML = '';

  try {
    const [inqRes, sesRes] = await Promise.allSettled([
      searchInquiries({ searchTerm: state.term, startDate, endDate, take: 20 }),
      searchOralEvidence({ searchTerm: state.term, startDate, endDate, take: 30 }),
    ]);
    if (myToken !== state.searchToken) return;

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

    if (errors.length) {
      setStatus(`Some results failed to load: ${errors.join('; ')}.`, true);
    } else if (state.inquiries.length === 0 && state.sessions.length === 0) {
      setStatus(`No inquiries or sessions matched “${state.term}”. Try a different name, organisation, or date range.`);
    } else {
      const inqLabel = state.inquiriesTotal === 1 ? '1 inquiry' : `${state.inquiriesTotal.toLocaleString('en-GB')} inquiries`;
      const sesLabel = state.sessionsTotal === 1 ? '1 session' : `${state.sessionsTotal.toLocaleString('en-GB')} sessions`;
      setStatus(`Showing the most recent ${state.inquiries.length} of ${inqLabel} and ${state.sessions.length} of ${sesLabel}.`);
    }
  } finally {
    if (myToken === state.searchToken) $form.classList.remove('is-loading');
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
    return `<li class="cm-item">
      <h3 class="cm-item-title"><a href="${escapeHtml(inq.link)}" target="_blank" rel="noopener">${escapeHtml(inq.title || '(untitled)')}</a></h3>
      <p class="cm-meta">
        <span class="cm-tag">${escapeHtml(inq.typeName || 'Inquiry')}</span>
        ${status ? `<span class="cm-tag cm-tag-${status.cls}">${escapeHtml(status.label)}</span>` : ''}
        ${dateRange ? `<span class="cm-meta-date">${escapeHtml(dateRange)}</span>` : ''}
      </p>
      ${reportBit}
    </li>`;
  }).join('');
}

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
  if (!state.sessions.length) {
    $sessions.innerHTML = '<li class="cm-empty-li">No sessions matched the term in witness or organisation metadata.</li>';
    return;
  }
  // Newest first
  const sorted = [...state.sessions].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  $sessions.innerHTML = sorted.map((s) => {
    const witnessBits = s.witnesses.slice(0, 4).map((w) => {
      const ctx = w.organisations.length ? w.organisations.join(', ') : w.context;
      return `<span class="cm-witness">${escapeHtml(w.name)}${ctx ? ` <span class="cm-witness-ctx">(${escapeHtml(ctx)})</span>` : ''}</span>`;
    }).join('');
    const moreBit = s.witnesses.length > 4 ? `<span class="cm-witness-more">+ ${s.witnesses.length - 4} more</span>` : '';
    const inquiryBit = s.inquiryTitle
      ? (s.inquiryLink
          ? `<a class="cm-meta-inquiry" href="${escapeHtml(s.inquiryLink)}" target="_blank" rel="noopener">${escapeHtml(s.inquiryTitle)}</a>`
          : `<span class="cm-meta-inquiry">${escapeHtml(s.inquiryTitle)}</span>`)
      : '';
    return `<li class="cm-item">
      <h3 class="cm-item-title">
        <a href="${escapeHtml(s.transcriptLink)}" target="_blank" rel="noopener">
          ${s.date ? escapeHtml(formatDate(s.date)) : 'Oral evidence'}
        </a>
      </h3>
      ${inquiryBit ? `<p class="cm-meta-line">${inquiryBit}</p>` : ''}
      <p class="cm-witnesses">${witnessBits}${moreBit}</p>
    </li>`;
  }).join('');
}

// ---------- status ----------

function setStatus(msg, isError = false) {
  $status.textContent = msg;
  $status.classList.toggle('error', !!isError);
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
  const has = applyParamsFromUrl();
  if (has) runSearch(false);
});

// ---------- wiring ----------

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(true);
});

// ---------- init ----------

updateFiltersSummary();
const hasInitialQuery = applyParamsFromUrl();
if (hasInitialQuery) runSearch(false);
