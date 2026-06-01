require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionsBitField,
  MessageType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const cron = require('node-cron');
const fs = require('fs/promises');
const express = require('express');
const cors = require('cors');
const path = require('path');

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

function permute(arr) {
  if (arr.length <= 1) return [arr];
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const current = arr[i];
    const remaining = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permute(remaining)) {
      result.push([current, ...perm]);
    }
  }
  return result;
}

const ROLE_PERMUTATIONS = permute(ROLES);

function evaluateCombo(combo) {
  let bestScore = -1;
  let bestAssignment = null;
  let bestTiebreaker = 0;

  for (const roleOrder of ROLE_PERMUTATIONS) {
    let score = 0;
    let tiebreaker = 0;
    for (let i = 0; i < combo.length; i++) {
      const prefs = playerProfiles[combo[i]] || {};
      const pref = prefs[roleOrder[i]] || 0;
      score += pref;
      if (pref === 3) tiebreaker += combo.length - i;
    }
    if (score > bestScore || (score === bestScore && tiebreaker > bestTiebreaker)) {
      bestScore = score;
      bestAssignment = roleOrder;
      bestTiebreaker = tiebreaker;
    }
  }

  return { score: bestScore, assignment: bestAssignment };
}

function calculateBestLineup(day) {
  const available = scrims[day].available;

  if (available.length < 5) {
    return { lineup: null, substitutes: [] };
  }

  const combinations = generateCombinations(available, 5);
  let bestScore = -1;
  let bestCombination = null;
  let bestAssignment = null;

  for (const combo of combinations) {
    const { score, assignment } = evaluateCombo(combo);
    if (score > bestScore) {
      bestScore = score;
      bestCombination = combo;
      bestAssignment = assignment;
    }
  }

  if (!bestCombination) {
    return { lineup: null, substitutes: [] };
  }

  const lineup = { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
  for (let i = 0; i < bestCombination.length; i++) {
    lineup[bestAssignment[i]] = bestCombination[i];
  }
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

function dayDate(day) {
  const now = new Date();
  const jsToday = now.getDay();
  const todayIdx = DAYS.indexOf(DAYS[(jsToday + 6) % 7]);
  const diff = (7 + DAYS.indexOf(day) - todayIdx) % 7;
  const d = new Date(now);
  d.setDate(now.getDate() + diff);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function buildInviteContent() {
  const jsDay = new Date().getDay();
  const todayIdx = (jsDay + 6) % 7;
  const ordered = [...DAYS.slice(todayIdx), ...DAYS.slice(0, todayIdx)];

  let text = '## DISPO — SCRIM\n';

  for (const day of ordered) {
    const count = scrims[day].available.length;
    const lineup = scrims[day].lineup;
    const complete = ROLES.every(r => lineup[r] != null);
    const date = dayDate(day);

    const inviteSuffix = isDayLocked(day) ? ' 🔒' : ' — 🔓 Inscrivez-vous !';
    text += `\n📅 **${day.toUpperCase()} ${date}**\n👥 **${count}** joueurs inscrits${inviteSuffix}\n`;

    if (complete) {
      const parts = [];
      const scores = [];
      for (const role of ROLES) {
        const pid = lineup[role];
        if (pid) {
          const score = playerProfiles[pid]?.[role] || 0;
          parts.push(`\`${role}\` ${playerName(pid)} **${score}**`);
          scores.push(String(score));
        }
      }
      text += parts.join(' · ') + '\n';

      const subs = scrims[day].substitutes;
      if (subs.length > 0) {
        text += `*Sub: ${subs.map(id => playerName(id)).join(', ')}*\n`;
      }

      const total = scores.reduce((a, b) => a + Number(b), 0);
      text += `Lineup: **${total}** (${scores.join('+')})\n`;
    } else if (count > 0) {
      text += scrims[day].available.map(id => playerName(id)).join(' · ') + '\n';
    }
  }

  return text;
}

function isDayLocked(day) {
  const jsDay = new Date().getDay();
  const today = DAYS[(jsDay + 6) % 7];
  const todayIdx = DAYS.indexOf(today);
  const targetIdx = DAYS.indexOf(day);

  const lineupComplete = ROLES.every(r => scrims[day].lineup[r] != null);
  if (!lineupComplete) return false;

  if (targetIdx < todayIdx) return true;
  if (targetIdx > todayIdx) return false;

  const now = new Date();
  const time = now.toLocaleString('fr-FR', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = time.split(':').map(Number);
  return h > 5 || (h === 5 && m >= 30);
}

function buildInviteButtons() {
  const makeRow = (days) => {
    const row = new ActionRowBuilder();
    for (const day of days) {
      const count = scrims[day].available.length;
      const locked = isDayLocked(day);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`DISPO:${day}`)
          .setLabel(locked ? `🔒 ${day.slice(0, 3).toUpperCase()} (${count})` : `${day.slice(0, 3).toUpperCase()} (${count})`)
          .setStyle(locked ? ButtonStyle.Secondary : ButtonStyle.Primary)
      );
    }
    return row;
  };

  return [makeRow(DAYS.slice(0, 5)), makeRow(DAYS.slice(5))];
}

async function updateInviteTable(guild) {
  const inviteChannel = guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
  if (!inviteChannel) return;

  const msgs = await inviteChannel.messages.fetch({ limit: 100 });
  const opts = { content: buildInviteContent(), components: buildInviteButtons() };
  const dispos = msgs.filter(m => m.author.id === client.user.id && m.content.startsWith('## DISPO'));

  if (dispos.size > 0) {
    await dispos.first().edit(opts);
    for (const [, msg] of dispos) {
      if (msg !== dispos.first()) {
        try { await msg.delete(); } catch (e) {}
      }
    }
  } else {
    await inviteChannel.send(opts);
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
  await updateInviteTable(guild);
}

async function confirmScrim(guild, day) {
  const inviteChannel = guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
  if (!inviteChannel) return;

  const lineup = scrims[day].lineup;
  if (!lineup || !ROLES.every(r => lineup[r] != null)) return;

  let text = `🎮 **Composition — ${day.toUpperCase()}**\n`;
  for (const role of ROLES) {
    text += `**${role}** : <@${lineup[role]}>\n`;
  }
  const subs = scrims[day].substitutes;
  if (subs.length > 0) {
    text += `\n**Remplaçants:** ${subs.map(id => `<@${id}>`).join(', ')}\n`;
  }

  text += `\n✅ Scrim confirmé !`;

  const msg = await inviteChannel.send(text);

  try {
    const thread = await msg.startThread({
      name: `Composition - ${day.toUpperCase()}`,
      autoArchiveDuration: 1440,
    });

    const mentions = [];
    for (const role of ROLES) {
      const pid = lineup[role];
      if (pid) {
        try { await thread.members.add(pid); } catch (e) {}
        mentions.push(`<@${pid}>`);
      }
    }
    for (const sid of subs) {
      try { await thread.members.add(sid); } catch (e) {}
    }

    let threadText = `📢 ${mentions.join(' ')} — Composition prête pour **${day.toUpperCase()}** !`;

    threadText += `\n\n**Pour trouver un scrim ce soir**, postez/mp sur discord **League of legends FR** (channel scrims) ou dans vos contacts. Généralement les scrims se jouent vers **20H/21H**. Qui peut s'en occuper ?`;

    const riotIds = ROLES.map(role => {
      const pid = lineup[role];
      return playerProfiles[pid]?.riotId;
    }).filter(Boolean);

    if (riotIds.length > 0) {
      const encoded = riotIds.map(id => encodeURIComponent(id)).join(',');
      threadText += `\n\n**Team OPGG:** <https://www.op.gg/multisearch/euw?summoners=${encoded}>`;
    }

    await thread.send(threadText);

    const recent = await inviteChannel.messages.fetch({ limit: 2 });
    const sysMsg = recent.find(m => m.type === MessageType.ThreadCreated && m.thread?.id === thread.id);
    if (sysMsg) await sysMsg.delete().catch(() => {});
  } catch (err) {
    console.error('Erreur création fil:', err.message);
  }
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

function showRiotIdModal(userId, day = null) {
  const customId = day ? `OPGG_MODAL:${userId}:${day}` : `OPGG_MODAL:${userId}`;
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Riot ID');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('RIOT_ID')
        .setLabel('Riot ID (Nom#Tag)')
        .setStyle(TextInputStyle.Short)
        .setValue(playerProfiles[userId]?.riotId || '')
        .setRequired(true)
        .setPlaceholder('toto#euw')
    )
  );

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
    .setDescription('Définir vos préférences de rôles (0-3 points par rôle)'),
  new SlashCommandBuilder()
    .setName('confirm')
    .setDescription('Reposter le message de confirmation pour un jour')
    .addStringOption(option =>
      option.setName('day')
        .setDescription('Jour à confirmer')
        .setRequired(true)
        .addChoices(...DAYS.map(d => ({ name: d, value: d }))))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once(Events.ClientReady, async () => {
  console.log(`Bot connecté : ${client.user.tag}`);

  const globalCmds = await rest.get(Routes.applicationCommands(CLIENT_ID));
  for (const cmd of globalCmds) {
    await rest.delete(Routes.applicationCommand(CLIENT_ID, cmd.id));
    console.log(`Commande globale supprimée: ${cmd.name}`);
  }

  for (const guild of client.guilds.cache.values()) {
    const guildCmds = await rest.get(Routes.applicationGuildCommands(CLIENT_ID, guild.id));
    for (const cmd of guildCmds) {
      await rest.delete(Routes.applicationGuildCommand(CLIENT_ID, guild.id, cmd.id));
    }

    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guild.id), { body: commands });
    console.log(`Commandes enregistrées sur ${guild.name}`);

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
    const modal = showRiotIdModal(user.id, 'SETPREF');
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

  if (commandName === 'confirm') {
    await interaction.deferReply({ ephemeral: true });
    const day = interaction.options.getString('day');
    const lineup = scrims[day]?.lineup;
    if (!lineup || !ROLES.every(r => lineup[r] != null)) {
      await interaction.editReply(`⚠️ Composition incomplète pour **${day.toUpperCase()}**, confirmation impossible.`);
      return;
    }
    await confirmScrim(guild, day);
    await interaction.editReply(`✅ Message de confirmation reposté pour **${day.toUpperCase()}**\n📌 Fil créé avec les joueurs.`);
  }
}

async function handleModal(interaction) {
  const { customId, user, guild } = interaction;

  if (customId.startsWith('OPGG_MODAL:')) {
    const userId = customId.split(':')[1];
    if (userId !== user.id) {
      return interaction.reply({ content: 'Erreur: ID utilisateur ne correspond pas.', ephemeral: true });
    }

    const riotId = interaction.fields.getTextInputValue('RIOT_ID');

    if (!playerProfiles[userId]) {
      playerProfiles[userId] = {};
    }

    playerProfiles[userId].riotId = riotId || '';
    displayNames[userId] = user.username;
    await saveState();

    const target = customId.split(':')[2];
    if (target === 'SETPREF') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('SETPREF_CONTINUE')
          .setLabel('Choisir mes rôles')
          .setStyle(ButtonStyle.Success)
      );
      await interaction.reply({
        content: `✅ Riot ID mis à jour : ${riotId}\nCliquez pour définir vos préférences de rôles.`,
        components: [row],
        ephemeral: true
      });
    } else if (target && DAYS.includes(target) && guild) {
      const lock = locks[target];
      await lock.acquire();
      try {
        if (!isDayLocked(target) && !scrims[target].available.includes(userId)) {
          scrims[target].available.push(userId);
          const { lineup, substitutes } = calculateBestLineup(target);
          scrims[target].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
          scrims[target].substitutes = substitutes;
          await saveState();
          await tryPostConfirmation(guild, target);
          await updateInviteTable(guild);
        }
      } catch (err) {
        console.error('Erreur OPGG register:', err.message);
      } finally {
        lock.release();
      }
      await interaction.reply({
        content: `✅ Riot ID mis à jour : ${riotId}\n📝 Inscrit pour **${target.toUpperCase()}** !`,
        ephemeral: true
      });
    } else {
      await interaction.reply({
        content: `✅ Riot ID mis à jour : ${riotId}`,
        ephemeral: true
      });
    }
    return;
  }

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

  let autoRegistered = false;
  let dayLocked = false;

  if (autoDay && DAYS.includes(autoDay) && guild) {
    if (playerProfiles[userId]?.riotId) {
      const lock = locks[autoDay];
      await lock.acquire();
      try {
        if (!scrims[autoDay].available.includes(userId)) {
          if (isDayLocked(autoDay)) {
            dayLocked = true;
          } else {
            scrims[autoDay].available.push(userId);
            autoRegistered = true;
            const { lineup, substitutes } = calculateBestLineup(autoDay);
            scrims[autoDay].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
            scrims[autoDay].substitutes = substitutes;
            await saveState();
            await tryPostConfirmation(guild, autoDay);
            await updateInviteTable(guild);
          }
        }
      } catch (err) {
        console.error('Erreur auto-register:', err.message);
      } finally {
        lock.release();
      }
    } else {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`OPGG_BTN:${autoDay}`)
          .setLabel('Ajouter mon Riot ID')
          .setStyle(ButtonStyle.Success)
      );
      await interaction.reply({
        content: `✅ Préférences sauvegardées !\nAjoutez votre Riot ID pour finaliser l'inscription à **${autoDay.toUpperCase()}**.`,
        components: [row],
        ephemeral: true
      });
      return;
    }
  }

  let extra = '';
  if (autoRegistered) extra = `\n📝 Inscrit automatiquement pour **${autoDay.toUpperCase()}**`;
  else if (dayLocked) extra = `\n⚠️ Inscriptions fermées pour **${autoDay.toUpperCase()}**`;

  await interaction.reply({
    content: `✅ Préférences mises à jour!\n${ROLES.map(r => `${r}: ${playerProfiles[userId][r]}`).join(' | ')}${extra}`,
    ephemeral: true
  });
}

