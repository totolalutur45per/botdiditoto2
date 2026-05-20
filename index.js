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
  ButtonStyle
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
const STATE_FILE = './scrims-state.json';
const TIMEZONE = 'Europe/Paris';
const STATE_VERSION = 2;

const scrims = {};
for (const day of DAYS) {
  scrims[day] = { TOP: [], JGL: [], MID: [], ADC: [], SUPP: [] };
}

let displayNames = {};
let stateLoadedFromFile = false;

// --- Mutex per scrim day ---
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

// --- State persistence ---
async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);

    if (data.userIds && !data.displayNames) {
      const inverse = {};
      for (const [name, id] of Object.entries(data.userIds)) {
        inverse[id] = name;
      }
      displayNames = inverse;

      if (data.scrims) {
        for (const day of DAYS) {
          if (!data.scrims[day]) continue;
          for (const role of ROLES) {
            if (!data.scrims[day][role]) continue;
            scrims[day][role] = data.scrims[day][role]
              .map(name => data.userIds[name])
              .filter(id => id != null);
          }
        }
      }
      console.log('État migré v1 → v2.');
      stateLoadedFromFile = true;
      await saveState();
      return;
    }

    if (data.scrims) {
      for (const day of DAYS) {
        if (data.scrims[day]) scrims[day] = data.scrims[day];
      }
    }
    if (data.displayNames) Object.assign(displayNames, data.displayNames);
    console.log('État chargé depuis le fichier.');
    stateLoadedFromFile = true;
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
      JSON.stringify({ version: STATE_VERSION, scrims, displayNames }, null, 2)
    );
  } catch (err) {
    console.error('Erreur sauvegarde état:', err.message);
  }
}

// --- Helpers ---
const DAY_MAP = {
  lundi: 1, mardi: 2, mercredi: 3, jeudi: 4,
  vendredi: 5, samedi: 6, dimanche: 0
};

function isTodayScrimDay(day) {
  return new Date().getDay() === DAY_MAP[day];
}

function isComplete(day) {
  return ROLES.every(role => scrims[day][role].length > 0);
}

function countFilled(day) {
  return ROLES.filter(role => scrims[day][role].length > 0).length;
}

function playerName(userId) {
  return displayNames[userId] || `<@${userId}>`;
}

function resolveUserId(rawName, nameToId) {
  const mentionMatch = rawName.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  return nameToId.get(rawName) || null;
}

