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
  const re = new RegExp(escapeRegex(needle), 'i');
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
