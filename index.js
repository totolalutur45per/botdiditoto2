const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const cron = require('node-cron');
const fs = require('fs/promises');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN et DISCORD_CLIENT_ID sont requis.');
  process.exit(1);
}

const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const ROLES = ['TOP', 'JGL', 'MID', 'ADC', 'SUPP'];
const INVITE_CHANNEL = 'invitation-scrim';
const STATE_FILE = process.env.STATE_FILE || './scrims-state.json';
const TIMEZONE = 'Europe/Paris';
const STATE_VERSION = 4;

const scrims = {};
for (const day of DAYS) {
  scrims[day] = {
    available: [],
    lineup: { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null },
    substitutes: [],
    locked: false
  };
}

let playerProfiles = {};
let displayNames = {};

class Lock {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise(resolve => this._queue.push(resolve));
  }

  release() {
    if (this._queue.length > 0) {
      this._queue.shift()();
    } else {
      this._locked = false;
    }
  }
}

const locks = {};
for (const day of DAYS) locks[day] = new Lock();

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);

    if (data.playerProfiles) playerProfiles = data.playerProfiles;
    if (data.displayNames) displayNames = data.displayNames;
    if (data.scrims) {
      for (const day of DAYS) {
        if (data.scrims[day]) scrims[day] = data.scrims[day];
      }
    }

    console.log('État chargé depuis le fichier.');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Erreur chargement état:', err.message);
    }
  }
}

async function saveState() {
  try {
    await fs.writeFile(
      STATE_FILE,
      JSON.stringify({ version: STATE_VERSION, scrims, playerProfiles, displayNames }, null, 2)
    );
  } catch (err) {
    console.error('Erreur sauvegarde état:', err.message);
  }
}

function playerName(userId) {
  return displayNames[userId] || '???';
}

function hasProfile(userId) {
  return playerProfiles[userId] != null;
}

function calculateBestLineup(day) {
  const available = scrims[day].available;

  if (available.length < 5) {
    return { lineup: null, substitutes: [] };
  }

  const combinations = generateCombinations(available, 5);
  let bestScore = -1;
  let bestCombination = null;

  for (const combo of combinations) {
    const score = calculateComboScore(combo);
    if (score > bestScore) {
      bestScore = score;
      bestCombination = combo;
    }
  }

  if (!bestCombination) {
    return { lineup: null, substitutes: [] };
  }

  const lineup = assignRolesToCombo(bestCombination);
  const substitutes = available.filter(id => !bestCombination.includes(id));

  return { lineup, substitutes };
}

function generateCombinations(arr, size) {
  if (size === 1) return arr.map(x => [x]);
  const result = [];
  for (let i = 0; i < arr.length - size + 1; i++) {
    const head = arr[i];
    const tail = generateCombinations(arr.slice(i + 1), size - 1);
    for (const t of tail) {
      result.push([head, ...t]);
    }
  }
  return result;
}

function calculateComboScore(combo) {
  let score = 0;
  const used = new Set();

  for (const userId of combo) {
    const prefs = playerProfiles[userId] || {};
    let bestRole = null;
    let bestScore = 0;

    for (const role of ROLES) {
      if (!used.has(role) && (prefs[role] || 0) > bestScore) {
        bestScore = prefs[role] || 0;
        bestRole = role;
      }
    }

    if (bestRole) {
      used.add(bestRole);
      score += bestScore;
    }
  }

  return score;
}

