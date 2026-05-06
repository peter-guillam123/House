// House — Transcripts
//
// Full-text search across the words inside select-committee oral
// evidence transcripts. Reads the daily-built evidence-index.json
// (produced by tools/build-evidence-index.py via GitHub Actions),
// runs queries entirely client-side, renders speaker-attributed
// snippets with prior-turn context and deep-link text fragments back
// to the published transcript on committees.parliament.uk.

import { formatDate, escapeHtml, snippetHtml } from './format.js?v=6';

const EVIDENCE_INDEX_URL  = './evidence-index.json';
const SNIPPETS_PER_SESSION = 3;
const MAX_SESSIONS         = 60;
const SNIPPET_LEN          = 400;
const PRIOR_MAX            = 300;

// ---------- state ----------

const state = {
  term: '',
  evidenceIndex: null,
  matches: [],
  searchToken: 0,
};

// ---------- DOM ----------

const $form    = document.getElementById('tr-form');
const $q       = document.getElementById('tr-q');
const $status  = document.getElementById('tr-status');
const $results = document.getElementById('tr-results');

// ---------- index loading (auto on page entry) ----------

async function loadIndex() {
  setStatus('Loading the transcript index…');
  $form.classList.add('is-loading');
  try {
    const r = await fetch(EVIDENCE_INDEX_URL);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    state.evidenceIndex = await r.json();
    const idx = state.evidenceIndex;
    setStatus(`Index loaded · ${idx.sessionCount.toLocaleString('en-GB')} sessions in the last ${idx.windowDays} days · last built ${formatDate(idx.buildDate)}.`);
    // If the page was opened with ?q=…, run the search now.
    const urlQ = new URLSearchParams(location.search).get('q') || '';
    if (urlQ) {
      $q.value = urlQ;
      runSearch(false);
    }
  } catch (e) {
    setStatus(`Couldn't load the transcript index: ${e.message}. The build may not have run yet — try again in a few hours.`, true);
  } finally {
    $form.classList.remove('is-loading');
  }
}

// ---------- search ----------

async function runSearch(pushUrl) {
  const myToken = ++state.searchToken;
  state.term = $q.value.trim();
  if (pushUrl) pushUrlState();
  if (!state.term) {
    state.matches = [];
    renderResults();
    setStatus('Type a term to search the transcripts.');
    return;
  }
  if (!state.evidenceIndex) {
    setStatus('Index still loading — try again in a moment.');
    return;
  }
  setStatus('Searching…');
  $form.classList.add('is-loading');
  try {
    state.matches = searchTranscripts(state.term, state.evidenceIndex);
    if (myToken !== state.searchToken) return;
    renderResults();
    const totalHits = state.matches.reduce((acc, m) => acc + m.total, 0);
    if (!totalHits) {
      setStatus(`No mentions of "${state.term}" in the last ${state.evidenceIndex.windowDays} days of transcripts.`);
    } else {
      const sessionLabel = state.matches.length === 1 ? '1 session' : `${state.matches.length} sessions`;
      setStatus(`${totalHits.toLocaleString('en-GB')} mention${totalHits === 1 ? '' : 's'} across ${sessionLabel}.`);
    }
  } finally {
    if (myToken === state.searchToken) $form.classList.remove('is-loading');
  }
}

function searchTranscripts(term, index) {
  const pattern = new RegExp(escapeRegex(term), 'gi');
  const out = [];
  for (const session of index.sessions) {
    const segs = session.segs || [];
    const snippets = [];
    let totalHits = 0;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(seg.tx)) !== null) {
        totalHits++;
        if (snippets.length < SNIPPETS_PER_SESSION) {
          const before = Math.floor(SNIPPET_LEN / 3);
          const start = Math.max(0, m.index - before);
          const end   = Math.min(seg.tx.length, start + SNIPPET_LEN);
          let slice = seg.tx.slice(start, end);
          if (start > 0)            slice = '…' + slice;
          if (end < seg.tx.length)  slice = slice + '…';
          const prior = findPriorTurn(segs, i);
          const priorFull = prior ? prior.text : '';
          snippets.push({
            speaker: seg.sp || '',
            snippet: slice,
            priorSpeaker: prior ? prior.speaker : '',
            priorTextFull:      priorFull,
            priorTextTruncated: priorFull.length > PRIOR_MAX ? truncateFromStart(priorFull, PRIOR_MAX) : priorFull,
            priorIsTruncated:   priorFull.length > PRIOR_MAX,
          });
        }
        pattern.lastIndex = m.index + Math.max(term.length, 1) + 200;
      }
    }
    if (snippets.length) out.push({ session, snippets, total: totalHits });
  }
  // Newest first, then trim
  out.sort((a, b) => (b.session.d || '').localeCompare(a.session.d || ''));
  return out.slice(0, MAX_SESSIONS);
}

