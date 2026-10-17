// Markdown export of a search's contributions, designed to drop into
// NotebookLM, Obsidian, Google Docs paste, or any other reading surface
// a journalist might want. It opens with a plain paragraph saying what
// the file is, in absolute dates, because a model reading it next March
// can't resolve "last year". Each entry carries its own metadata and
// Hansard deep link, so quotes survive being moved around.

export const EXPORT_CAP = 500;

import { formatDate } from './format.js?v=9';

function plural(n, one, many) {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}

// Build the Markdown document. Items can be either Search result items
// or Deep Dive headlines — both shapes have date / memberName / party /
// house / title / link / fullText.
//
//   term          the search term
//   startDate     ISO dates the search actually covered
//   endDate
//   what          what was searched, as prose: "Hansard spoken
//                 contributions, written questions and answers, ..."
//   house         'Both' | 'Commons' | 'Lords'
//   narrowedTo    extra prose, e.g. "Labour members" or "Jim Shannon"
//   totalMatched  how many the search matched in all (null if unknown)
//   recreateUrl   link that re-runs the search
export function buildMarkdownExport({
  pageTitle,
  term,
  startDate,
  endDate,
  what,
  house,
  narrowedTo,
  totalMatched,
  recreateUrl,
  items,
}) {
  const included = items.slice(0, EXPORT_CAP);
  const total = Number.isFinite(totalMatched) ? Math.max(totalMatched, included.length) : null;
  const partial = total != null && included.length < total;

  const today = formatDate(new Date().toISOString().slice(0, 10));
  const quoted = term ? `“${term}”` : 'no search term';
  const where = house === 'Commons' ? 'the House of Commons'
    : house === 'Lords' ? 'the House of Lords' : 'both Houses of Parliament';
  const when = startDate && endDate
    ? ` made between ${formatDate(startDate)} and ${formatDate(endDate)}`
    : '';
  const count = partial
    ? `${included.length.toLocaleString('en-GB')} of the ${total.toLocaleString('en-GB')} contributions`
    : plural(included.length, 'contribution', 'contributions');

  const lines = [];
  lines.push(`# House — ${pageTitle}: ${quoted}`);
  lines.push('');
  lines.push(
    `This file is an export from House, a search tool over the official record of the UK Parliament. ` +
    `It contains ${count} matching ${quoted}${when}, drawn from ${what || 'the parliamentary record'} in ${where}` +
    `${narrowedTo ? `, limited to ${narrowedTo}` : ''}. ` +
    `Each entry gives the date, the member who spoke or asked and their party, the debate or heading, the source, ` +
    `a link to the official record, and the full text. ` +
    `${partial ? `The remaining ${(total - included.length).toLocaleString('en-GB')} are not in this file. ` : ''}` +
    `Generated on ${today} from Parliament’s open APIs under the Open Parliament Licence v3.0.`,
  );
  lines.push('');
  lines.push(`- **Search:** ${term ? `"${term}"` : '(no term)'}`);
  if (startDate && endDate) lines.push(`- **Dates:** ${formatDate(startDate)} to ${formatDate(endDate)}`);
  if (what)   lines.push(`- **Sources:** ${what}`);
  lines.push(`- **House:** ${where}`);
  if (narrowedTo) lines.push(`- **Limited to:** ${narrowedTo}`);
  if (recreateUrl) lines.push(`- **Recreate:** ${recreateUrl}`);
  lines.push(`- **Generated:** ${today}`);
  lines.push(`- **Contributions:** ${included.length}${total != null ? ` of ${total.toLocaleString('en-GB')} matched` : ''}${items.length > EXPORT_CAP ? ` (export capped at ${EXPORT_CAP}; narrow the dates or filters for the rest)` : ''}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const item of included) {
    const date = formatDate(item.date) || '(no date)';
    const member = item.memberName || '(no attribution)';
    const partyBit = item.party ? ` (${item.party})` : '';
    const houseBit = item.house ? ` — ${item.house}` : '';
    lines.push(`## ${date} — ${member}${partyBit}${houseBit}`);
    lines.push('');
    if (item.title)  lines.push(`- **Debate:** ${item.title}`);
    if (item.source) lines.push(`- **Source:** ${item.source}`);
    if (item.link)   lines.push(`- **Record:** ${item.link}`);
    lines.push('');
    const text = (item.fullText || item.snippet || '').trim();
    if (text) {
      lines.push(text);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

// Slug-ify a string for use in a download filename.
function safeFilenamePart(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function exportFilename(prefix, term) {
  const today = new Date().toISOString().slice(0, 10);
  const slug = safeFilenamePart(term) || 'export';
  return `${prefix}-${slug}-${today}.md`;
}

export function downloadMarkdown(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick — Safari sometimes drops the download if the URL
  // disappears too quickly.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
