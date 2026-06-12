const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} = require('discord.js');
const cron = require('node-cron');

const state = require('./state');
const scrims = require('./scrims');
const discord = require('./discord-utils');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN et DISCORD_CLIENT_ID sont requis.');
  process.exit(1);
}

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
        .addChoices(...state.DAYS.map(d => ({ name: d, value: d }))))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

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

    await discord.syncGuildChannels(guild);
  }
  console.log('Prêt.');
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModal(interaction);
    }
  } catch (err) {
    console.error('Erreur InteractionCreate:', err);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.reply({ content: `❌ Erreur interne: ${err.message}`, ephemeral: true }); } catch (e) {}
    }
  }
});

async function handleCommand(interaction) {
  const { commandName, member, guild, user } = interaction;

  if (commandName === 'setpref') {
    state.displayNames[user.id] = user.username;
    const prefs = state.playerProfiles[user.id];
    const hasTooMany3s = prefs && state.ROLES.filter(r => prefs[r] === 3).length > 1;
    if (hasTooMany3s) {
      const modal = scrims.showPrefModal(user.id, 'SETPREF');
      await interaction.showModal(modal);
      return;
    }
    const modal = scrims.showRiotIdModal(user.id, 'SETPREF');
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
    const inviteChannel = await discord.getOrCreateChannel(guild, state.INVITE_CHANNEL);

    await inviteChannel.send({ content: scrims.buildInviteContent(), components: scrims.buildInviteButtons() });

    await interaction.editReply(`Salon <#${inviteChannel.id}> prêt !`);
  }

  if (commandName === 'resetweek') {
    await interaction.deferReply({ ephemeral: true });
    await discord.fullReset(guild);

    const inviteChannel = guild.channels.cache.find(c => c.name === state.INVITE_CHANNEL);

    await interaction.editReply(
      `Semaine réinitialisée ! Salon <#${inviteChannel?.id}>.`
    );
  }

  if (commandName === 'confirm') {
    await interaction.deferReply({ ephemeral: true });
    const day = interaction.options.getString('day');
    const lineup = state.scrims[day]?.lineup;
    if (!lineup || !state.ROLES.every(r => lineup[r] != null)) {
      await interaction.editReply(`⚠️ Composition incomplète pour **${day.toUpperCase()}**, confirmation impossible.`);
      return;
    }
    await discord.confirmScrim(guild, day);
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

    if (!state.playerProfiles[userId]) {
      state.playerProfiles[userId] = {};
    }

    state.playerProfiles[userId].riotId = riotId || '';
    state.displayNames[userId] = user.username;
    await state.saveState();

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
    } else if (target && state.DAYS.includes(target) && guild) {
      const lock = state.locks[target];
      await lock.acquire();
      try {
        if (!scrims.isDayLocked(target) && !state.scrims[target].available.includes(userId)) {
          state.scrims[target].available.push(userId);
          const { lineup, substitutes } = scrims.calculateBestLineup(target);
          state.scrims[target].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
          state.scrims[target].substitutes = substitutes;
          await state.saveState();
          await discord.tryPostConfirmation(guild, target);
          await discord.updateInviteTable(guild);
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

  if (!state.playerProfiles[userId]) {
    state.playerProfiles[userId] = {};
  }

  let valid = true;
  for (const role of state.ROLES) {
    const value = interaction.fields.getTextInputValue(`PREF_${role}`);
    const score = parseInt(value);

    if (isNaN(score) || score < 0 || score > 3) {
      valid = false;
      break;
    }

    state.playerProfiles[userId][role] = score;
  }

  if (!valid) {
    return interaction.reply({
      content: 'Erreur: Chaque rôle doit avoir une valeur entre 0 et 3.',
      ephemeral: true
    });
  }

  const count3 = state.ROLES.filter(r => state.playerProfiles[userId][r] === 3).length;
  if (count3 > 1) {
    const [, , context] = customId.split(':');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`PREF_FIX:${context || ''}`)
        .setLabel('Modifier mes rôles')
        .setStyle(ButtonStyle.Danger)
    );
    return interaction.reply({
      content: '❌ Un seul rôle peut être "principal" (valeur 3). Corrige pour continuer.',
      components: [row],
      ephemeral: true
    });
  }

  state.displayNames[userId] = user.username;
  await state.saveState();

  const parts = customId.split(':');
  const autoDay = parts[2];

  let autoRegistered = false;
  let dayLocked = false;

  if (autoDay && state.DAYS.includes(autoDay) && guild) {
    if (state.playerProfiles[userId]?.riotId) {
      const lock = state.locks[autoDay];
      await lock.acquire();
      try {
        if (!state.scrims[autoDay].available.includes(userId)) {
          if (scrims.isDayLocked(autoDay)) {
            dayLocked = true;
          } else {
            state.scrims[autoDay].available.push(userId);
            autoRegistered = true;
            const { lineup, substitutes } = scrims.calculateBestLineup(autoDay);
            state.scrims[autoDay].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
            state.scrims[autoDay].substitutes = substitutes;
            await state.saveState();
            await discord.tryPostConfirmation(guild, autoDay);
            await discord.updateInviteTable(guild);
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
    content: `✅ Préférences mises à jour!\n${state.ROLES.map(r => `${r}: ${state.playerProfiles[userId][r]}`).join(' | ')}${extra}`,
    ephemeral: true
  });
}

async function handleButton(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[0];
  const day = parts[1];

  const userId = interaction.user.id;
  state.displayNames[userId] = interaction.user.username;

  if (action === 'OPGG_BTN') {
    const d = parts[1] && state.DAYS.includes(parts[1]) ? parts[1] : null;
    const modal = scrims.showRiotIdModal(userId, d);
    await interaction.showModal(modal);
    return;
  }

  if (action === 'SETPREF_CONTINUE') {
    const modal = scrims.showPrefModal(userId);
    await interaction.showModal(modal);
    return;
  }

  if (action === 'PREF_FIX') {
    const context = parts[1];
    const modal = scrims.showPrefModal(userId, context || null);
    await interaction.showModal(modal);
    return;
  }

  if (action !== 'DISPO' || !day || !state.DAYS.includes(day)) {
    await interaction.deferUpdate();
    return;
  }

  const prefs = state.playerProfiles[userId];
  const invalidPrefs = prefs && state.ROLES.filter(r => prefs[r] === 3).length > 1;
  if (!state.hasProfile(userId) || invalidPrefs) {
    try {
      const modal = scrims.showPrefModal(userId, day);
      await interaction.showModal(modal);
    } catch (e) {
      console.error('Erreur showModal DISPO pref:', e);
      await interaction.reply({ content: `❌ Erreur: ${e.message}`, ephemeral: true });
    }
    return;
  }

  if (!state.playerProfiles[userId]?.riotId) {
    const modal = scrims.showRiotIdModal(userId, day);
    await interaction.showModal(modal);
    return;
  }

  const lock = state.locks[day];
  await lock.acquire();

  try {
    const isAvailable = state.scrims[day].available.includes(userId);

    if (scrims.isDayLocked(day)) {
      if (!isAvailable) {
        await interaction.reply({ content: `🔒 Inscriptions fermées pour **${day.toUpperCase()}**.`, ephemeral: true });
        return;
      }

      state.scrims[day].available = state.scrims[day].available.filter(id => id !== userId);
      const oldLineup = { ...state.scrims[day].lineup };
      const { lineup, substitutes } = scrims.calculateBestLineup(day);
      state.scrims[day].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
      state.scrims[day].substitutes = substitutes;
      await state.saveState();
      await discord.updateInviteTable(interaction.guild);
      await interaction.deferUpdate();

      if (lineup) {
        const oldPlayers = Object.values(oldLineup).filter(Boolean);
        const promoted = Object.values(lineup).find(p => p && !oldPlayers.includes(p));
        if (promoted) {
          const inviteChannel = interaction.guild.channels.cache.find(c => c.name === state.INVITE_CHANNEL);
          if (inviteChannel) await inviteChannel.send(`🔄 <@${promoted}> promu dans la lineup **${day.toUpperCase()}** !`);
        }
      } else {
        const inviteChannel = interaction.guild.channels.cache.find(c => c.name === state.INVITE_CHANNEL);
        if (inviteChannel) {
          const jsDay = new Date().getDay();
          const today = state.DAYS[(jsDay + 6) % 7];
          if (day === today) {
            const remainingMentions = state.scrims[day].available.map(id => `<@${id}>`).join(' ');
            await inviteChannel.send(`⚠️ **${day.toUpperCase()}** — Un joueur s'est désisté ! Il reste **${state.scrims[day].available.length}/5** inscrits. ${remainingMentions}, il faut chercher un last pour ce soir`);
          }
        }
      }
      return;
    }

    if (isAvailable) {
      state.scrims[day].available = state.scrims[day].available.filter(id => id !== userId);
    } else {
      state.scrims[day].available.push(userId);
    }

    const { lineup, substitutes } = scrims.calculateBestLineup(day);
    state.scrims[day].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
    state.scrims[day].substitutes = substitutes;

    await state.saveState();
    await discord.tryPostConfirmation(interaction.guild, day);
    await discord.updateInviteTable(interaction.guild);
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

cron.schedule('30 5 * * *', async () => {
  try {
    console.log('Vérification auto des scrims (05:30)');

    const jsDay = new Date().getDay();
    const today = state.DAYS[(jsDay + 6) % 7];
    const todayIdx = state.DAYS.indexOf(today);
    const prevDay = state.DAYS[(todayIdx + 6) % 7];

    for (const guild of client.guilds.cache.values()) {
      try {
        await discord.cleanupOldConfirmations(guild);
        await discord.resetDay(guild, prevDay);
      } catch (e) {
        console.error(`Erreur cleanup/reset pour ${guild.name}:`, e.message);
      }
    }

    await state.saveState();

    if (!state.scrims[today] || state.scrims[today].available.length < 5) return;

    const { lineup, substitutes } = scrims.calculateBestLineup(today);
    state.scrims[today].lineup = lineup || { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null };
    state.scrims[today].substitutes = substitutes;

    for (const guild of client.guilds.cache.values()) {
      try {
        await discord.tryPostConfirmation(guild, today);
      } catch (e) {
        console.error(`Erreur confirmation pour ${guild.name}:`, e.message);
      }
    }
  } catch (err) {
    console.error('Erreur cron 05:30:', err);
  }
}, { timezone: state.TIMEZONE });

async function startBot() {
  await client.login(TOKEN);
  return client;
}

module.exports = { startBot, client };