function assignRolesToCombo(combo) {
  const lineup = { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
  const used = new Set();

  for (const userId of combo) {
    const prefs = playerProfiles[userId] || {};
    let bestRole = null;
    let bestScore = 0;

    for (const role of ROLES) {
      if (!used.has(role) && (prefs[role] || 0) > bestScore) {
        bestScore = prefs[role] || 0;
        bestRole = role;
      }
    }

    if (bestRole) {
      used.add(bestRole);
      lineup[bestRole] = userId;
    }
  }

  return lineup;
}

function buildInviteContent() {
  const headers = DAYS.map(d => d.slice(0, 3).toUpperCase());
  const counts = DAYS.map(d => String(scrims[d].available.length));

  const anyComplete = DAYS.some(d =>
    ROLES.every(r => scrims[d].lineup[r] != null)
  );

  const scores = anyComplete ? DAYS.map(d => {
    const complete = ROLES.every(r => scrims[d].lineup[r] != null);
    if (!complete) return '';
    let total = 0;
    for (const role of ROLES) {
      const pid = scrims[d].lineup[role];
      if (pid) total += playerProfiles[pid]?.[role] || 0;
    }
    return String(total);
  }) : null;

  const columns = DAYS.map(day => {
    const lineup = scrims[day].lineup;
    const complete = ROLES.every(role => lineup[role] != null);

    if (complete) {
      const cells = [];
      for (const role of ROLES) {
        const pid = lineup[role];
        if (pid) {
          const score = playerProfiles[pid]?.[role] || 0;
          cells.push(`${playerName(pid)} (${role} ${score})`);
        }
      }
      for (const sub of scrims[day].substitutes) {
        cells.push(`${playerName(sub)} (sub)`);
      }
      return cells;
    }
    return scrims[day].available.map(id => playerName(id));
  });

  const maxRows = Math.max(...columns.map(c => c.length), 0);

  const colWidths = DAYS.map((_, i) => {
    let w = Math.max(headers[i].length, counts[i].length);
    if (scores) w = Math.max(w, scores[i].length);
    for (const cell of columns[i]) {
      w = Math.max(w, cell.length);
    }
    return w;
  });

  const padL = (s, w) => s.padStart(w);
  const padR = (s, w) => s.padEnd(w);
  const line = (w) => '\u2500'.repeat(w);

  let text = '## DISPO — SCRIM\n\n```\n';
  text += '   ' + headers.map((h, i) => padL(h, colWidths[i])).join(' \u2502 ') + '\n';
  text += '   ' + colWidths.map(line).join('\u2500\u2502\u2500') + '\n';
  text += '   ' + counts.map((c, i) => padL(c, colWidths[i])).join(' \u2502 ') + '\n';

  if (anyComplete) {
    text += '   ' + scores.map((s, i) => padL(s, colWidths[i])).join(' \u2502 ') + '\n';
  }

  text += '   ' + colWidths.map(line).join('\u2500\u253c\u2500') + '\n';

  for (let r = 0; r < maxRows; r++) {
    const row = DAYS.map((_, i) => padR(columns[i][r] || '', colWidths[i]));
    text += '   ' + row.join(' \u2502 ') + '\n';
  }

  text += '```';

  if (anyComplete) {
    text += '\n> Lineup score = sum of assigned role preferences (max 15)';
  }

  return text;
}

function buildInviteButtons() {
  const makeRow = (days) => {
    const row = new ActionRowBuilder();
    for (const day of days) {
      const count = scrims[day].available.length;
      const locked = scrims[day].locked;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`DISPO:${day}`)
          .setLabel(locked ? `🔒 ${day.slice(0, 3).toUpperCase()} (${count})` : `${day.slice(0, 3).toUpperCase()} (${count})`)
          .setStyle(locked ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(locked)
      );
    }
    return row;
  };

  return [makeRow(DAYS.slice(0, 5)), makeRow(DAYS.slice(5))];
}

function isPastLockTime() {
  const now = new Date();
  const time = now.toLocaleString('fr-FR', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = time.split(':').map(Number);
  return h > 5 || (h === 5 && m >= 30);
}

async function updateInviteTable(guild) {
  const inviteChannel = guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
  if (!inviteChannel) return;

  const msgs = await inviteChannel.messages.fetch({ limit: 100 });
  const botMsgs = [...msgs.filter(m => m.author.id === client.user.id).values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const opts = { content: buildInviteContent(), components: buildInviteButtons() };

  if (botMsgs[0]) {
    await botMsgs[0].edit(opts);
  } else {
    await inviteChannel.send(opts);
  }

  for (let i = 1; i < botMsgs.length; i++) {
    try { await botMsgs[i].delete(); } catch (e) {}
  }
}

async function getOrCreateChannel(guild, name) {
  let channel = guild.channels.cache.find(c => c.name === name);
  if (!channel) {
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone, allow: [PermissionsBitField.Flags.ViewChannel] }
      ]
    });
  }
  return channel;
}

async function syncGuildChannels(guild) {
  const inviteChannel = guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
  if (!inviteChannel) return;

  const msgs = await inviteChannel.messages.fetch({ limit: 100 });
  const botMsgs = msgs.filter(m => m.author.id === client.user.id);
  for (const msg of botMsgs.values()) {
    try { await msg.delete(); } catch (e) {}
  }

  await inviteChannel.send({ content: buildInviteContent(), components: buildInviteButtons() });
}

