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
const fs   = require('fs');

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN et DISCORD_CLIENT_ID sont requis.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const ROLES = ['TOP', 'JGL', 'MID', 'ADC', 'SUPP'];

const INVITE_CHANNEL = 'invitation-scrim';
const RECAP_CHANNEL  = 'recap-scrim';
const STATE_FILE     = './scrims-state.json';

const scrims = {};
for (const day of DAYS) {
  scrims[day] = { TOP: [], JGL: [], MID: [], ADC: [], SUPP: [] };
}

let userIds = {};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (data.scrims) {
        for (const day of DAYS) {
          if (data.scrims[day]) scrims[day] = data.scrims[day];
        }
      }
      if (data.userIds) Object.assign(userIds, data.userIds);
      console.log('État chargé depuis le fichier.');
    }
  } catch (err) {
    console.error('Erreur chargement état:', err.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ scrims, userIds }, null, 2));
  } catch (err) {
    console.error('Erreur sauvegarde état:', err.message);
  }
}

loadState();

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Créer les salons invitation-scrim et recap-scrim'),

  new SlashCommandBuilder()
    .setName('resetweek')
    .setDescription('Reset toutes les inscriptions et renvoie les invitations')
]
.map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Commandes slash enregistrées.');
  } catch (error) {
    console.error('Erreur enregistrement commandes:', error);
  }
})();

client.once(Events.ClientReady, () => {
  console.log(`Bot connecté : ${client.user.tag}`);
});

client.on('error', err => {
  console.error('Erreur client Discord:', err.message);
});

const DAY_MAP = {
  'lundi': 1, 'mardi': 2, 'mercredi': 3, 'jeudi': 4,
  'vendredi': 5, 'samedi': 6, 'dimanche': 0
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

function buildInviteMessage(day) {
  const rosterParts = ROLES.map(role => {
    const players = scrims[day][role];
    return `**${role}** : ${players.length > 0 ? players[0] : 'libre'}`;
  });

  let text = `## ${day.toUpperCase()} — SCRIM\n`;
  text += rosterParts.join(' | ') + '\n';

  const subs = [];
  for (const role of ROLES) {
    for (let i = 1; i < scrims[day][role].length; i++) {
      subs.push(`${scrims[day][role][i]} (${role})`);
    }
  }

  text += `**Remplaçants** : ${subs.length > 0 ? subs.join(', ') : 'Aucun'}`;
  return text;
}

function buildRecapMessage() {
  let text = `## 📋 RÉCAPITULATIF SCRIM — SEMAINE EN COURS\n\n`;

  for (const day of DAYS) {
    const filled   = countFilled(day);
    const complete = isComplete(day);
    const icon     = complete ? '✅' : filled > 0 ? '⚠️' : '❌';

    text += `${icon} **${day.toUpperCase()}** (${filled}/5)\n`;

    if (filled > 0) {
      const parts = ROLES.map(role => {
        const p = scrims[day][role];
        return `${role}: ${p.length > 0 ? p[0] : 'libre'}`;
      });
      text += `${parts.join(' | ')}\n`;
    } else {
      text += `Aucun inscrit\n`;
    }

    text += '\n';
  }

  return text;
}

function buildButtons(day) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`TOP:${day}`).setLabel('TOP').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`JGL:${day}`).setLabel('JGL').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`MID:${day}`).setLabel('MID').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ADC:${day}`).setLabel('ADC').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`SUPP:${day}`).setLabel('SUPP').setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`REMOVE:${day}`).setLabel('Se désinscrire').setStyle(ButtonStyle.Danger)
  );

  return [row1, row2];
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
  const existing  = messages.find(m => m.author.id === client.user.id);

  if (existing) {
    await existing.edit({ content: buildRecapMessage() });
  } else {
    await recapChannel.send({ content: buildRecapMessage() });
  }
}

async function notifyComplete(guild, day) {
  const recapChannel = guild.channels.cache.find(c => c.name === RECAP_CHANNEL);
  if (!recapChannel) return;

  const mentions = ROLES.map(role => {
    const uid = userIds[scrims[day][role][0]];
    return uid ? `<@${uid}>` : scrims[day][role][0];
  }).join(' ');

  await recapChannel.send(
    `🎮 **L'équipe du ${day.toUpperCase()} est complète !**\n${mentions}\nScrim ${day} confirmé ! 🏆`
  );
}