async function handleButton(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[0];
  const day = parts[1];

  const userId = interaction.user.id;
  displayNames[userId] = interaction.user.username;

  if (action === 'OPGG_BTN') {
    const d = parts[1] && DAYS.includes(parts[1]) ? parts[1] : null;
    const modal = showRiotIdModal(userId, d);
    await interaction.showModal(modal);
    return;
  }

  if (action === 'SETPREF_CONTINUE') {
    const modal = showPrefModal(userId);
    await interaction.showModal(modal);
    return;
  }

  if (action !== 'DISPO' || !day || !DAYS.includes(day)) {
    await interaction.deferUpdate();
    return;
  }

  if (!hasProfile(userId)) {
    const modal = showPrefModal(userId, day);
    await interaction.showModal(modal);
    return;
  }

  if (!playerProfiles[userId]?.riotId) {
    const modal = showRiotIdModal(userId, day);
    await interaction.showModal(modal);
    return;
  }

  const lock = locks[day];
  await lock.acquire();

  try {
    const isAvailable = scrims[day].available.includes(userId);

    if (isDayLocked(day)) {
      if (!isAvailable) {
        await interaction.reply({ content: `🔒 Inscriptions fermées pour **${day.toUpperCase()}**.`, ephemeral: true });
        return;
      }

      scrims[day].available = scrims[day].available.filter(id => id !== userId);
      const oldLineup = { ...scrims[day].lineup };
      const { lineup, substitutes } = calculateBestLineup(day);
      scrims[day].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
      scrims[day].substitutes = substitutes;
      await saveState();
      await updateInviteTable(interaction.guild);
      await interaction.deferUpdate();

      if (lineup) {
        const oldPlayers = Object.values(oldLineup).filter(Boolean);
        const promoted = Object.values(lineup).find(p => p && !oldPlayers.includes(p));
        if (promoted) {
          const inviteChannel = interaction.guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
          if (inviteChannel) await inviteChannel.send(`🔄 <@${promoted}> promu dans la lineup **${day.toUpperCase()}** !`);
        }
      } else {
        const inviteChannel = interaction.guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
        if (inviteChannel) {
          const jsDay = new Date().getDay();
          const today = DAYS[(jsDay + 6) % 7];
          if (day === today) {
            const remainingMentions = scrims[day].available.map(id => `<@${id}>`).join(' ');
            await inviteChannel.send(`⚠️ **${day.toUpperCase()}** — Un joueur s'est désisté ! Il reste **${scrims[day].available.length}/5** inscrits. ${remainingMentions}, il faut chercher un last pour ce soir`);
          }
        }
      }
      return;
    }

    if (isAvailable) {
      scrims[day].available = scrims[day].available.filter(id => id !== userId);
    } else {
      scrims[day].available.push(userId);
    }

    const { lineup, substitutes } = calculateBestLineup(day);
    scrims[day].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
    scrims[day].substitutes = substitutes;

    await saveState();
    await tryPostConfirmation(interaction.guild, day);
    await updateInviteTable(interaction.guild);
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

async function tryPostConfirmation(guild, day) {
  const s = scrims[day];
  if (s.available.length < 5) return;
  if (!isDayLocked(day)) return;

  await saveState();
  await updateInviteTable(guild);
  await confirmScrim(guild, day);
}

async function cleanupOldConfirmations(guild) {
  const channel = guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
  if (!channel) return;

  const msgs = await channel.messages.fetch({ limit: 50 });
  for (const msg of msgs.filter(m => m.author.id === client.user.id).values()) {
    if (msg.content.includes('🎮 **Composition') || msg.content.includes("s'est désisté")) {
      try { await msg.delete(); } catch (e) {}
    }
  }

  const activeThreads = await channel.threads.fetchActive();
  for (const [, thread] of activeThreads.threads) {
    if (thread.name.startsWith('Composition - ')) {
      try { await thread.delete(); } catch (e) {}
    }
  }

  const archived = await channel.threads.fetchArchived();
  for (const [, thread] of archived.threads) {
    if (thread.name.startsWith('Composition - ')) {
      try { await thread.delete(); } catch (e) {}
    }
  }
}

async function resetDay(guild, day) {
  scrims[day] = {
    available: [],
    lineup: { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null },
    substitutes: []
  };
  await updateInviteTable(guild);
}

cron.schedule('30 5 * * *', async () => {
  console.log('Vérification auto des scrims (05:30)');

  const jsDay = new Date().getDay();
  const today = DAYS[(jsDay + 6) % 7];
  const todayIdx = DAYS.indexOf(today);
  const prevDay = DAYS[(todayIdx + 6) % 7];

  for (const guild of client.guilds.cache.values()) {
    await cleanupOldConfirmations(guild);
    await resetDay(guild, prevDay);
  }

  await saveState();

  if (!scrims[today] || scrims[today].available.length < 5) return;

  const { lineup, substitutes } = calculateBestLineup(today);
  scrims[today].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
  scrims[today].substitutes = substitutes;

  for (const guild of client.guilds.cache.values()) {
    await tryPostConfirmation(guild, today);
  }
}, { timezone: TIMEZONE });


function startWebServer() {
  const app = express();
  const webPort = parseInt(process.env.PORT || process.env.PORT_WEB || '3001', 10);

  app.use(cors());
  app.use(express.json());

  app.get('/api/players', (req, res) => {
    const players = Object.entries(playerProfiles).map(([id, prefs]) => ({
      id,
      name: displayNames[id] || id,
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

    for (const role of ROLES) {
      const val = preferences[role];
      if (val == null) continue;
      const score = parseInt(val, 10);
      if (isNaN(score) || score < 0 || score > 3) {
        return res.status(400).json({ error: `${role} must be 0-3` });
      }
    }

    if (!playerProfiles[id]) playerProfiles[id] = {};
    for (const role of ROLES) {
      if (preferences[role] != null) {
        playerProfiles[id][role] = parseInt(preferences[role], 10);
      }
    }

    await saveState();

    for (const day of DAYS) {
      const lock = locks[day];
      await lock.acquire();
      try {
        if (scrims[day].available.includes(id)) {
          const { lineup, substitutes } = calculateBestLineup(day);
          scrims[day].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
          scrims[day].substitutes = substitutes;
          await saveState();
          for (const guild of client.guilds.cache.values()) {
            await updateInviteTable(guild);
          }
        }
      } finally {
        lock.release();
      }
    }

    res.json({ id, name: displayNames[id] || id, preferences: playerProfiles[id] });
  });

  app.get('/api/scrims', (req, res) => {
    const result = {};
    for (const day of DAYS) {
      const s = scrims[day];
      result[day] = {
        available: s.available.map(id => ({ id, name: playerName(id) })),
        lineup: Object.fromEntries(
          ROLES.map(r => [r, s.lineup[r] ? { id: s.lineup[r], name: playerName(s.lineup[r]) } : null])
        ),
        substitutes: s.substitutes.map(id => ({ id, name: playerName(id) }))
      };
    }
    res.json(result);
  });

  app.post('/api/scrims/:day/available', async (req, res) => {
    const { day } = req.params;

    if (!DAYS.includes(day)) {
      return res.status(400).json({ error: `Invalid day. Must be one of: ${DAYS.join(', ')}` });
    }

    const { playerIds } = req.body;
    if (!Array.isArray(playerIds) || playerIds.length === 0) {
      return res.status(400).json({ error: 'playerIds must be a non-empty array of Discord user IDs' });
    }

    const lock = locks[day];
    await lock.acquire();
    try {
      const added = [];
      const skipped = [];

      for (const id of playerIds) {
        if (typeof id !== 'string' || !/^\d+$/.test(id)) {
          skipped.push({ id, reason: 'invalid format' });
          continue;
        }
        if (scrims[day].available.includes(id)) {
          skipped.push({ id, reason: 'already registered' });
          continue;
        }
        scrims[day].available.push(id);
        added.push(id);
      }

      if (added.length > 0) {
        const { lineup, substitutes } = calculateBestLineup(day);
        scrims[day].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
        scrims[day].substitutes = substitutes;
        await saveState();

        for (const guild of client.guilds.cache.values()) {
          await updateInviteTable(guild);
          await tryPostConfirmation(guild, day);
        }
      }

      res.json({
        day,
        added: added.map(id => ({ id, name: playerName(id) })),
        skipped,
        available: scrims[day].available.map(id => ({ id, name: playerName(id) })),
        lineup: Object.fromEntries(
          ROLES.map(r => [r, scrims[day].lineup[r] ? { id: scrims[day].lineup[r], name: playerName(scrims[day].lineup[r]) } : null])
        ),
        substitutes: scrims[day].substitutes.map(id => ({ id, name: playerName(id) }))
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

    if (!DAYS.includes(day)) {
      return res.status(400).json({ error: `Invalid day. Must be one of: ${DAYS.join(', ')}` });
    }

    const { playerIds } = req.body;
    if (!Array.isArray(playerIds) || playerIds.length === 0) {
      return res.status(400).json({ error: 'playerIds must be a non-empty array of Discord user IDs' });
    }

    const lock = locks[day];
    await lock.acquire();
    try {
      const removed = [];
      const skipped = [];

      for (const id of playerIds) {
        if (!scrims[day].available.includes(id)) {
          skipped.push({ id, reason: 'not registered' });
          continue;
        }
        scrims[day].available = scrims[day].available.filter(pid => pid !== id);

        for (const role of ROLES) {
          if (scrims[day].lineup[role] === id) {
            scrims[day].lineup[role] = null;
          }
        }
        scrims[day].substitutes = scrims[day].substitutes.filter(pid => pid !== id);
        removed.push(id);
      }

      if (removed.length > 0) {
        const { lineup, substitutes } = calculateBestLineup(day);
        scrims[day].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
        scrims[day].substitutes = substitutes;
        await saveState();

        for (const guild of client.guilds.cache.values()) {
          await updateInviteTable(guild);
          await tryPostConfirmation(guild, day);
          if (!lineup && scrims[day].available.length > 0) {
            const inviteChannel = guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
            if (inviteChannel) {
              const remainingMentions = scrims[day].available.map(id => `<@${id}>`).join(' ');
              await inviteChannel.send(`⚠️ **${day.toUpperCase()}** — Un joueur a été retiré ! Il reste **${scrims[day].available.length}/5** inscrits. ${remainingMentions}, il faut chercher un last pour ce soir`);
            }
          }
        }
      }

      res.json({
        day,
        removed: removed.map(id => ({ id, name: playerName(id) })),
        skipped,
        available: scrims[day].available.map(id => ({ id, name: playerName(id) })),
        lineup: Object.fromEntries(
          ROLES.map(r => [r, scrims[day].lineup[r] ? { id: scrims[day].lineup[r], name: playerName(scrims[day].lineup[r]) } : null])
        ),
        substitutes: scrims[day].substitutes.map(id => ({ id, name: playerName(id) }))
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

    if (!DAYS.includes(day)) {
      return res.status(400).json({ error: `Invalid day. Must be one of: ${DAYS.join(', ')}` });
    }

    const { playerIds } = req.body;
    if (!Array.isArray(playerIds)) {
      return res.status(400).json({ error: 'playerIds must be an array' });
    }

    const current = scrims[day].available;
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

    const lock = locks[day];
    await lock.acquire();
    try {
      scrims[day].available = [...playerIds];
      const { lineup, substitutes } = calculateBestLineup(day);
      scrims[day].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
      scrims[day].substitutes = substitutes;
      await saveState();

      for (const guild of client.guilds.cache.values()) {
        await updateInviteTable(guild);
        await tryPostConfirmation(guild, day);
      }

      res.json({
        day,
        available: scrims[day].available.map(id => ({ id, name: playerName(id) })),
        lineup: Object.fromEntries(
          ROLES.map(r => [r, scrims[day].lineup[r] ? { id: scrims[day].lineup[r], name: playerName(scrims[day].lineup[r]) } : null])
        ),
        substitutes: scrims[day].substitutes.map(id => ({ id, name: playerName(id) }))
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
      displayNames[id] = name;
    }

    await saveState();
    res.json({ displayNames });
  });

  const staticDir = path.join(__dirname, 'web', 'dist');
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
  startWebServer();
  client.login(TOKEN);
})();
