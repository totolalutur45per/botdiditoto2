import { useState, useEffect, useCallback } from 'react';
import { getScrims } from '../api';

const ROLES = ['TOP', 'JGL', 'MID', 'ADC', 'SUPP'];
const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

const roleEmoji = {
  TOP: '🛡️',
  JGL: '🌲',
  MID: '🔮',
  ADC: '🏹',
  SUPP: '💚',
};

export default function ScrimBoard() {
  const [scrims, setScrims] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchScrims = useCallback(async () => {
    try {
      setError(null);
      const data = await getScrims();
      setScrims(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchScrims();
    const interval = setInterval(fetchScrims, 30000);
    return () => clearInterval(interval);
  }, [fetchScrims]);

  if (loading) return <div className="loading">Loading scrims...</div>;

  return (
    <div className="scrim-board">
      {error && <div className="error-banner">{error}</div>}

      <div className="scrim-grid">
        {DAYS.map(day => {
          const scrim = scrims[day];
          if (!scrim) return null;

          const lineupComplete = ROLES.every(r => scrim.lineup[r] != null);
          const availableCount = scrim.available.length;

          return (
            <div key={day} className={`scrim-card ${lineupComplete ? 'complete' : availableCount > 0 ? 'partial' : 'empty'}`}>
              <div className="scrim-card-header">
                <h3>{day.toUpperCase()}</h3>
                <span className="scrim-count">{availableCount}/5</span>
              </div>

              {lineupComplete ? (
                <div className="lineup">
                  {ROLES.map(role => {
                    const p = scrim.lineup[role];
                    return (
                      <div key={role} className="lineup-slot filled">
                        <span className="role-tag">{roleEmoji[role]} {role}</span>
                        <span className="player-tag">{p?.name || '???'}</span>
                      </div>
                    );
                  })}
                </div>
              ) : availableCount > 0 ? (
                <div className="available-list">
                  {scrim.available.map(p => (
                    <span key={p.id} className="player-chip">{p.name}</span>
                  ))}
                </div>
              ) : (
                <div className="empty-state">No one registered</div>
              )}

              {scrim.substitutes.length > 0 && (
                <div className="substitutes">
                  <span className="subs-label">Subs:</span>
                  {scrim.substitutes.map(p => (
                    <span key={p.id} className="player-chip sub">{p.name}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button className="refresh-btn" onClick={fetchScrims}>
        Refresh
      </button>
    </div>
  );
}
