// Episode cast: one host, an optional co-host, and one to three guests. Roles are stable keys used
// in events, captions, and the render; "guest" is always the primary guest who gives the demo.
export const CAST_ROLES = ['host', 'cohost', 'guest', 'guest2', 'guest3'];
export const GUEST_ROLES = ['guest', 'guest2', 'guest3'];
export const ROLE_LABELS = { host: 'HOST', cohost: 'CO-HOST', guest: 'GUEST', guest2: 'GUEST 2', guest3: 'GUEST 3' };
export const DEFAULT_VOICES = { host: 'coral', cohost: 'sage', guest: 'nova', guest2: 'onyx', guest3: 'shimmer' };
export const DEFAULT_ACCENTS = { host: '#80ded1', cohost: '#9fb7ff', guest: '#efbe9e', guest2: '#f3a6c8', guest3: '#c9e38a' };

export const isGuestRole = role => GUEST_ROLES.includes(role);
export const isHostSide = role => role === 'host' || role === 'cohost';
export const roleLabel = role => ROLE_LABELS[role] || String(role || '').toUpperCase();
export const castRoles = episode => CAST_ROLES.filter(role => episode?.personas?.[role] || (role === 'host' || role === 'guest'));
export const guestRoles = episode => castRoles(episode).filter(isGuestRole);
export const personaName = (episode, role) => episode?.personas?.[role]?.name || roleLabel(role).toLowerCase();

export function roleAccent(settings = {}, role) {
  const custom = { host: settings.accent, guest: settings.guestAccent, ...(settings.accents || {}) }[role];
  return /^#[0-9a-f]{6}$/i.test(custom || '') ? custom : DEFAULT_ACCENTS[role] || '#ffffff';
}

// Who speaks after `role`. Guests answer the host side; the host side alternates between host and
// co-host for follow-ups, and hands the floor to the guest it addressed (or the least recent one).
export function nextSpeaker(episode, role, response = {}) {
  const guests = guestRoles(episode);
  const turns = episode?.turns || [];
  if (isHostSide(role)) {
    const requested = String(response?.next || '');
    if (guests.includes(requested)) return requested;
    const addressed = addressedGuest(episode, response);
    if (addressed) return addressed;
    if (guests.length === 1) return guests[0];
    const lastSpoke = role => { for (let index = turns.length - 1; index >= 0; index--) if (turns[index].role === role) return index; return -1; };
    return [...guests].sort((a, b) => lastSpoke(a) - lastSpoke(b))[0];
  }
  if (!episode?.personas?.cohost) return 'host';
  const hostSideTurns = [];
  for (const turn of turns) if (isHostSide(turn.role) && hostSideTurns.at(-1) !== turn.role) hostSideTurns.push(turn.role);
  return hostSideTurns.at(-1) === 'host' ? 'cohost' : 'host';
}

function addressedGuest(episode, response) {
  const speech = (Array.isArray(response?.segments) ? response.segments : []).filter(segment => segment?.type === 'speak').map(segment => String(segment.text || '')).join(' ').toLowerCase();
  if (!speech) return null;
  const matches = guestRoles(episode)
    .map(role => ({ role, name: String(episode?.personas?.[role]?.name || '').trim().toLowerCase().split(/\s+/)[0] }))
    .filter(entry => entry.name.length > 1)
    .map(entry => ({ ...entry, at: speech.lastIndexOf(entry.name) }))
    .filter(entry => entry.at >= 0)
    .sort((a, b) => b.at - a.at);
  return matches[0]?.role || null;
}
