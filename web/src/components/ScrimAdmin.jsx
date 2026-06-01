import { useState, useEffect, useCallback } from 'react';
import { getScrims, addPlayers, removePlayers, updateDisplayNames, searchDiscordUsers } from '../api';

const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

export default function ScrimAdmin() {
  const [scrims, setScrims] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLog, setActionLog] = useState([]);
  const [day, setDay] = useState('lundi');
  const [playerInput, setPlayerInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

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

  function parsePlayerIds(input) {
    return [...new Set(input.trim().split(/[\s,]+/).filter(Boolean))];
  }

  function parseNames(input) {
    const pairs = input.trim().split('\n').filter(Boolean);
    const names = {};
    for (const pair of pairs) {
      const [id, ...rest] = pair.split(/[:=,]/);
      if (id && rest.length > 0) {
        names[id.trim()] = rest.join('').trim();
      }
    }
    return names;
  }

  async function handleAdd() {
    const ids = parsePlayerIds(playerInput);
    if (ids.length === 0) return;

    setSubmitting(true);
    setActionLog(prev => [...prev, `Adding ${ids.length} player(s) to ${day}...`]);
    try {
      const result = await addPlayers(day, ids);
      setScrims(prev => ({ ...prev, [day]: result }));
      const addedNames = result.added?.map(p => p.name || p.id).join(', ') || '';
      const skippedNames = result.skipped?.map(s => `${s.id}: ${s.reason}`).join(', ') || '';
      setActionLog(prev => [...prev, `✅ Added to ${day}: ${addedNames}${skippedNames ? ` | Skipped: ${skippedNames}` : ''}`]);
      setPlayerInput('');
    } catch (err) {
      setActionLog(prev => [...prev, `❌ Error: ${err.message}`]);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove() {
    const ids = parsePlayerIds(playerInput);
    if (ids.length === 0) return;

    setSubmitting(true);
    setActionLog(prev => [...prev, `Removing ${ids.length} player(s) from ${day}...`]);
    try {
      const result = await removePlayers(day, ids);
      setScrims(prev => ({ ...prev, [day]: result }));
      const removedNames = result.removed?.map(p => p.name || p.id).join(', ') || '';
      setActionLog(prev => [...prev, `✅ Removed from ${day}: ${removedNames || 'none'}`]);
      setPlayerInput('');
    } catch (err) {
      setActionLog(prev => [...prev, `❌ Error: ${err.message}`]);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdateNames() {
    const names = parseNames(nameInput);
    if (Object.keys(names).length === 0) return;

    setSubmitting(true);
    setActionLog(prev => [...prev, `Updating ${Object.keys(names).length} display name(s)...`]);
    try {
      await updateDisplayNames(names);
      setActionLog(prev => [...prev, `✅ Display names updated`]);
      setNameInput('');
      await fetchScrims();
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

  let searchTimeout;
  async function handleSearchChange(value) {
    setSearchQuery(value);
    setSearchResults([]);
    clearTimeout(searchTimeout);
    if (value.trim().length < 2) return;

    setSearching(true);
    try {
      const results = await searchDiscordUsers(value.trim());
      setSearchResults(results);
    } catch (err) {
      setError(err.message.includes('not valid JSON') ? 'Discord search not available — make sure the bot is running with the latest code' : err.message);
    } finally {
      setSearching(false);
    }
  }

  function selectUser(user) {
    const currentIds = playerInput.trim() ? playerInput.trim() + '\n' : '';
    setPlayerInput(currentIds + user.id);
    const currentNames = nameInput.trim() ? nameInput.trim() + '\n' : '';
    setNameInput(currentNames + `${user.id}:${user.displayName || user.username}`);
    setSearchQuery('');
    setSearchResults([]);
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

      <div className="admin-sections">
        <section className="admin-section">
          <h3>🔍 Discord User Lookup</h3>
          <div className="admin-form">
            <label>
              Search by username:
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
                {searchResults.map(user => (
                  <div key={user.id} className="search-result-row">
                    <div className="search-result-info">
                      <span className="search-result-name">{user.displayName || user.username}</span>
                      <span className="search-result-username">@{user.username}</span>
                      <code className="search-result-id" onClick={() => copyId(user.id)} title="Click to copy">{user.id}</code>
                    </div>
                    <button className="admin-btn add" onClick={() => selectUser(user)} disabled={submitting}>
                      + Add
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="admin-section">
          <h3>Set Display Names</h3>
          <div className="admin-form">
            <label>
              Names (one per line, format: DiscordUserId:DisplayName):
              <textarea
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                placeholder={"123456789:playerName\n987654321:anotherName"}
                rows={4}
              />
            </label>
            <button onClick={handleUpdateNames} disabled={submitting || !nameInput.trim()} className="admin-btn add">
              Update Names
            </button>
          </div>
        </section>
      </div>

      <section className="admin-section">
        <h3>Add / Remove Players</h3>
        <div className="admin-form">
          <label>
            Day:
            <select value={day} onChange={e => setDay(e.target.value)}>
              {DAYS.map(d => <option key={d} value={d}>{d.toUpperCase()}</option>)}
            </select>
          </label>
          <label>
            Discord User IDs (one per line or comma-separated):
            <textarea
              value={playerInput}
              onChange={e => setPlayerInput(e.target.value)}
              placeholder="Paste Discord user IDs here, or use the search above to add them"
              rows={4}
            />
          </label>
          <div className="admin-btn-row">
            <button onClick={handleAdd} disabled={submitting || !playerInput.trim()} className="admin-btn add">
              Add Players
            </button>
            <button onClick={handleRemove} disabled={submitting || !playerInput.trim()} className="admin-btn remove">
              Remove Players
            </button>
          </div>
        </div>
      </section>

      <section className="admin-section">
        <h3>Current State — {day.toUpperCase()}</h3>
        {currentScrim && (
          <div className="admin-current">
            <div className="admin-available">
              <h4>Available ({currentScrim.available?.length || 0})</h4>
              <div className="admin-player-list">
                {currentScrim.available?.map(p => (
                  <span key={p.id} className="admin-player-chip">
                    {p.name || p.id}
                    <button className="chip-remove" onClick={() => handleRemoveFromBoard(p.id, day)} disabled={submitting} title="Remove">×</button>
                  </span>
                ))}
                {(currentScrim.available?.length || 0) === 0 && <span className="dim">No players</span>}
              </div>
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