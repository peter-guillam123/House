import { membersByName, membersByPartyId, listCurrentParties } from './api.js?v=3';

const PARTY_KEY = 'house:party-members:v2';
const PARTIES_KEY = 'house:parties:v2';

export async function resolvePartyToMemberIds(partyId) {
  if (!partyId) return null;
  const key = String(partyId);
  const cached = readCache(PARTY_KEY, key);
  if (cached) return cached;
  const ids = await membersByPartyId(partyId);
  writeCache(PARTY_KEY, key, ids);
  return ids;
}

export async function getPartyList() {
  const cached = readCache(PARTIES_KEY, '_all');
  if (cached) return cached;
  const parties = await listCurrentParties();
  if (parties.length) writeCache(PARTIES_KEY, '_all', parties);
  return parties;
}

let memberSearchSeq = 0;
export function memberAutocomplete(input, onResults) {
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const term = input.value.trim();
    const seq = ++memberSearchSeq;
    timer = setTimeout(async () => {
      if (!term) return onResults([]);
      try {
        const results = await membersByName(term);
        if (seq === memberSearchSeq) onResults(results);
      } catch {
        if (seq === memberSearchSeq) onResults([]);
      }
    }, 250);
  });
}

function readCache(scope, key) {
  try {
    const raw = sessionStorage.getItem(scope);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map[key] ?? null;
  } catch { return null; }
}

function writeCache(scope, key, value) {
  try {
    const raw = sessionStorage.getItem(scope);
    const map = raw ? JSON.parse(raw) : {};
    map[key] = value;
    sessionStorage.setItem(scope, JSON.stringify(map));
  } catch { /* sessionStorage full or disabled — fine */ }
}
