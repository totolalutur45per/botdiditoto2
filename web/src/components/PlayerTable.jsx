import { useState, useEffect, useCallback } from 'react';
import { getPlayers, updatePlayer } from '../api';

const ROLES = ['TOP', 'JGL', 'MID', 'ADC', 'SUPP'];

const roleColors = {
  0: '#6b7280',
  1: '#3b82f6',
  2: '#f59e0b',
  3: '#10b981',
};

export default function PlayerTable() {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const fetchPlayers = useCallback(async () => {
    try {
      setError(null);
      const data = await getPlayers();
      setPlayers(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlayers();
    const interval = setInterval(fetchPlayers, 30000);
    return () => clearInterval(interval);
  }, [fetchPlayers]);

  async function handleCellBlur(playerId, role, value) {
    const score = parseInt(value, 10);
    if (isNaN(score) || score < 0 || score > 3) {
      setEditing(null);
      return;
    }

    const player = players.find(p => p.id === playerId);
    if (player && player.preferences[role] === score) {
      setEditing(null);
      return;
    }

    setSaving(true);
    try {
      const updated = await updatePlayer(playerId, { [role]: score });
      setPlayers(prev => prev.map(p => p.id === playerId ? updated : p));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
      setEditing(null);
    }
  }

  function handleKeyDown(e, playerId, role, value) {
    if (e.key === 'Enter') {
      e.target.blur();
    } else if (e.key === 'Escape') {
      const player = players.find(p => p.id === playerId);
      e.target.value = player?.preferences[role] ?? 1;
      setEditing(null);
    }
  }

  if (loading) return <div className="loading">Loading players...</div>;

  return (
    <div className="player-table-container">
      {error && <div className="error-banner">{error}</div>}
      {saving && <div className="saving-indicator">Saving...</div>}

      <table className="player-table">
        <thead>
          <tr>
            <th>Player</th>
            {ROLES.map(role => (
              <th key={role}>{role}</th>
            ))}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {players.length === 0 ? (
            <tr>
              <td colSpan={ROLES.length + 2} className="empty-state">
                No player profiles yet. Players must use /setpref in Discord first.
              </td>
            </tr>
          ) : (
            players.map(player => {
              const total = ROLES.reduce((sum, r) => sum + (player.preferences[r] || 0), 0);
              return (
                <tr key={player.id}>
                  <td className="player-name">{player.name}</td>
                  {ROLES.map(role => {
                    const val = player.preferences[role] ?? 0;
                    const isEditing = editing === `${player.id}-${role}`;
                    return (
                      <td
                        key={role}
                        className="pref-cell"
                        style={{ backgroundColor: roleColors[val] + '22', borderColor: roleColors[val] }}
                      >
                        {isEditing ? (
                          <input
                            type="number"
                            min="0"
                            max="3"
                            defaultValue={val}
                            className="pref-input"
                            autoFocus
                            onBlur={e => handleCellBlur(player.id, role, e.target.value)}
                            onKeyDown={e => handleKeyDown(e, player.id, role, e.target.value)}
                          />
                        ) : (
                          <span
                            className="pref-value"
                            onClick={() => setEditing(`${player.id}-${role}`)}
                            title="Click to edit"
                          >
                            {val}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="pref-total">{total}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      <button className="refresh-btn" onClick={fetchPlayers}>
        Refresh
      </button>
    </div>
  );
}