async function confirmScrim(guild, day) {
  const inviteChannel = guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
  if (!inviteChannel) return;

  const lineup = scrims[day].lineup;
  if (!lineup || !ROLES.every(r => lineup[r] != null)) return;

  let text = `🎮 **Composition — ${day.toUpperCase()} (20h30)**\n`;
  for (const role of ROLES) {
    text += `**${role}** : <@${lineup[role]}>\n`;
  }
  const subs = scrims[day].substitutes;
  if (subs.length > 0) {
    text += `\n**Remplaçants:** ${subs.map(id => `<@${id}>`).join(', ')}\n`;
  }
  text += `\n✅ Scrim confirmé à 20h30 !`;

  await inviteChannel.send(text);
}

async function fullReset(guild) {
  for (const day of DAYS) {
    scrims[day] = {
      available: [],
      lineup: { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null },
      substitutes: [],
      locked: false
    };
  }
  await saveState();

  const inviteChannel = await getOrCreateChannel(guild, INVITE_CHANNEL);
  const msgs = await inviteChannel.messages.fetch({ limit: 100 });
  for (const msg of msgs.filter(m => m.author.id === client.user.id).values()) {
    await msg.delete();
  }

  await inviteChannel.send({ content: buildInviteContent(), components: buildInviteButtons() });
}

function showPrefModal(userId, day = null) {
  const customId = day ? `PREF_MODAL:${userId}:${day}` : `PREF_MODAL:${userId}`;
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Préférences de rôles (0-3)');

  for (const role of ROLES) {
    const current = playerProfiles[userId]?.[role] || 1;
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`PREF_${role}`)
          .setLabel(`${role} (0=ne joue pas, 3=préféré)`)
          .setStyle(TextInputStyle.Short)
          .setValue(String(current))
          .setRequired(true)
          .setMaxLength(1)
      )
    );
  }

  return modal;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

client.on('error', err => {
  console.error('Erreur client Discord:', err.message);
});

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Créer le salon invitation-scrim'),
  new SlashCommandBuilder()
    .setName('resetweek')
    .setDescription('Reset toutes les inscriptions et renvoie les invitations'),
  new SlashCommandBuilder()
    .setName('setpref')
    .setDescription('Définir vos préférences de rôles (0-3 points par rôle)')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once(Events.ClientReady, async () => {
  console.log(`Bot connecté : ${client.user.tag}`);

  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    console.log('Anciennes commandes globales supprimées.');
  } catch (error) {
    console.error('Erreur suppression commandes globales:', error);
  }

  for (const guild of client.guilds.cache.values()) {
    await syncGuildChannels(guild);
  }
  console.log('Prêt.');
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction);
  } else if (interaction.isButton()) {
    await handleButton(interaction);
  } else if (interaction.isModalSubmit()) {
    await handleModal(interaction);
  }
});

async function handleCommand(interaction) {
  const { commandName, member, guild, user } = interaction;

  if (commandName === 'setpref') {
    displayNames[user.id] = user.username;
    const modal = showPrefModal(user.id);
    await interaction.showModal(modal);
    return;
  }

  if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return interaction.reply({
      content: 'Seuls les administrateurs peuvent utiliser cette commande.',
      ephemeral: true
    });
  }

  if (commandName === 'setup') {
    await interaction.deferReply({ ephemeral: true });
    const inviteChannel = await getOrCreateChannel(guild, INVITE_CHANNEL);

    await inviteChannel.send({ content: buildInviteContent(), components: buildInviteButtons() });

    await interaction.editReply(`Salon <#${inviteChannel.id}> prêt !`);
  }

  if (commandName === 'resetweek') {
    await interaction.deferReply({ ephemeral: true });
    await fullReset(guild);

    const inviteChannel = guild.channels.cache.find(c => c.name === INVITE_CHANNEL);

    await interaction.editReply(
      `Semaine réinitialisée ! Salon <#${inviteChannel?.id}>.`
    );
  }
}

