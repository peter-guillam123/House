// Markdown export of a search/dive's contributions, designed to drop
// into NotebookLM, Obsidian, Google Docs paste, or any other reading
// surface a journalist might want. Each entry carries its own metadata
// and Hansard deep link, so quotes survive being moved around.

const EXPORT_CAP = 500;

import { formatDate } from './format.js?v=5';

// Build the Markdown document. Items can be either Search result items
// or Deep Dive headlines — both shapes have date / memberName / party /
// house / title / link / fullText.
export function buildMarkdownExport({
  pageTitle,
  term,
  dateRange,
  filtersLabel,
  recreateUrl,
  items,
}) {
  const capped = items.length > EXPORT_CAP ? items.length : 0;
  const truncated = items.slice(0, EXPORT_CAP);

  const today = formatDate(new Date().toISOString().slice(0, 10));
  const lines = [];
  lines.push(`# House — ${pageTitle}`);
  lines.push('');
  lines.push(`- **Search:** ${term ? `"${term}"` : '(no term)'}`);
  if (dateRange)    lines.push(`- **Date range:** ${dateRange}`);
  if (filtersLabel) lines.push(`- **Filters:** ${filtersLabel}`);
  if (recreateUrl)  lines.push(`- **Recreate:** ${recreateUrl}`);
  lines.push(`- **Generated:** ${today}`);
  lines.push(`- **Contributions:** ${truncated.length}${capped ? ` (of ${capped} matched — narrow filters to export the rest)` : ''}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const item of truncated) {
    const date = formatDate(item.date) || '(no date)';
    const member = item.memberName || '(no attribution)';
    const partyBit = item.party ? ` (${item.party})` : '';
    const houseBit = item.house ? ` — ${item.house}` : '';
    lines.push(`## ${date} — ${member}${partyBit}${houseBit}`);
    lines.push('');
    if (item.title)  lines.push(`- **Debate:** ${item.title}`);
    if (item.source) lines.push(`- **Source:** ${item.source}`);
    if (item.link)   lines.push(`- **Hansard:** ${item.link}`);
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
