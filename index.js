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
const RECAP_CHANNEL = 'recap-scrim';
const STATE_FILE = process.env.STATE_FILE || './scrims-state.json';
const TIMEZONE = 'Europe/Paris';
const STATE_VERSION = 3;

const scrims = {};
for (const day of DAYS) {
  scrims[day] = {
    available: [],
    lineup: { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null },
    substitutes: []
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

  const columns = DAYS.map(day => {
    const lineup = scrims[day].lineup;
    const complete = ROLES.every(role => lineup[role] != null);

    if (complete) {
      const cells = [];
      for (const role of ROLES) {
        const pid = lineup[role];
        if (pid) cells.push(`${playerName(pid)} (${role})`);
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
    for (const cell of columns[i]) {
      w = Math.max(w, cell.length);
    }
    return w;
  });

  const padL = (s, w) => s.padStart(w);
  const padR = (s, w) => s.padEnd(w);
  const bar = (w) => '─'.repeat(w);

  let text = '## DISPO — SCRIM\n\n```\n';
  text += '  ' + headers.map((h, i) => padL(h, colWidths[i])).join(' │ ') + '\n';
  text += '  ' + colWidths.map(bar).join('─┼─') + '\n';
  text += '  ' + counts.map((c, i) => padL(c, colWidths[i])).join(' │ ') + '\n';
  text += '  ' + colWidths.map(bar).join('─┼─') + '\n';

  for (let r = 0; r < maxRows; r++) {
    const row = DAYS.map((_, i) => padR(columns[i][r] || '', colWidths[i]));
    text += '  ' + row.join(' │ ') + '\n';
  }

  text += '```';
  return text;
}

function buildInviteButtons() {
  const row1 = new ActionRowBuilder();
  for (let i = 0; i < 5; i++) {
    const day = DAYS[i];
    const count = scrims[day].available.length;
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`DISPO:${day}`)
        .setLabel(`${day.slice(0, 3).toUpperCase()} (${count})`)
        .setStyle(ButtonStyle.Primary)
    );
  }

  const row2 = new ActionRowBuilder();
  for (let i = 5; i < DAYS.length; i++) {
    const day = DAYS[i];
    const count = scrims[day].available.length;
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`DISPO:${day}`)
        .setLabel(`${day.slice(0, 3).toUpperCase()} (${count})`)
        .setStyle(ButtonStyle.Primary)
    );
  }

  return [row1, row2];
}

function buildVerticalList() {
  let nameW = 3;
  for (const day of DAYS) {
    for (const pid of scrims[day].available) {
      nameW = Math.max(nameW, playerName(pid).length);
    }
  }

  const bar = (n) => '\u2588'.repeat(n) + '\u2591'.repeat(3 - n);

  let text = '## DETAILS — LINEUPS & PREFERENCES\n\n```\n';

  for (const day of DAYS) {
    const lineup = scrims[day].lineup;
    const complete = ROLES.every(role => lineup[role] != null);
    const count = scrims[day].available.length;
    const status = complete ? 'OK' : count > 0 ? '..' : '--';

    text += `${day.toUpperCase().padEnd(9)} ${count}/5 ${status}`;

    if (complete) {
      let total = 0;
      for (const role of ROLES) {
        const pid = lineup[role];
        if (pid) total += playerProfiles[pid]?.[role] || 0;
      }
      text += `  lineup: ${total}/15`;
    }

    text += '\n';

    if (complete) {
      for (const role of ROLES) {
        const pid = lineup[role];
        if (!pid) continue;
        const score = playerProfiles[pid]?.[role] || 0;
        text += `  ${role.padEnd(4)} ${playerName(pid).padEnd(nameW)} [${score}] ${bar(score)}\n`;
      }
      for (const sub of scrims[day].substitutes) {
        text += `  SUB  ${playerName(sub).padEnd(nameW)}\n`;
      }
    } else if (count > 0) {
      for (const pid of scrims[day].available) {
        text += `  ${playerName(pid)}\n`;
      }
    }

    text += '\n';
  }

  text += '```';
  return text;
}