async function recoverStateFromChannels(guild) {
  const inviteChannel = guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
  if (!inviteChannel) return false;

  const msgs = await inviteChannel.messages.fetch({ limit: 50 });
  const botMsgs = msgs.filter(m => m.author.id === client.user.id);

  if (botMsgs.size === 0) return false;

  try {
    await guild.members.fetch();
  } catch (err) {
    console.error('Impossible de fetch les membres (activer GuildMembers intent):', err.message);
    return false;
  }

  const nameToId = new Map();
  for (const [, member] of guild.members.cache) {
    nameToId.set(member.user.username, member.user.id);
    displayNames[member.user.id] = member.user.username;
  }

  let recovered = false;

  for (const msg of botMsgs.values()) {
    const lines = msg.content.split('\n');

    const headerMatch = lines[0]?.match(/^## (\S+) — SCRIM$/);
    if (!headerMatch) continue;
    const day = headerMatch[1].toLowerCase();
    if (!DAYS.includes(day)) continue;

    recovered = true;
    scrims[day] = { TOP: [], JGL: [], MID: [], ADC: [], SUPP: [] };

    if (lines[1]) {
      const parts = lines[1].split(' | ');
      for (const part of parts) {
        const m = part.trim().match(/^\*\*(\w+)\*\* : (.+)$/);
        if (!m) continue;
        const role = m[1];
        const rawName = m[2].trim();
        if (rawName === 'libre' || !ROLES.includes(role)) continue;

        const id = resolveUserId(rawName, nameToId);
        if (id) scrims[day][role].push(id);
      }
    }

    for (const line of lines) {
      if (!line.startsWith('**Remplaçants**')) continue;
      const content = line.replace(/^\*\*Remplaçants\*\* : /, '');
      if (content === 'Aucun') break;

      const subs = content.split(', ');
      for (const sub of subs) {
        const m = sub.trim().match(/^(.+) \((\w+)\)$/);
        if (!m) continue;
        const rawName = m[1].trim();
        const role = m[2];
        if (!ROLES.includes(role)) continue;

        const id = resolveUserId(rawName, nameToId);
        if (id) scrims[day][role].push(id);
      }
      break;
    }
  }

  return recovered;
}

async function syncGuildChannels(guild) {
  const inviteChannel = guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
  if (!inviteChannel) return;

  const msgs = await inviteChannel.messages.fetch({ limit: 50 });
  const botMsgs = msgs.filter(m => m.author.id === client.user.id);

  for (const msg of botMsgs.values()) {
    const lines = msg.content.split('\n');
    const headerMatch = lines[0]?.match(/^## (\S+) — SCRIM$/);
    if (!headerMatch) continue;
    const day = headerMatch[1].toLowerCase();
    if (!DAYS.includes(day)) continue;

    try {
      await msg.edit({ content: buildInviteMessage(day), components: buildButtons(day) });
    } catch (err) {
      console.error(`Erreur sync message ${day}:`, err.message);
    }
  }

  await updateRecap(guild);
}

// --- Message builders ---
function buildInviteMessage(day) {
  const rosterParts = ROLES.map(role => {
    const players = scrims[day][role];
    return `**${role}** : ${players.length > 0 ? playerName(players[0]) : 'libre'}`;
  });

  let text = `## ${day.toUpperCase()} — SCRIM\n`;
  text += rosterParts.join(' | ') + '\n';

  const subs = [];
  for (const role of ROLES) {
    for (let i = 1; i < scrims[day][role].length; i++) {
      subs.push(`${playerName(scrims[day][role][i])} (${role})`);
    }
  }

  text += `**Remplaçants** : ${subs.length > 0 ? subs.join(', ') : 'Aucun'}`;
  return text;
}

function buildRecapMessage() {
  let text = `## 📋 RÉCAPITULATIF SCRIM — SEMAINE EN COURS\n\n`;

  for (const day of DAYS) {
    const filled = countFilled(day);
    const complete = isComplete(day);
    const icon = complete ? '✅' : filled > 0 ? '⚠️' : '❌';

    text += `${icon} **${day.toUpperCase()}** (${filled}/5)\n`;

    if (filled > 0) {
      const parts = ROLES.map(role => {
        const p = scrims[day][role];
        return `${role}: ${p.length > 0 ? playerName(p[0]) : 'libre'}`;
      });
      text += parts.join(' | ') + '\n';

      const subs = [];
      for (const role of ROLES) {
        for (let i = 1; i < scrims[day][role].length; i++) {
          subs.push(`${playerName(scrims[day][role][i])} (${role})`);
        }
      }
      if (subs.length > 0) {
        text += `**Remplaçants** : ${subs.join(', ')}\n`;
      }
    } else {
      text += `Aucun inscrit\n`;
    }

    text += '\n';
  }

  return text;
}

// --- Button builder ---
function buildButtons(day) {
  const roleButtons = ROLES.map(role => {
    const taken = scrims[day][role].length > 0;
    return new ButtonBuilder()
      .setCustomId(`${role}:${day}`)
      .setLabel(`${taken ? '🔴' : '🟢'} ${role}`)
      .setStyle(taken ? ButtonStyle.Secondary : ButtonStyle.Primary);
  });

  const row1 = new ActionRowBuilder().addComponents(...roleButtons);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`REMOVE:${day}`)
      .setLabel('Se désinscrire')
      .setStyle(ButtonStyle.Danger)
  );

  return [row1, row2];
}

// --- Channel helpers ---
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

// --- Recap update ---
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

// --- Notifications ---
async function notifyComplete(guild, day) {
  const recapChannel = guild.channels.cache.find(c => c.name === RECAP_CHANNEL);
  if (!recapChannel) return;

  const mentions = ROLES.map(role => `<@${scrims[day][role][0]}>`).join(' ');
  await recapChannel.send(
    `🎮 **L'équipe du ${day.toUpperCase()} est complète !**\n${mentions}\nScrim ${day} confirmé ! 🏆`
  );
}

async function notifyIncomplete(guild, day, cancelledUserId) {
  const recapChannel = guild.channels.cache.find(c => c.name === RECAP_CHANNEL);
  if (!recapChannel) return;

  const missingRoles = ROLES.filter(role => scrims[day][role].length === 0);
  const remainingMentions = ROLES
    .filter(role => scrims[day][role].length > 0)
    .map(role => `<@${scrims[day][role][0]}>`)
    .join(' ');

  let msg = `⚠️ **Annulation tardive — ${day.toUpperCase()}**\n`;
  msg += `**${playerName(cancelledUserId)}** s'est désinscrit(e). L'équipe n'est plus complète.\n`;
  msg += `**Poste(s) libre(s)** : ${missingRoles.join(', ')}\n`;
  if (remainingMentions) msg += `${remainingMentions} — un remplaçant est recherché !`;

  await recapChannel.send(msg);
}

