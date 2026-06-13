const express = require('express');
const cors = require('cors');
const path = require('path');

const state = require('./state');
const scrims = require('./scrims');
const discord = require('./discord-utils');

function startWebServer() {
  const app = express();
  const webPort = parseInt(process.env.PORT || process.env.PORT_WEB || '3001', 10);

  app.use(cors());
  app.use(express.json());

  app.get('/api/players', (req, res) => {
    const players = Object.entries(state.playerProfiles).map(([id, prefs]) => ({
      id,
      name: state.displayNames[id] || id,
      preferences: { ...prefs }
    }));
    res.json(players);
  });

  app.put('/api/players/:id', async (req, res) => {
    const { id } = req.params;
    const { preferences } = req.body;

    if (!preferences || typeof preferences !== 'object') {
      return res.status(400).json({ error: 'preferences object required' });
    }

    for (const role of state.ROLES) {
      const val = preferences[role];
      if (val == null) continue;
      const score = parseInt(val, 10);
      if (isNaN(score) || score < 0 || score > 3) {
        return res.status(400).json({ error: `${role} must be 0-3` });
      }
    }

    const currentPrefs = { ...(state.playerProfiles[id] || {}), ...preferences };
    const count3 = state.ROLES.filter(r => currentPrefs[r] === 3).length;
    if (count3 > 1) {
      return res.status(400).json({ error: 'Only one role can be set as main role (value 3). Others must be 2 or less.' });
    }

    if (!state.playerProfiles[id]) state.playerProfiles[id] = {};
    for (const role of state.ROLES) {
      if (preferences[role] != null) {
        state.playerProfiles[id][role] = parseInt(preferences[role], 10);
      }
    }

    await state.saveState();

    for (const day of state.DAYS) {
      const lock = state.locks[day];
      await lock.acquire();
      try {
        if (state.scrims[day].available.includes(id)) {
          const { lineup, substitutes } = scrims.calculateBestLineup(day);
          state.scrims[day].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
          state.scrims[day].substitutes = substitutes;
          await state.saveState();
          for (const guild of discord.getDiscordClient()?.guilds.cache.values() || []) {
            await discord.updateInviteTable(guild);
          }
        }
      } finally {
        lock.release();
      }
    }

    res.json({ id, name: state.displayNames[id] || id, preferences: state.playerProfiles[id] });
  });

  app.get('/api/scrims', (req, res) => {
    const result = {};
    for (const day of state.DAYS) {
      const s = state.scrims[day];
      result[day] = {
        available: s.available.map(id => ({ id, name: state.playerName(id) })),
        lineup: Object.fromEntries(
          state.ROLES.map(r => [r, s.lineup[r] ? { id: s.lineup[r], name: state.playerName(s.lineup[r]) } : null])
        ),
        substitutes: s.substitutes.map(id => ({ id, name: state.playerName(id) }))
      };
    }
    res.json(result);
  });

  app.post('/api/scrims/:day/available', async (req, res) => {
    const { day } = req.params;

    if (!state.DAYS.includes(day)) {
      return res.status(400).json({ error: `Invalid day. Must be one of: ${state.DAYS.join(', ')}` });
    }

    const { playerIds } = req.body;
    if (!Array.isArray(playerIds) || playerIds.length === 0) {
      return res.status(400).json({ error: 'playerIds must be a non-empty array of Discord user IDs' });
    }

    const lock = state.locks[day];
    await lock.acquire();
    try {
      const added = [];
      const skipped = [];

      for (const id of playerIds) {
        if (typeof id !== 'string' || !/^\d+$/.test(id)) {
          skipped.push({ id, reason: 'invalid format' });
          continue;
        }
        if (state.scrims[day].available.includes(id)) {
          skipped.push({ id, reason: 'already registered' });
          continue;
        }
        state.scrims[day].available.push(id);
        added.push(id);
      }

      if (added.length > 0) {
        const { lineup, substitutes } = scrims.calculateBestLineup(day);
        state.scrims[day].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
        state.scrims[day].substitutes = substitutes;
        await state.saveState();

        const client = discord.getDiscordClient();
        if (client) {
          for (const guild of client.guilds.cache.values()) {
            await discord.updateInviteTable(guild);
            await discord.tryPostConfirmation(guild, day);
          }
        }
      }

      res.json({
        day,
        added: added.map(id => ({ id, name: state.playerName(id) })),
        skipped,
        available: state.scrims[day].available.map(id => ({ id, name: state.playerName(id) })),
        lineup: Object.fromEntries(
          state.ROLES.map(r => [r, state.scrims[day].lineup[r] ? { id: state.scrims[day].lineup[r], name: state.playerName(state.scrims[day].lineup[r]) } : null])
        ),
        substitutes: state.scrims[day].substitutes.map(id => ({ id, name: state.playerName(id) }))
      });
    } catch (err) {
      console.error('Erreur POST scrims available:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      lock.release();
    }
  });

  app.post('/api/scrims/:day/remove', async (req, res) => {
    const { day } = req.params;

    if (!state.DAYS.includes(day)) {
      return res.status(400).json({ error: `Invalid day. Must be one of: ${state.DAYS.join(', ')}` });
    }

    const { playerIds } = req.body;
    if (!Array.isArray(playerIds) || playerIds.length === 0) {
      return res.status(400).json({ error: 'playerIds must be a non-empty array of Discord user IDs' });
    }

    const lock = state.locks[day];
    await lock.acquire();
    try {
      const removed = [];
      const skipped = [];

      for (const id of playerIds) {
        if (!state.scrims[day].available.includes(id)) {
          skipped.push({ id, reason: 'not registered' });
          continue;
        }
        state.scrims[day].available = state.scrims[day].available.filter(pid => pid !== id);

        for (const role of state.ROLES) {
          if (state.scrims[day].lineup[role] === id) {
            state.scrims[day].lineup[role] = null;
          }
        }
        state.scrims[day].substitutes = state.scrims[day].substitutes.filter(pid => pid !== id);
        removed.push(id);
      }

      if (removed.length > 0) {
        const { lineup, substitutes } = scrims.calculateBestLineup(day);
        state.scrims[day].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
        state.scrims[day].substitutes = substitutes;
        await state.saveState();

        const client = discord.getDiscordClient();
        if (client) {
          for (const guild of client.guilds.cache.values()) {
            await discord.updateInviteTable(guild);
            await discord.tryPostConfirmation(guild, day);
            if (!lineup && state.scrims[day].available.length > 0) {
              const inviteChannel = guild.channels.cache.find(c => c.name === state.INVITE_CHANNEL);
              if (inviteChannel) {
                const remainingMentions = state.scrims[day].available.map(id => `<@${id}>`).join(' ');
                await inviteChannel.send(`⚠️ **${day.toUpperCase()}** — Un joueur a été retiré ! Il reste **${state.scrims[day].available.length}/5** inscrits. ${remainingMentions}, il faut chercher un last pour ce soir`);
              }
            }
          }
        }
      }

      res.json({
        day,
        removed: removed.map(id => ({ id, name: state.playerName(id) })),
        skipped,
        available: state.scrims[day].available.map(id => ({ id, name: state.playerName(id) })),
        lineup: Object.fromEntries(
          state.ROLES.map(r => [r, state.scrims[day].lineup[r] ? { id: state.scrims[day].lineup[r], name: state.playerName(state.scrims[day].lineup[r]) } : null])
        ),
        substitutes: state.scrims[day].substitutes.map(id => ({ id, name: state.playerName(id) }))
      });
    } catch (err) {
      console.error('Erreur POST scrims remove:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      lock.release();
    }
  });

  let lastSearchTime = 0;
  const SEARCH_COOLDOWN = 2000;

  app.get('/api/discord/search', async (req, res) => {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    const now = Date.now();
    if (now - lastSearchTime < SEARCH_COOLDOWN) {
      return res.status(429).json({ error: 'Too many requests. Please wait.' });
    }
    lastSearchTime = now;

    const client = discord.getDiscordClient();
    if (!client) {
      return res.status(503).json({ error: 'Discord client not ready' });
    }

    try {
      const results = [];
      const query = q.trim().toLowerCase();
      for (const guild of client.guilds.cache.values()) {
        let memberList;
        try {
          memberList = await guild.members.search({ query: q.trim(), limit: 10 });
        } catch (e) {
          memberList = guild.members.cache.filter(m =>
            m.user.username.toLowerCase().includes(query) ||
            (m.nickname && m.nickname.toLowerCase().includes(query))
          );
        }
        for (const member of memberList.values()) {
          results.push({
            id: member.user.id,
            username: member.user.username,
            displayName: member.displayName || member.user.globalName || member.user.username,
            guildName: guild.name
          });
        }
      }

      const seen = new Set();
      const unique = results.filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });

      res.json(unique.slice(0, 20));
    } catch (err) {
      console.error('Erreur discord search:', err.message);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  app.put('/api/scrims/:day/reorder', async (req, res) => {
    const { day } = req.params;

    if (!state.DAYS.includes(day)) {
      return res.status(400).json({ error: `Invalid day. Must be one of: ${state.DAYS.join(', ')}` });
    }

    const { playerIds } = req.body;
    if (!Array.isArray(playerIds)) {
      return res.status(400).json({ error: 'playerIds must be an array' });
    }

    const current = state.scrims[day].available;
    const currentSet = new Set(current);
    const reorderedSet = new Set(playerIds);

    for (const id of playerIds) {
      if (!currentSet.has(id)) {
        return res.status(400).json({ error: `Player ${id} is not in the available list for ${day}` });
      }
    }
    if (reorderedSet.size !== playerIds.length) {
      return res.status(400).json({ error: 'Duplicate player IDs not allowed' });
    }

    const lock = state.locks[day];
    await lock.acquire();
    try {
      state.scrims[day].available = [...playerIds];
      const { lineup, substitutes } = scrims.calculateBestLineup(day);
      state.scrims[day].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
      state.scrims[day].substitutes = substitutes;
      await state.saveState();

      const client = discord.getDiscordClient();
      if (client) {
        for (const guild of client.guilds.cache.values()) {
          await discord.updateInviteTable(guild);
          await discord.tryPostConfirmation(guild, day);
        }
      }

      res.json({
        day,
        available: state.scrims[day].available.map(id => ({ id, name: state.playerName(id) })),
        lineup: Object.fromEntries(
          state.ROLES.map(r => [r, state.scrims[day].lineup[r] ? { id: state.scrims[day].lineup[r], name: state.playerName(state.scrims[day].lineup[r]) } : null])
        ),
        substitutes: state.scrims[day].substitutes.map(id => ({ id, name: state.playerName(id) }))
      });
    } catch (err) {
      console.error('Erreur reorder:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      lock.release();
    }
  });

  app.put('/api/displayNames', async (req, res) => {
    const { names } = req.body;
    if (!names || typeof names !== 'object') {
      return res.status(400).json({ error: 'names must be an object mapping user IDs to display names' });
    }

    for (const [id, name] of Object.entries(names)) {
      if (typeof id !== 'string' || typeof name !== 'string') continue;
      state.displayNames[id] = name;
    }

    await state.saveState();
    res.json({ displayNames: state.displayNames });
  });

  const staticDir = path.join(__dirname, '..', 'web', 'dist');
  app.use(express.static(staticDir));
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'), (err) => {
      if (err) res.status(404).send('Web dashboard not built. Run: cd web && npm run build');
    });
  });

  app.listen(webPort, () => {
    console.log(`Web dashboard API on port ${webPort}`);
  });
}

module.exports = { startWebServer };