function findPriorTurn(segs, i) {
  if (i <= 0) return null;
  const speaker = segs[i].sp;
  let priorEnd = i - 1;
  while (priorEnd >= 0 && segs[priorEnd].sp === speaker) priorEnd--;
  if (priorEnd < 0) return null;
  const priorSpeaker = segs[priorEnd].sp;
  if (!priorSpeaker) return null;
  let priorStart = priorEnd;
  while (priorStart > 0 && segs[priorStart - 1].sp === priorSpeaker) priorStart--;
  return {
    speaker: priorSpeaker,
    text: segs.slice(priorStart, priorEnd + 1).map((s) => s.tx).join(' '),
  };
}

function truncateFromStart(s, max) {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - max).trimStart();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- text-fragment deep links (mirrors committees.js) ----------

function buildTextFragmentUrl(transcriptLink, snippet, term) {
  if (!transcriptLink || !snippet || !term) return transcriptLink;
  const clean = String(snippet).replace(/^…\s*|\s*…$/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return transcriptLink;
  const lower = clean.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx < 0) return `${transcriptLink}#:~:text=${encodeURIComponent(term)}`;
  const wordify = (s) => s.replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const before = wordify(clean.slice(0, idx)).slice(-2);
  const match  = clean.slice(idx, idx + term.length);
  const after  = wordify(clean.slice(idx + term.length)).slice(0, 2);
  let fragment;
  if (before.length && after.length) {
    fragment = `${before.join(' ')}-,${match},-${after.join(' ')}`;
  } else {
    fragment = match;
  }
  return `${transcriptLink}#:~:text=${encodeURIComponent(fragment)}`;
}

// ---------- rendering ----------

function renderResults() {
  if (!state.matches.length) {
    $results.innerHTML = '';
    return;
  }
  $results.innerHTML = state.matches.map(({ session, snippets, total }) => {
    const transcriptLink = `https://committees.parliament.uk/oralevidence/${session.id}/html/`;
    const inquiryLink    = session.iId ? `https://committees.parliament.uk/work/${session.iId}/` : '';
    const snippetItems = snippets.map((sn) => {
      const deepLink = buildTextFragmentUrl(transcriptLink, sn.snippet, state.term);
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
            <span class="cm-snippet-text">${snippetHtml(sn.snippet, state.term, SNIPPET_LEN)}</span>
          </div>
        </a>
      </li>`;
    }).join('');
    const moreBit = total > snippets.length
      ? `<p class="cm-meta-line cm-snippet-more">+ ${total - snippets.length} more in this session</p>`
      : '';
    const inquiryBit = session.iT
      ? (inquiryLink
          ? `<a class="cm-meta-inquiry" href="${escapeHtml(inquiryLink)}" target="_blank" rel="noopener">${escapeHtml(session.iT)}</a>`
          : `<span class="cm-meta-inquiry">${escapeHtml(session.iT)}</span>`)
      : '';
    return `<li class="cm-item">
      <h3 class="cm-item-title"><a href="${escapeHtml(transcriptLink)}" target="_blank" rel="noopener">${escapeHtml(formatDate(session.d) || 'Oral evidence')}</a></h3>
      ${inquiryBit ? `<p class="cm-meta-line">${inquiryBit}</p>` : ''}
      ${session.w ? `<p class="cm-meta-line cm-witnesses-inline">${escapeHtml(session.w)}</p>` : ''}
      <ol class="cm-snippets">${snippetItems}</ol>
      ${moreBit}
    </li>`;
  }).join('');
}

// Click-to-expand on truncated prior turns
$results.addEventListener('click', (e) => {
  const btn = e.target.closest('.cm-snippet-prior.is-collapsed, .cm-snippet-prior.is-expanded');
  if (!btn) return;
  const expanded = btn.classList.toggle('is-expanded');
  btn.classList.toggle('is-collapsed', !expanded);
  btn.setAttribute('aria-expanded', String(expanded));
});

// ---------- status + URL state ----------

function setStatus(msg, isError = false) {
  $status.textContent = msg;
  $status.classList.toggle('error', !!isError);
}

function pushUrlState() {
  const p = new URLSearchParams();
  if (state.term) p.set('q', state.term);
  const qs = p.toString();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  if (url === location.pathname + location.search) return;
  history.pushState({ transcripts: true }, '', url);
}

window.addEventListener('popstate', () => {
  $q.value = new URLSearchParams(location.search).get('q') || '';
  runSearch(false);
});

// ---------- wiring ----------

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(true);
});

// ---------- init ----------

loadIndex();