async function notifyAutoPromote(guild, day, role, promotedId) {
  const recapChannel = guild.channels.cache.find(c => c.name === RECAP_CHANNEL);
  if (!recapChannel) return;

  await recapChannel.send(
    `🔄 **${playerName(promotedId)}** a été promu(e) remplaçant → titulaire sur le poste **${role}** (${day.toUpperCase()}).`
  );
}

// --- Full reset ---
async function fullReset(guild) {
  for (const day of DAYS) {
    for (const role of ROLES) {
      scrims[day][role] = [];
    }
  }
  await saveState();

  const inviteChannel = await getOrCreateChannel(guild, INVITE_CHANNEL);
  const msgs = await inviteChannel.messages.fetch({ limit: 100 });
  for (const msg of msgs.filter(m => m.author.id === client.user.id).values()) {
    await msg.delete();
  }
  for (const day of DAYS) {
    await inviteChannel.send({ content: buildInviteMessage(day), components: buildButtons(day) });
  }

  const recapChannel = await getOrCreateChannel(guild, RECAP_CHANNEL);
  const recapMsgs = await recapChannel.messages.fetch({ limit: 10 });
  const existingRecap = recapMsgs.find(m => m.author.id === client.user.id);

  if (existingRecap) {
    await existingRecap.edit({ content: buildRecapMessage() });
  } else {
    await recapChannel.send({ content: buildRecapMessage() });
  }
}

// --- Client setup ---
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

// --- Slash commands ---
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Créer les salons invitation-scrim et recap-scrim'),
  new SlashCommandBuilder()
    .setName('resetweek')
    .setDescription('Reset toutes les inscriptions et renvoie les invitations')
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

// --- Events ---
client.once(Events.ClientReady, async () => {
  console.log(`Bot connecté : ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    if (!stateLoadedFromFile) {
      const recovered = await recoverStateFromChannels(guild);
      if (recovered) {
        await saveState();
        console.log('État récupéré depuis les messages du salon.');
      }
    }

    await syncGuildChannels(guild);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction);
  } else if (interaction.isButton()) {
    await handleButton(interaction);
  }
});

async function handleCommand(interaction) {
  const { commandName, member, guild } = interaction;

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

    for (const day of DAYS) {
      await inviteChannel.send({ content: buildInviteMessage(day), components: buildButtons(day) });
    }
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

async function handleButton(interaction) {
  const [action, day] = interaction.customId.split(':');

  if (!day || !DAYS.includes(day)) {
    await interaction.deferUpdate();
    return;
  }

  const lock = locks[day];
  await lock.acquire();

  try {
    const userId = interaction.user.id;
    displayNames[userId] = interaction.user.username;

    const wasComplete = isComplete(day);
    const promotions = [];

    for (const role of ROLES) {
      if (action !== 'REMOVE' && role === action) continue;

      const idx = scrims[day][role].indexOf(userId);
      if (idx === -1) continue;

      scrims[day][role].splice(idx, 1);

      if (idx === 0 && scrims[day][role].length > 0) {
        promotions.push({ role, promotedId: scrims[day][role][0] });
      }
    }

    if (action !== 'REMOVE' && !scrims[day][action].includes(userId)) {
      scrims[day][action].push(userId);
    }

    await saveState();

    await interaction.update({
      content: buildInviteMessage(day),
      components: buildButtons(day)
    });

    await updateRecap(interaction.guild);

    for (const { role: promRole, promotedId } of promotions) {
      await notifyAutoPromote(interaction.guild, day, promRole, promotedId);
    }

    if (!wasComplete && isComplete(day)) {
      await notifyComplete(interaction.guild, day);
    }

    if (wasComplete && !isComplete(day) && isTodayScrimDay(day)) {
      await notifyIncomplete(interaction.guild, day, userId);
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

// --- Cron: weekly reset every Monday at midnight ---
cron.schedule('0 0 * * 1', async () => {
  console.log('Reset automatique de la semaine');
  for (const guild of client.guilds.cache.values()) {
    await fullReset(guild);
  }
}, { timezone: TIMEZONE });

// --- Graceful shutdown ---
async function shutdown() {
  console.log('Arrêt en cours...');
  await saveState();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start ---
(async () => {
  await loadState();
  client.login(TOKEN);
})();