async function notifyIncomplete(guild, day, cancelledUsername) {
  const recapChannel = guild.channels.cache.find(c => c.name === RECAP_CHANNEL);
  if (!recapChannel) return;

  const missingRoles = ROLES.filter(role => scrims[day][role].length === 0);

  const remainingMentions = ROLES
    .filter(role => scrims[day][role].length > 0)
    .map(role => {
      const uid = userIds[scrims[day][role][0]];
      return uid ? `<@${uid}>` : scrims[day][role][0];
    }).join(' ');

  let msg = `⚠️ **Annulation tardive — ${day.toUpperCase()}**\n`;
  msg += `**${cancelledUsername}** s'est désinscrit(e). L'équipe n'est plus complète.\n`;
  msg += `**Poste(s) libre(s)** : ${missingRoles.join(', ')}\n`;
  if (remainingMentions) msg += `${remainingMentions} — un remplaçant est recherché !`;

  await recapChannel.send(msg);
}

async function fullReset(guild) {
  for (const day of DAYS) {
    for (const role of ROLES) {
      scrims[day][role] = [];
    }
  }
  saveState();

  const inviteChannel = await getOrCreateChannel(guild, INVITE_CHANNEL);
  const msgs = await inviteChannel.messages.fetch({ limit: 100 });
  for (const msg of msgs.filter(m => m.author.id === client.user.id).values()) {
    await msg.delete();
  }
  for (const day of DAYS) {
    await inviteChannel.send({ content: buildInviteMessage(day), components: buildButtons(day) });
  }

  const recapChannel  = await getOrCreateChannel(guild, RECAP_CHANNEL);
  const recapMsgs     = await recapChannel.messages.fetch({ limit: 10 });
  const existingRecap = recapMsgs.find(m => m.author.id === client.user.id);
  if (existingRecap) {
    await existingRecap.edit({ content: buildRecapMessage() });
  } else {
    await recapChannel.send({ content: buildRecapMessage() });
  }
}

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {

    if (interaction.commandName === 'setup') {
      await interaction.deferReply({ ephemeral: true });

      const inviteChannel = await getOrCreateChannel(interaction.guild, INVITE_CHANNEL);
      const recapChannel  = await getOrCreateChannel(interaction.guild, RECAP_CHANNEL);

      for (const day of DAYS) {
        await inviteChannel.send({ content: buildInviteMessage(day), components: buildButtons(day) });
      }
      await recapChannel.send({ content: buildRecapMessage() });

      await interaction.editReply(`Salons <#${inviteChannel.id}> et <#${recapChannel.id}> prêts !`);
    }

    if (interaction.commandName === 'resetweek') {
      await interaction.deferReply({ ephemeral: true });
      await fullReset(interaction.guild);

      const inviteChannel = interaction.guild.channels.cache.find(c => c.name === INVITE_CHANNEL);
      const recapChannel  = interaction.guild.channels.cache.find(c => c.name === RECAP_CHANNEL);

      await interaction.editReply(
        `Semaine réinitialisée ! Invitations dans <#${inviteChannel?.id}>, récap dans <#${recapChannel?.id}>.`
      );
    }
  }

  if (interaction.isButton()) {
    try {
      const [action, day] = interaction.customId.split(':');

      if (!day || !DAYS.includes(day)) {
        await interaction.deferUpdate();
        return;
      }

      const username = interaction.user.username;
      const userId   = interaction.user.id;

      userIds[username] = userId;

      const wasComplete = isComplete(day);

      for (const role of ROLES) {
        scrims[day][role] = scrims[day][role].filter(p => p !== username);
      }

      if (action !== 'REMOVE') {
        scrims[day][action].push(username);
      }

      saveState();

      await interaction.update({
        content: buildInviteMessage(day),
        components: buildButtons(day)
      });

      await updateRecap(interaction.guild);

      if (!wasComplete && isComplete(day)) {
        await notifyComplete(interaction.guild, day);
      }

      if (wasComplete && !isComplete(day) && isTodayScrimDay(day)) {
        await notifyIncomplete(interaction.guild, day, username);
      }
    } catch (err) {
      console.error('Erreur interaction bouton:', err.message);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.deferUpdate().catch(() => {});
      }
    }
  }
});

cron.schedule('0 0 * * 1', async () => {
  console.log('Reset automatique de la semaine');
  for (const guild of client.guilds.cache.values()) {
    await fullReset(guild);
  }
});

client.login(TOKEN);
