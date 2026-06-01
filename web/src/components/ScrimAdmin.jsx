import { useState, useEffect, useCallback, useRef } from 'react';
import { getScrims, addPlayers, removePlayers, updateDisplayNames, searchDiscordUsers, reorderPlayers } from '../api';

const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

export default function ScrimAdmin() {
  const [scrims, setScrims] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLog, setActionLog] = useState([]);
  const [day, setDay] = useState('lundi');
  const [submitting, setSubmitting] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchTimeoutRef = useRef(null);

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
  }, [fetchScrims]);

  async function handleAddFromSearch(user) {
    setSubmitting(true);
    setActionLog(prev => [...prev, `Adding ${user.displayName || user.username} to ${day}...`]);
    try {
      const [result] = await Promise.all([
        addPlayers(day, [user.id]),
        updateDisplayNames({ [user.id]: user.displayName || user.username })
      ]);
      setScrims(prev => ({ ...prev, [day]: result }));
      setActionLog(prev => [...prev, `✅ Added ${user.displayName || user.username} to ${day}`]);
      setSearchQuery('');
      setSearchResults([]);
    } catch (err) {
      setActionLog(prev => [...prev, `❌ Error: ${err.message}`]);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemoveFromBoard(playerId, dayKey) {
    setSubmitting(true);
    setActionLog(prev => [...prev, `Removing ${playerId} from ${dayKey}...`]);
    try {
      const result = await removePlayers(dayKey, [playerId]);
      setScrims(prev => ({ ...prev, [dayKey]: result }));
      setActionLog(prev => [...prev, `✅ Removed from ${dayKey}`]);
    } catch (err) {
      setActionLog(prev => [...prev, `❌ Error: ${err.message}`]);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReorder(playerIds) {
    setSubmitting(true);
    setActionLog(prev => [...prev, `Reordering ${day} queue...`]);
    try {
      const result = await reorderPlayers(day, playerIds);
      setScrims(prev => ({ ...prev, [day]: result }));
      setActionLog(prev => [...prev, `✅ Queue reordered for ${day}`]);
    } catch (err) {
      setActionLog(prev => [...prev, `❌ Error: ${err.message}`]);
    } finally {
      setSubmitting(false);
    }
  }

  function handleMoveUp(index) {
    if (index === 0 || !currentScrim?.available) return;
    const ids = currentScrim.available.map(p => p.id);
    [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
    handleReorder(ids);
  }

  function handleMoveDown(index) {
    if (!currentScrim?.available || index >= currentScrim.available.length - 1) return;
    const ids = currentScrim.available.map(p => p.id);
    [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
    handleReorder(ids);
  }

  async function handleSearchChange(value) {
    setSearchQuery(value);
    setSearchResults([]);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (value.trim().length < 2) return;

    setSearching(true);
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const results = await searchDiscordUsers(value.trim());
        setSearchResults(results);
      } catch (err) {
        setError(err.message.includes('not valid JSON') ? 'Discord search not available — make sure the bot is running with the latest code' : err.message);
      } finally {
        setSearching(false);
      }
    }, 800);
  }

  function copyId(id) {
    navigator.clipboard.writeText(id);
    setActionLog(prev => [...prev, `📋 Copied: ${id}`]);
  }

  if (loading) return <div className="loading">Loading...</div>;

  const currentScrim = scrims[day];

  return (
    <div className="scrim-admin">
      {error && <div className="error-banner">{error}</div>}

      <section className="admin-section">
        <h3>🔍 Add Player to {day.toUpperCase()}</h3>
        <div className="admin-form">
          <label>
            Day:
            <select value={day} onChange={e => setDay(e.target.value)}>
              {DAYS.map(d => <option key={d} value={d}>{d.toUpperCase()}</option>)}
            </select>
          </label>
          <label>
            Search by Discord username:
            <input
              type="text"
              value={searchQuery}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="Type a Discord username..."
              className="search-input"
            />
          </label>
          {searching && <div className="dim">Searching...</div>}
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map(user => {
                const alreadyIn = currentScrim?.available?.some(p => p.id === user.id);
                return (
                  <div key={user.id} className="search-result-row">
                    <div className="search-result-info">
                      <span className="search-result-name">{user.displayName || user.username}</span>
                      <span className="search-result-username">@{user.username}</span>
                      <code className="search-result-id" onClick={() => copyId(user.id)} title="Click to copy">{user.id}</code>
                      {alreadyIn && <span className="already-badge">✓ in queue</span>}
                    </div>
                    <button
                      className="admin-btn add"
                      onClick={() => handleAddFromSearch(user)}
                      disabled={submitting || alreadyIn}
                    >
                      {alreadyIn ? 'Added' : '+ Add'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="admin-section">
        <h3>Queue — {day.toUpperCase()}</h3>
        {currentScrim && (
          <div className="admin-current">
            <div className="admin-available">
              <h4>Queue Order ({currentScrim.available?.length || 0})</h4>
              {(currentScrim.available?.length || 0) === 0 ? (
                <span className="dim">No players</span>
              ) : (
                <ol className="admin-queue-list">
                  {currentScrim.available?.map((p, i) => (
                    <li key={p.id} className="admin-queue-item">
                      <span className="queue-pos">{i + 1}</span>
                      <span className="queue-name">{p.name || p.id}</span>
                      <div className="queue-controls">
                        <button className="queue-btn" onClick={() => handleMoveUp(i)} disabled={submitting || i === 0} title="Move up">↑</button>
                        <button className="queue-btn" onClick={() => handleMoveDown(i)} disabled={submitting || i === (currentScrim.available?.length || 0) - 1} title="Move down">↓</button>
                        <button className="chip-remove" onClick={() => handleRemoveFromBoard(p.id, day)} disabled={submitting} title="Remove">×</button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="admin-lineup">
              <h4>Lineup</h4>
              <div className="admin-player-list">
                {currentScrim.lineup && Object.entries(currentScrim.lineup).map(([role, p]) => (
                  <span key={role} className="admin-player-chip">
                    {role}: {p ? p.name || p.id : '—'}
                  </span>
                ))}
              </div>
            </div>
            {currentScrim.substitutes?.length > 0 && (
              <div className="admin-subs">
                <h4>Substitutes</h4>
                <div className="admin-player-list">
                  {currentScrim.substitutes.map(p => (
                    <span key={p.id} className="admin-player-chip sub">
                      {p.name || p.id}
                      <button className="chip-remove" onClick={() => handleRemoveFromBoard(p.id, day)} disabled={submitting} title="Remove">×</button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {actionLog.length > 0 && (
        <section className="admin-section">
          <h3>Action Log</h3>
          <div className="action-log">
            {actionLog.map((msg, i) => <div key={i} className="log-entry">{msg}</div>)}
            <button className="clear-log-btn" onClick={() => setActionLog([])}>Clear</button>
          </div>
        </section>
      )}
    </div>
  );
}