async function updateInviteTable(guild) {
  const inviteChannel = guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
  if (!inviteChannel) return;

  const msgs = await inviteChannel.messages.fetch({ limit: 100 });
  const botMsgs = [...msgs.filter(m => m.author.id === client.user.id).values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const tableOpts = { content: buildInviteContent(), components: buildInviteButtons() };
  const listOpts = { content: buildVerticalList() };

  if (botMsgs[0]) {
    await botMsgs[0].edit(tableOpts);
  } else {
    await inviteChannel.send(tableOpts);
  }

  if (botMsgs[1]) {
    await botMsgs[1].edit(listOpts);
  } else {
    await inviteChannel.send(listOpts);
  }
}

function buildRecapMessage() {
  let text = `## 📋 RÉCAPITULATIF SCRIM — SEMAINE EN COURS\n\n`;

  for (const day of DAYS) {
    const lineup = scrims[day].lineup;
    const complete = ROLES.every(role => lineup[role] != null);
    const icon = complete ? '✅' : scrims[day].available.length > 0 ? '⚠️' : '❌';

    text += `${icon} **${day.toUpperCase()}** (${scrims[day].available.length}/5)\n`;

    if (complete) {
      for (const role of ROLES) {
        text += `${role}: ${playerName(lineup[role])}\n`;
      }

      const subs = scrims[day].substitutes;
      if (subs.length > 0) {
        text += `**Remplaçants:** ${subs.map(id => playerName(id)).join(', ')}\n`;
      }
    } else if (scrims[day].available.length > 0) {
      text += `En attente...\n`;
    } else {
      text += `Aucun inscrit\n`;
    }

    text += '\n';
  }

  return text;
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

async function updateRecap(guild) {
  const recapChannel = guild.channels.cache.find(c => c.name === RECAP_CHANNEL);
  if (!recapChannel) return;

  const messages = await recapChannel.messages.fetch({ limit: 10 });
  const existing = messages.find(m => m.author.id === client.user.id);

  if (existing) {
    await existing.edit({ content: buildRecapMessage() });
  } else {
    await recapChannel.send({ content: buildRecapMessage() });
  }
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
  await inviteChannel.send({ content: buildVerticalList() });
  await updateRecap(guild);
}

async function notifyLineupComplete(guild, day) {
  const recapChannel = guild.channels.cache.find(c => c.name === RECAP_CHANNEL);
  if (!recapChannel) return;

  const lineup = scrims[day].lineup;
  const mentions = ROLES.map(role => `<@${lineup[role]}>`).join(' ');
  await recapChannel.send(
    `🎮 **L'équipe du ${day.toUpperCase()} est complète !**\n${mentions}\nScrim ${day} confirmé ! 🏆`
  );
}

async function fullReset(guild) {
  for (const day of DAYS) {
    scrims[day] = {
      available: [],
      lineup: { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null },
      substitutes: []
    };
  }
  await saveState();

  const inviteChannel = await getOrCreateChannel(guild, INVITE_CHANNEL);
  const msgs = await inviteChannel.messages.fetch({ limit: 100 });
  for (const msg of msgs.filter(m => m.author.id === client.user.id).values()) {
    await msg.delete();
  }

  await inviteChannel.send({ content: buildInviteContent(), components: buildInviteButtons() });
  await inviteChannel.send({ content: buildVerticalList() });

  const recapChannel = await getOrCreateChannel(guild, RECAP_CHANNEL);
  const recapMsgs = await recapChannel.messages.fetch({ limit: 10 });
  const existingRecap = recapMsgs.find(m => m.author.id === client.user.id);

  if (existingRecap) {
    await existingRecap.edit({ content: buildRecapMessage() });
  } else {
    await recapChannel.send({ content: buildRecapMessage() });
  }
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
    .setDescription('Créer les salons invitation-scrim et recap-scrim'),
  new SlashCommandBuilder()
    .setName('resetweek')
    .setDescription('Reset toutes les inscriptions et renvoie les invitations'),
  new SlashCommandBuilder()
    .setName('setpref')
    .setDescription('Définir vos préférences de rôles (0-3 points par rôle)')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Commandes slash enregistrées.');
  } catch (error) {
    console.error('Erreur enregistrement commandes:', error);
  }
})();

client.once(Events.ClientReady, async () => {
  console.log(`Bot connecté : ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    await syncGuildChannels(guild);
  }
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
    const recapChannel = await getOrCreateChannel(guild, RECAP_CHANNEL);

    await inviteChannel.send({ content: buildInviteContent(), components: buildInviteButtons() });
    await inviteChannel.send({ content: buildVerticalList() });
    await recapChannel.send({ content: buildRecapMessage() });

    await interaction.editReply(`Salons <#${inviteChannel.id}> et <#${recapChannel.id}> prêts !`);
  }

  if (commandName === 'resetweek') {
    await interaction.deferReply({ ephemeral: true });
    await fullReset(guild);

    const inviteChannel = guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
    const recapChannel = guild.channels.cache.find(c => c.name === RECAP_CHANNEL);

    await interaction.editReply(
      `Semaine réinitialisée ! Invitations dans <#${inviteChannel?.id}>, récap dans <#${recapChannel?.id}>.`
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
        const wasComplete = ROLES.every(role => scrims[autoDay].lineup[role] != null);
        scrims[autoDay].available.push(userId);

        const { lineup, substitutes } = calculateBestLineup(autoDay);
        scrims[autoDay].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
        scrims[autoDay].substitutes = substitutes;

        await saveState();
        await updateInviteTable(guild);

        await updateRecap(guild);

        const isNowComplete = ROLES.every(role => scrims[autoDay].lineup[role] != null);
        if (!wasComplete && isNowComplete) {
          await notifyLineupComplete(guild, autoDay);
        }
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
    const wasComplete = ROLES.every(role => scrims[day].lineup[role] != null);
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
    await interaction.deferUpdate();
    await updateRecap(interaction.guild);

    const isNowComplete = ROLES.every(role => scrims[day].lineup[role] != null);
    if (!wasComplete && isNowComplete) {
      await notifyLineupComplete(interaction.guild, day);
    }
  } catch (err) {
    console.error('Erreur interaction bouton:', err.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.deferUpdate().catch(() => {});
    }
  } finally {
    lock.release();
  }
}

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
