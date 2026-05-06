// House — Transcripts
//
// Full-text search across the words inside select-committee oral
// evidence transcripts. Reads the daily-built evidence-index.json
// (produced by tools/build-evidence-index.py via GitHub Actions),
// runs queries entirely client-side, renders speaker-attributed
// snippets with prior-turn context and deep-link text fragments back
// to the published transcript on committees.parliament.uk.

import { formatDate, escapeHtml, snippetHtml } from './format.js?v=6';

const MANIFEST_URL         = './evidence-archives.json';
const SNIPPETS_PER_SESSION = 3;
const MAX_SESSIONS         = 60;
const SNIPPET_LEN          = 400;
const PRIOR_MAX            = 300;

// ---------- state ----------

const state = {
  term: '',
  manifest: null,           // { rolling: {...}, quarters: [...] }
  activeArchiveId: 'rolling', // 'rolling' or '2025-Q4' etc.
  loadedIndexes: new Map(), // archiveId → parsed JSON (cache, never evicted)
  matches: [],
  searchToken: 0,
};

// ---------- DOM ----------

const $form         = document.getElementById('tr-form');
const $q            = document.getElementById('tr-q');
const $status       = document.getElementById('tr-status');
const $results      = document.getElementById('tr-results');
const $archives     = document.getElementById('tr-archives');
const $archivePills = document.getElementById('tr-archive-pills');

// ---------- manifest + index loading ----------

// On page entry: fetch the small manifest file, render the archive
// pills, and auto-load the rolling index. Other archives are loaded
// on demand when the user picks them. Cached in memory so swapping
// back to a previously-loaded one is instant.

async function init() {
  setStatus('Loading…');
  $form.classList.add('is-loading');
  try {
    const r = await fetch(MANIFEST_URL);
    if (!r.ok) throw new Error(`manifest ${r.status} ${r.statusText}`);
    state.manifest = await r.json();
    renderArchivePills();
  } catch (e) {
    setStatus(`Couldn't load the archive manifest: ${e.message}.`, true);
    $form.classList.remove('is-loading');
    return;
  }

  // Pick initial archive: from URL ?archive= if present and known,
  // otherwise the rolling default.
  const urlArchive = new URLSearchParams(location.search).get('archive') || '';
  const known = archiveExists(urlArchive);
  state.activeArchiveId = known ? urlArchive : 'rolling';
  highlightActivePill();

  await loadActiveIndex();

  // If the page was opened with ?q=…, run the search.
  const urlQ = new URLSearchParams(location.search).get('q') || '';
  if (urlQ) {
    $q.value = urlQ;
    runSearch(false);
  }
}

function archiveExists(id) {
  if (!state.manifest) return false;
  if (id === 'rolling') return !!state.manifest.rolling;
  return (state.manifest.quarters || []).some((q) => q.id === id);
}

function archiveDescriptor(id) {
  if (id === 'rolling') return state.manifest && state.manifest.rolling;
  return (state.manifest.quarters || []).find((q) => q.id === id) || null;
}

async function loadActiveIndex() {
  const id = state.activeArchiveId;
  if (state.loadedIndexes.has(id)) {
    onIndexReady();
    return;
  }
  const desc = archiveDescriptor(id);
  if (!desc) {
    setStatus(`Couldn't find archive: ${id}`, true);
    return;
  }
  setStatus(`Loading ${desc.label}…`);
  $form.classList.add('is-loading');
  try {
    const r = await fetch(`./${desc.url}`);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    state.loadedIndexes.set(id, await r.json());
    onIndexReady();
  } catch (e) {
    setStatus(`Couldn't load ${desc.label}: ${e.message}.`, true);
  } finally {
    $form.classList.remove('is-loading');
  }
}

function onIndexReady() {
  const desc = archiveDescriptor(state.activeArchiveId);
  const idx = state.loadedIndexes.get(state.activeArchiveId);
  if (!desc || !idx) return;
  setStatus(`${desc.label} · ${idx.sessionCount.toLocaleString('en-GB')} sessions · built ${formatDate(idx.buildDate)}.`);
  // Re-run search if there's a current term (e.g. user switched archive
  // while a term was active).
  if (state.term) runSearch(false);
}

function renderArchivePills() {
  if (!state.manifest) return;
  const pills = [];
  if (state.manifest.rolling) {
    pills.push({ id: 'rolling', label: state.manifest.rolling.label });
  }
  for (const q of (state.manifest.quarters || [])) {
    pills.push({ id: q.id, label: q.label });
  }
  if (pills.length <= 1) {
    // Nothing to switch between
    $archives.hidden = true;
    return;
  }
  $archives.hidden = false;
  $archivePills.innerHTML = pills.map((p) => `
    <button type="button" role="radio" aria-checked="false" data-archive-id="${p.id}">${p.label}</button>
  `).join('');
}

function highlightActivePill() {
  for (const btn of $archivePills.querySelectorAll('button')) {
    btn.setAttribute('aria-checked', btn.dataset.archiveId === state.activeArchiveId ? 'true' : 'false');
  }
}

$archivePills.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-archive-id]');
  if (!btn) return;
  const id = btn.dataset.archiveId;
  if (id === state.activeArchiveId) return;
  state.activeArchiveId = id;
  highlightActivePill();
  state.matches = [];
  renderResults();
  pushUrlState();
  loadActiveIndex();
});

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
  const idx = state.loadedIndexes.get(state.activeArchiveId);
  if (!idx) {
    setStatus('Index still loading — try again in a moment.');
    return;
  }
  setStatus('Searching…');
  $form.classList.add('is-loading');
  try {
    state.matches = searchTranscripts(state.term, idx);
    if (myToken !== state.searchToken) return;
    renderResults();
    const desc = archiveDescriptor(state.activeArchiveId);
    const scope = desc ? desc.label : 'this archive';
    const totalHits = state.matches.reduce((acc, m) => acc + m.total, 0);
    if (!totalHits) {
      setStatus(`No mentions of "${state.term}" in ${scope}.`);
    } else {
      const sessionLabel = state.matches.length === 1 ? '1 session' : `${state.matches.length} sessions`;
      setStatus(`${totalHits.toLocaleString('en-GB')} mention${totalHits === 1 ? '' : 's'} across ${sessionLabel} in ${scope}.`);
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
  if (state.activeArchiveId && state.activeArchiveId !== 'rolling') {
    p.set('archive', state.activeArchiveId);
  }
  const qs = p.toString();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  if (url === location.pathname + location.search) return;
  history.pushState({ transcripts: true }, '', url);
}

window.addEventListener('popstate', async () => {
  const params = new URLSearchParams(location.search);
  $q.value = params.get('q') || '';
  const archive = params.get('archive') || 'rolling';
  if (archive !== state.activeArchiveId && archiveExists(archive)) {
    state.activeArchiveId = archive;
    highlightActivePill();
    await loadActiveIndex();
  }
  runSearch(false);
});

// ---------- wiring ----------

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(true);
});

// ---------- init ----------

init();
