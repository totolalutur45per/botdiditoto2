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
