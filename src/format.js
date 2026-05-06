const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]} ${y}`;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Treat any all-caps short token as an acronym — match it case-sensitively
// with word boundaries so 'SAS' doesn't false-match 'Sasaki' or 'passage',
// 'RAF' doesn't false-match 'gi raf fes' (the OCR-mangled 'giraffes' on
// committee transcripts), and 'MP' doesn't match 'ample' / 'import'.
// Mixed-case terms keep the existing case-insensitive substring match.
export function isAcronymTerm(term) {
  const t = String(term || '').trim();
  return /^[A-Z][A-Z0-9]{1,7}$/.test(t);
}

// Build a search regex with the right semantics for the term.
//   flags should typically include 'g' for repeated matches; 'i' is added
//   automatically for non-acronym terms.
export function buildSearchRegex(term, flags = '') {
  const needle = unquoteTerm(term);
  if (isAcronymTerm(needle)) {
    return new RegExp(`\\b${escapeRegex(needle)}\\b`, flags.replace(/i/g, ''));
  }
  return new RegExp(escapeRegex(needle), flags.includes('i') ? flags : flags + 'i');
}

// Truncate around the first match of `term`, return safe HTML with the term highlighted.
export function snippetHtml(text, term, maxLen = 320) {
  if (!text) return '';
  const safe = String(text);
  if (!term) return escapeHtml(safe.length > maxLen ? safe.slice(0, maxLen) + '…' : safe);
  // The user types `"the Guardian"` to phrase-search; the API needs those
  // quotes for phrase matching, but the text we're highlighting against
  // has no literal quote characters around the phrase. Unwrap before we
  // build the match regex.
  const needle = unquoteTerm(term);
  const re = buildSearchRegex(needle);
  const match = safe.match(re);
  let start = 0, end = Math.min(safe.length, maxLen);
  if (match && match.index !== undefined) {
    const before = Math.floor(maxLen / 3);
    start = Math.max(0, match.index - before);
    end = Math.min(safe.length, start + maxLen);
    if (end === safe.length) start = Math.max(0, end - maxLen);
  }
  let slice = safe.slice(start, end);
  if (start > 0) slice = '…' + slice;
  if (end < safe.length) slice = slice + '…';
  return highlight(escapeHtml(slice), needle);
}

function highlight(safeHtml, term) {
  // Match the same acronym-vs-mixed-case rule as the snippet locator so
  // highlights are exactly the things we counted as matches.
  if (isAcronymTerm(term)) {
    const re = new RegExp(`(\\b${escapeRegex(escapeHtml(term))}\\b)`, 'g');
    return safeHtml.replace(re, '<mark>$1</mark>');
  }
  const re = new RegExp(`(${escapeRegex(escapeHtml(term))})`, 'ig');
  return safeHtml.replace(re, '<mark>$1</mark>');
}

// Strip a single pair of wrapping double quotes from a phrase-search term.
// Used by both the snippet highlighter and the Hansard click-through link.
export function unquoteTerm(term) {
  const t = String(term || '').trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const SOURCE_CLASS = {
  'Spoken': 'src-spoken',
  'Written': 'src-written',
  'Written Q': 'src-wq',
  'Written Stmt': 'src-ws',
  'Committee': 'src-cmte',
};

// Canonical UK party tones — shared by Search and Deep Dive so a party
// looks the same wherever it appears.
export const PARTY_COLORS = {
  'Lab':              '#d50000',
  'Labour':           '#d50000',
  'Lab/Co-op':        '#a8285e',   // rose-magenta — clearly distinct from Lab red
  'Con':              '#0063ba',
  'Conservative':     '#0063ba',
  'LD':               '#faa61a',
  'Lib Dem':          '#faa61a',
  'Liberal Democrat': '#faa61a',
  'SNP':              '#e6b800',   // saturated gold — readable on cream paper
  'Reform':           '#12b6cf',
  'Reform UK':        '#12b6cf',
  'Green':            '#6ab023',
  'Green Party':      '#6ab023',
  'DUP':              '#d46a4c',
  'PC':               '#005a3c',   // Plaid Cymru
  'Plaid Cymru':      '#005a3c',
  'SF':               '#326760',
  'Sinn Féin':        '#326760',
  'SDLP':             '#99cc66',
  'Alliance':         '#f6cb2f',
  'UUP':              '#48a5b8',
  'Ind':              '#7e6f5b',   // dark warm grey-brown
  'Independent':      '#7e6f5b',
  'Crossbench':       '#b78c5e',   // tan
  'CB':               '#b78c5e',
  'Non-affiliated':   '#544c42',   // cool dark grey
  'Non-Afl':          '#544c42',
  'Bishops':          '#574779',
  'Speaker':          '#444',
  'Unknown':          '#c9bfac',
};
const PARTY_FALLBACK = '#a89b80';

export function partyColor(p) {
  return PARTY_COLORS[p] || PARTY_FALLBACK;
}

// Hansard returns party labels inconsistently — the same MP can show
// up as "(Liberal Democrat)" in one debate and "(LD)" in another. Map
// every variant we know to a single short form for display only; the
// underlying key stays as Hansard returned it so filter URL state and
// click-to-filter matching keep working.
const PARTY_DISPLAY = {
  'Liberal Democrat': 'LD',
  'Liberal Democrats': 'LD',
  'Lib Dem': 'LD',
  'Labour': 'Lab',
  'Conservative': 'Con',
  'Conservative Independent': 'Con Ind',
  'Reform UK': 'Reform',
  'Green Party': 'Green',
  'Plaid Cymru': 'PC',
  'Sinn Féin': 'SF',
  'SF (Sinn Féin)': 'SF',
  'Independent': 'Ind',
  'Crossbench': 'CB',
  'Non-affiliated': 'Non-Afl',
  'Co-op': 'Lab/Co-op',
  'Lab Co-op': 'Lab/Co-op',
  'Bishop': 'Bishops',
  'Lord Bishop': 'Bishops',
  'APNI': 'Alliance',
};
export function partyShortName(p) {
  if (!p) return '';
  return PARTY_DISPLAY[p] || p;
}
