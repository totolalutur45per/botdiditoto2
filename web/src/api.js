const BASE = '/api';

export async function getPlayers() {
  const res = await fetch(`${BASE}/players`);
  if (!res.ok) throw new Error('Failed to fetch players');
  return res.json();
}

export async function updatePlayer(id, preferences) {
  const res = await fetch(`${BASE}/players/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferences }),
  });
  if (!res.ok) throw new Error('Failed to update player');
  return res.json();
}

export async function getScrims() {
  const res = await fetch(`${BASE}/scrims`);
  if (!res.ok) throw new Error('Failed to fetch scrims');
  return res.json();
}

export async function addPlayers(day, playerIds) {
  const res = await fetch(`${BASE}/scrims/${day}/available`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to add players');
  }
  return res.json();
}

export async function removePlayers(day, playerIds) {
  const res = await fetch(`${BASE}/scrims/${day}/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to remove players');
  }
  return res.json();
}

export async function updateDisplayNames(names) {
  const res = await fetch(`${BASE}/displayNames`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to update display names');
  }
  return res.json();
}

export async function searchDiscordUsers(query) {
  const res = await fetch(`${BASE}/discord/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Search failed');
  }
  return res.json();
}