async function handleModal(interaction) {
  const { customId, user, guild } = interaction;

  if (!customId.startsWith('PREF_MODAL:')) return;

  const userId = customId.split(':')[1];
  if (userId !== user.id) {
    return interaction.reply({ content: 'Erreur: ID utilisateur ne correspond pas.', ephemeral: true });
  }

  if (!playerProfiles[userId]) {
    playerProfiles[userId] = {};
  }

  let valid = true;
  for (const role of ROLES) {
    const value = interaction.fields.getTextInputValue(`PREF_${role}`);
    const score = parseInt(value);

    if (isNaN(score) || score < 0 || score > 3) {
      valid = false;
      break;
    }

    playerProfiles[userId][role] = score;
  }

  if (!valid) {
    return interaction.reply({
      content: 'Erreur: Chaque rôle doit avoir une valeur entre 0 et 3.',
      ephemeral: true
    });
  }

  displayNames[userId] = user.username;
  await saveState();

  const parts = customId.split(':');
  const autoDay = parts[2];

  if (autoDay && DAYS.includes(autoDay) && guild) {
    const lock = locks[autoDay];
    await lock.acquire();

    try {
      if (!scrims[autoDay].available.includes(userId)) {
        scrims[autoDay].available.push(userId);

        const { lineup, substitutes } = calculateBestLineup(autoDay);
        scrims[autoDay].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
        scrims[autoDay].substitutes = substitutes;

        await saveState();
        await updateInviteTable(guild);
        await tryAutoConfirm(guild, autoDay);
      }
    } catch (err) {
      console.error('Erreur auto-register:', err.message);
    } finally {
      lock.release();
    }
  }

  await interaction.reply({
    content: `✅ Préférences mises à jour!\n${ROLES.map(r => `${r}: ${playerProfiles[userId][r]}`).join(' | ')}${autoDay ? `\n📝 Inscrit automatiquement pour **${autoDay.toUpperCase()}**` : ''}`,
    ephemeral: true
  });
}

async function handleButton(interaction) {
  const [action, day] = interaction.customId.split(':');

  if (action !== 'DISPO' || !day || !DAYS.includes(day)) {
    await interaction.deferUpdate();
    return;
  }

  const userId = interaction.user.id;
  displayNames[userId] = interaction.user.username;

  if (!hasProfile(userId)) {
    const modal = showPrefModal(userId, day);
    await interaction.showModal(modal);
    return;
  }

  const lock = locks[day];
  await lock.acquire();

  try {
    if (scrims[day].locked) {
      await interaction.reply({ content: `🔒 Inscriptions fermées pour **${day.toUpperCase()}**.`, ephemeral: true });
      return;
    }

    const isAvailable = scrims[day].available.includes(userId);

    if (isAvailable) {
      scrims[day].available = scrims[day].available.filter(id => id !== userId);
    } else {
      scrims[day].available.push(userId);
    }

    const { lineup, substitutes } = calculateBestLineup(day);
    scrims[day].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
    scrims[day].substitutes = substitutes;

    await saveState();
    await updateInviteTable(interaction.guild);
    await tryAutoConfirm(interaction.guild, day);
    await interaction.deferUpdate();
  } catch (err) {
    console.error('Erreur interaction bouton:', err.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.deferUpdate().catch(() => {});
    }
  } finally {
    lock.release();
  }
}

async function tryAutoConfirm(guild, day) {
  const s = scrims[day];
  if (s.locked || s.available.length < 5) return;

  const jsDay = new Date().getDay();
  const today = DAYS[(jsDay + 6) % 7];
  if (day !== today) return;
  if (!isPastLockTime()) return;

  s.locked = true;
  const { lineup, substitutes } = calculateBestLineup(day);
  s.lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
  s.substitutes = substitutes;
  await saveState();
  await updateInviteTable(guild);
  await confirmScrim(guild, day);
}

async function autoLockAndConfirm() {
  const jsDay = new Date().getDay();
  const day = DAYS[(jsDay + 6) % 7];
  const s = scrims[day];
  if (!s || s.locked) return;

  if (s.available.length >= 5) {
    s.locked = true;
    const { lineup, substitutes } = calculateBestLineup(day);
    s.lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
    s.substitutes = substitutes;
    await saveState();

    for (const guild of client.guilds.cache.values()) {
      await updateInviteTable(guild);
      await confirmScrim(guild, day);
    }
  }
}

cron.schedule('30 5 * * *', async () => {
  console.log('Vérification auto des scrims (05:30)');
  await autoLockAndConfirm();
}, { timezone: TIMEZONE });

cron.schedule('0 0 * * 1', async () => {
  console.log('Reset automatique de la semaine');
  for (const guild of client.guilds.cache.values()) {
    await fullReset(guild);
  }
}, { timezone: TIMEZONE });

async function shutdown() {
  console.log('Arrêt en cours...');
  await saveState();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  await loadState();
  client.login(TOKEN);
})();
