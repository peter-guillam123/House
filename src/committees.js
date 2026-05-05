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
} from './api.js?v=9';
import { formatDate, escapeHtml, snippetHtml } from './format.js?v=5';

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
};

const TRANSCRIPT_CONCURRENCY = 4;
const MAX_SNIPPETS_PER_SESSION = 8;

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
  // Only paint the discovery view if we're actually in it — drill-in
  // view stays on top.
  if (state.view === 'list') $results.hidden = false;
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
    // Title is a button that drills into the inquiry view (internal). The
    // external committees.parliament.uk link goes on the drill-in page
    // header so people who want it still have it one click away.
    return `<li class="cm-item">
      <h3 class="cm-item-title"><button type="button" class="cm-drill-btn" data-inquiry-id="${inq.id}">${escapeHtml(inq.title || '(untitled)')}</button></h3>
      <p class="cm-meta">
        <span class="cm-tag">${escapeHtml(inq.typeName || 'Inquiry')}</span>
        ${status ? `<span class="cm-tag cm-tag-${status.cls}">${escapeHtml(status.label)}</span>` : ''}
        ${dateRange ? `<span class="cm-meta-date">${escapeHtml(dateRange)}</span>` : ''}
      </p>
      ${reportBit}
    </li>`;
  }).join('');
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
  if (!state.sessions.length) {
    $sessions.innerHTML = '<li class="cm-empty-li">No sessions matched the term in witness or organisation metadata.</li>';
    return;
  }
  // Newest first
  const sorted = [...state.sessions].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  $sessions.innerHTML = sorted.map((s) => {
    const witnessBits = s.witnesses.slice(0, 4).map((w) => {
      // Three shapes: name + org context ("Tim Davie (BBC)"); name + role
      // ("James Blake (BBC Television Presenter)"); organisation-only
      // submission with no person name (just "BBC").
      const orgs = w.organisations.length ? w.organisations.join(', ') : '';
      const primary = w.name || orgs || '?';
      const ctx = w.name ? (orgs || w.context) : '';
      return `<span class="cm-witness">${escapeHtml(primary)}${ctx ? ` <span class="cm-witness-ctx">(${escapeHtml(ctx)})</span>` : ''}</span>`;
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

function setItStatus(msg, isError = false) {
  $itStatus.textContent = msg;
  $itStatus.classList.toggle('error', !!isError);
}

// ---------- view routing ----------

function renderView() {
  const isInquiry = state.view === 'inquiry';
  $inquiryView.hidden = !isInquiry;
  $results.hidden = isInquiry || state.inquiries.length === 0 && state.sessions.length === 0;
}

// ---------- drill-in view ----------

async function enterInquiryView(id, { pushUrl = false } = {}) {
  const myToken = ++state.inquiryToken;
  state.view = 'inquiry';

  // Look up cached metadata first; fetch if we don't have it (direct URL load).
  let inquiry = state.inquiries.find((i) => i.id === id);
  if (!inquiry) {
    renderInquiryHeader({ title: 'Loading inquiry…' });
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
  scrollToTop();

  // Fetch the inquiry's sessions
  try {
    $inqSessions.innerHTML = '<li class="cm-empty-li">Loading sessions…</li>';
    const result = await searchOralEvidence({ committeeBusinessId: id, take: 100 });
    if (myToken !== state.inquiryToken) return;
    // Newest first
    state.inquirySessions = result.items.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
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
  if (!state.inquirySessions.length) {
    $inqSessions.innerHTML = '<li class="cm-empty-li">No oral evidence sessions in this inquiry.</li>';
    $inqSessionsLabel.textContent = 'Oral evidence sessions';
    return;
  }
  $inqSessionsLabel.textContent = `Oral evidence sessions · ${state.inquirySessions.length}`;
  $inqSessions.innerHTML = state.inquirySessions.map((s) => {
    const witnessBits = s.witnesses.slice(0, 5).map((w) => {
      const orgs = w.organisations.length ? w.organisations.join(', ') : '';
      const primary = w.name || orgs || '?';
      const ctx = w.name ? (orgs || w.context) : '';
      return `<span class="cm-witness">${escapeHtml(primary)}${ctx ? ` <span class="cm-witness-ctx">(${escapeHtml(ctx)})</span>` : ''}</span>`;
    }).join('');
    const more = s.witnesses.length > 5 ? `<span class="cm-witness-more">+ ${s.witnesses.length - 5} more</span>` : '';
    return `<li class="cm-item">
      <h3 class="cm-item-title"><a href="${escapeHtml(s.transcriptLink)}" target="_blank" rel="noopener">${s.date ? escapeHtml(formatDate(s.date)) : 'Oral evidence'}</a></h3>
      <p class="cm-witnesses">${witnessBits}${more}</p>
    </li>`;
  }).join('');
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
// speaker who said each one. Returns { snippets, totalHits } so the
// renderer can show "+ N more in this session" honestly.
function findAllMatchesInSegments(segments, term, maxLen = 400) {
  if (!segments || !term) return { snippets: [], totalHits: 0 };
  const pattern = new RegExp(escapeRegex(term), 'gi');
  const snippets = [];
  let totalHits = 0;
  for (const seg of segments) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(seg.text)) !== null) {
      totalHits++;
      if (snippets.length < MAX_SNIPPETS_PER_SESSION) {
        const before = Math.floor(maxLen / 3);
        const start = Math.max(0, m.index - before);
        const end = Math.min(seg.text.length, start + maxLen);
        let slice = seg.text.slice(start, end);
        if (start > 0)               slice = '…' + slice;
        if (end < seg.text.length)   slice = slice + '…';
        snippets.push({ speaker: seg.speaker, snippet: slice });
      }
      // Skip ahead so adjacent hits don't generate near-duplicate snippets.
      pattern.lastIndex = m.index + Math.max(term.length, 1) + 200;
    }
  }
  return { snippets, totalHits };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a text-fragment URL — modern browsers will scroll to and
// highlight the matching text on the destination page, even though
// the committees.parliament.uk transcripts don't expose anchors.
// Falls back gracefully: if the fragment doesn't match (whitespace
// drift, entity differences) the browser just loads the page normally.
function buildTextFragmentUrl(transcriptLink, snippet, term) {
  if (!transcriptLink || !snippet || !term) return transcriptLink;
  // Strip the leading/trailing ellipsis we added during slicing.
  const clean = String(snippet).replace(/^…\s*|\s*…$/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return transcriptLink;
  const lower = clean.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx < 0) return `${transcriptLink}#:~:text=${encodeURIComponent(term)}`;
  // Pull up to 5 words on each side of the match for uniqueness.
  const wordsBefore = clean.slice(0, idx).split(/\s+/).filter(Boolean).slice(-5);
  const matchExact  = clean.slice(idx, idx + term.length);
  const wordsAfter  = clean.slice(idx + term.length).split(/\s+/).filter(Boolean).slice(0, 5);
  const fragment = [...wordsBefore, matchExact, ...wordsAfter].join(' ');
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
      return `<li class="cm-snippet">
        <a class="cm-snippet-link" href="${escapeHtml(deepLink)}" target="_blank" rel="noopener">
          ${sn.speaker ? `<span class="cm-snippet-speaker">${escapeHtml(sn.speaker)}</span>` : ''}
          <span class="cm-snippet-text">${snippetHtml(sn.snippet, state.inquiryTerm, 400)}</span>
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

function scrollToTop() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
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
  }
}

updateFiltersSummary();
hydrateFromUrl();
