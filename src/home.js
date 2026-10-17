// House — home panels
// What the Search page shows when nobody has typed anything: the last
// sitting (from the day files), the next sitting with its business, and
// the week ahead. All read from files the nightly and hourly jobs write
// under days/, so nothing here calls Parliament live.

import { formatDayLong, formatDayFull, formatTime, escapeHtml } from './format.js?v=9';

const $home = document.getElementById('home');
const $last = document.getElementById('home-last');
const $next = document.getElementById('home-next');
const $week = document.getElementById('home-week');
const DAYS_BASE = new URL('days/', location.href);
const WHATS_ON = 'https://whatson.parliament.uk/';

let loaded = false;
const num = (n) => (n ?? 0).toLocaleString('en-GB');

export function showHome(on) {
  if (!$home) return;
  $home.hidden = !on;
  if (on && !loaded) {
    loaded = true;
    load();
  }
}

async function fetchJson(name) {
  const r = await fetch(new URL(name, DAYS_BASE), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${r.status} on ${name}`);
  return r.json();
}

async function load() {
  const [idxRes, aheadRes] = await Promise.allSettled([fetchJson('index.json'), fetchJson('ahead.json')]);
  const idx = idxRes.status === 'fulfilled' ? idxRes.value : null;
  const ahead = aheadRes.status === 'fulfilled' ? aheadRes.value : null;
  let day = null;
  const latest = idx?.latest?.Commons || idx?.latest?.Lords || idx?.days?.[0]?.date;
  if (latest) {
    try { day = await fetchJson(`${latest}.json`); } catch { /* column shows a fallback */ }
  }
  renderLast(day);
  renderNext(ahead);
  renderWeek(ahead);
  const sittingToday = ahead && Object.values(ahead.houses || {}).some((h) => h.isToday);
  $home.classList.toggle('is-sitting-today', !!sittingToday);
}

// ---------- last sitting ----------

function renderLast(day) {
  if (!day) {
    $last.innerHTML = `<p class="dd-eyebrow">Last sitting</p><p class="home-sub">No day summary yet. The first is built the morning after a sitting.</p>`;
    return;
  }
  const houses = day.houses || {};
  const house = houses.Commons ? 'Commons' : Object.keys(houses)[0];
  const h = houses[house];
  const n = h.numbers || {};
  const sat = h.sat && h.sat.from && h.sat.to
    ? `The ${house} sat from ${formatTime(h.sat.from)} to ${formatTime(h.sat.to)}.`
    : `The ${house} sat.`;
  const spikes = (h.spikes || []).slice(0, 6).map((s) => {
    const q = new URLSearchParams({ q: s.term, range: 'custom', from: day.date, to: day.date, house });
    return `<li><a class="dy-chip home-chip" href="./?${q}">${escapeHtml(s.term)}</a></li>`;
  }).join('');
  const divs = [...(h.divisions || [])].sort((a, b) => Math.abs(a.ayes - a.noes) - Math.abs(b.ayes - b.noes));
  const closest = divs[0];
  const closestLine = closest
    ? `<p class="home-line"><span class="home-label">Closest vote</span> <a href="${escapeHtml(closest.link)}" target="_blank" rel="noopener">${escapeHtml(closest.title)}</a>, ${num(closest.ayes)} to ${num(closest.noes)}${closest.rebels?.length ? ` · ${closest.rebels.length} against their party` : ''}</p>`
    : `<p class="home-line"><span class="home-label">Votes</span> none in the ${house}</p>`;
  const other = house === 'Commons' && houses.Lords ? houses.Lords : null;
  const otherLine = other
    ? `<p class="home-line"><span class="home-label">Lords</span> <a href="day.html?d=${day.date}&house=Lords">${num(other.numbers?.sections)} debates, ${num(other.numbers?.divisions)} division${other.numbers?.divisions === 1 ? '' : 's'}</a></p>`
    : '';
  $last.innerHTML = `
    <p class="dd-eyebrow">Last sitting</p>
    <h2 class="home-h"><a href="day.html?d=${day.date}">${escapeHtml(formatDayFull(day.date))}</a></h2>
    <p class="home-sub">${sat}</p>
    <p class="home-nums">${num(n.sections)} debates · ${num(n.divisions)} division${n.divisions === 1 ? '' : 's'} · ${num(n.words)} words · ${num(n.writtenStatements)} written statement${n.writtenStatements === 1 ? '' : 's'}</p>
    ${spikes ? `<p class="home-label home-label--block">Words that spiked</p><ul class="dy-chips home-chips">${spikes}</ul>` : ''}
    ${closestLine}
    ${otherLine}
    <p class="home-more"><a href="day.html?d=${day.date}">Read the day &rarr;</a></p>`;
}

// ---------- next sitting ----------

function gapSentence(house, h) {
  const back = h.nextSitting ? `returns on ${formatDayLong(h.nextSitting)}` : 'has no sitting day announced yet';
  const why = h.gap ? ({ 'Recess': 'In recess', 'Non-sitting Friday': 'Not sitting today', 'Bank Holiday': 'Bank holiday' }[h.gap.category] || 'Not sitting') : 'Not sitting today';
  return `${why}. The ${house} ${back}.`;
}

function renderNext(ahead) {
  if (!ahead) {
    $next.innerHTML = `<p class="dd-eyebrow">Next sitting</p><p class="home-sub">The order of business hasn’t been built yet.</p>`;
    return;
  }
  const houses = ahead.houses || {};
  const today = ahead.today;
  const dates = Object.values(houses).map((h) => h.nextSitting).filter(Boolean).sort();
  const soonest = dates[0] || null;
  const isToday = soonest === today;
  const eyebrow = !soonest ? 'Not sitting' : isToday ? 'Today' : 'Next sitting';
  const parts = [];
  parts.push(`<p class="dd-eyebrow">${eyebrow}</p>`);
  parts.push(`<h2 class="home-h">${soonest ? escapeHtml(formatDayFull(soonest)) : 'Parliament is not sitting'}</h2>`);
  for (const house of ['Commons', 'Lords']) {
    const h = houses[house];
    if (!h) continue;
    if (h.nextSitting !== soonest || !h.business.length) {
      parts.push(`<p class="home-sub">${escapeHtml(gapSentence(house, h))}</p>`);
      continue;
    }
    const rows = h.business;
    const shown = rows.slice(0, 8);
    parts.push(`<h3 class="home-house">${house}</h3>`);
    parts.push(`<ol class="home-list">${shown.map(businessRow).join('')}</ol>`);
    if (rows.length > shown.length) parts.push(`<p class="home-more home-more--quiet">and ${rows.length - shown.length} more</p>`);
  }
  parts.push(`<p class="home-more"><a href="${WHATS_ON}" target="_blank" rel="noopener">Full order of business on What’s On &#8599;</a></p>`);
  $next.innerHTML = parts.join('');
}

function businessRow(it) {
  // "Westminster Hall debate" already says where it is.
  const venue = it.venue && it.venue !== 'Main Chamber' && !it.category.includes(it.venue)
    ? `<span class="home-venue">${escapeHtml(it.venue)}</span>` : '';
  const who = it.members?.length && !it.topics ? `<span class="home-who">${escapeHtml(it.members.slice(0, 2).join(', '))}</span>` : '';
  const topics = it.topics ? `<span class="home-who">${it.topics.map(escapeHtml).join(' · ')}</span>` : '';
  return `<li class="home-row">
    <span class="home-time">${it.time ? escapeHtml(formatTime(it.time)) : ''}</span>
    <span class="home-body"><span class="home-cat">${escapeHtml(it.category)}</span>${venue} <span class="home-title">${escapeHtml(it.title)}</span> ${who}${topics}</span>
  </li>`;
}

// ---------- the week ahead ----------

function renderWeek(ahead) {
  if (!ahead) {
    $week.innerHTML = `<p class="dd-eyebrow">This week</p><p class="home-sub">Nothing built yet.</p>`;
    return;
  }
  const houses = ahead.houses || {};
  const soonest = Object.values(houses).map((h) => h.nextSitting).filter(Boolean).sort()[0] || ahead.today;
  // The next few days with something on, after the day the middle
  // panel already shows. Two chamber moments and three sessions a day
  // keeps the column a glance, not a listing.
  const days = (ahead.week || []).filter((d) => d.date > soonest).slice(0, 4);
  const parts = ['<p class="dd-eyebrow">This week</p>'];
  if (!days.length) {
    parts.push('<p class="home-sub">Nothing else announced yet. Committees usually publish about a week ahead.</p>');
  }
  for (const d of days) {
    const chamber = d.chamber.slice(0, 2).map((c) =>
      `<li class="home-row home-row--flat"><span class="house-tag">${escapeHtml(c.house)}</span> <span class="home-title">${escapeHtml(c.title)}</span></li>`);
    const committees = [...d.committees].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const shown = committees.slice(0, 3).map((c) => {
      const who = c.witnesses.slice(0, 2).map((w) => w.name || w.org).filter(Boolean).join(', ');
      const title = c.inquiryId
        ? `<a href="committees.html?inquiry=${c.inquiryId}">${escapeHtml(c.inquiry || c.committee)}</a>`
        : escapeHtml(c.inquiry || c.committee);
      return `<li class="home-row"><span class="home-time">${escapeHtml(formatTime(c.time))}</span><span class="home-body"><span class="home-title">${title}</span> <span class="home-who">${escapeHtml(c.committee)}${who ? ` · ${escapeHtml(who)}` : ''}</span></span></li>`;
    });
    const more = committees.length > 3 ? `<li class="home-row home-row--flat"><a class="home-more--quiet" href="committees.html">and ${committees.length - 3} more committee session${committees.length - 3 === 1 ? '' : 's'}</a></li>` : '';
    parts.push(`<h3 class="home-day">${escapeHtml(formatDayLong(d.date))}</h3><ul class="home-list">${chamber.join('')}${shown.join('')}${more}</ul>`);
  }
  parts.push(`<p class="home-more"><a href="committees.html">All upcoming committee sessions &rarr;</a></p>`);
  $week.innerHTML = parts.join('');
}
