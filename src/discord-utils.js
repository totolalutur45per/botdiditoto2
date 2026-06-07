const {
  ChannelType,
  PermissionsBitField,
  MessageType,
} = require('discord.js');

const state = require('./state');
const scrims = require('./scrims');

let _client = null;

function setDiscordClient(client) {
  _client = client;
}

function getDiscordClient() {
  return _client;
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

async function updateInviteTable(guild) {
  const inviteChannel = guild.channels.cache.find(c => c.name === state.INVITE_CHANNEL);
  if (!inviteChannel) return;

  const msgs = await inviteChannel.messages.fetch({ limit: 100 });
  const opts = { content: scrims.buildInviteContent(), components: scrims.buildInviteButtons() };
  const dispos = msgs.filter(m => m.author.id === _client.user.id && m.content.startsWith('## DISPO'));

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

async function syncGuildChannels(guild) {
  await updateInviteTable(guild);
}

async function confirmScrim(guild, day) {
  const inviteChannel = guild.channels.cache.find(c => c.name === state.INVITE_CHANNEL);
  if (!inviteChannel) return;

  const lineup = state.scrims[day].lineup;
  if (!lineup || !state.ROLES.every(r => lineup[r] != null)) return;

  let text = `🎮 **Composition — ${day.toUpperCase()}**\n`;
  for (const role of state.ROLES) {
    text += `**${role}** : <@${lineup[role]}>\n`;
  }
  const subs = state.scrims[day].substitutes;
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
    for (const role of state.ROLES) {
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

    const riotIds = state.ROLES.map(role => {
      const pid = lineup[role];
      return state.playerProfiles[pid]?.riotId;
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
  for (const day of state.DAYS) {
    state.scrims[day] = {
      available: [],
      lineup: { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null },
      substitutes: []
    };
  }
  await state.saveState();

  const inviteChannel = await getOrCreateChannel(guild, state.INVITE_CHANNEL);
  const msgs = await inviteChannel.messages.fetch({ limit: 100 });
  for (const msg of msgs.filter(m => m.author.id === _client.user.id).values()) {
    await msg.delete();
  }

  await inviteChannel.send({ content: scrims.buildInviteContent(), components: scrims.buildInviteButtons() });
}

async function tryPostConfirmation(guild, day) {
  const s = state.scrims[day];
  if (s.available.length < 5) return;
  if (!scrims.isDayLocked(day)) return;

  await state.saveState();
  await updateInviteTable(guild);
  await confirmScrim(guild, day);
}

async function cleanupOldConfirmations(guild) {
  const channel = guild.channels.cache.find(c => c.name === state.INVITE_CHANNEL);
  if (!channel) return;

  const msgs = await channel.messages.fetch({ limit: 50 });
  for (const msg of msgs.filter(m => m.author.id === _client.user.id).values()) {
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
  state.scrims[day] = {
    available: [],
    lineup: { TOP: null, JGL: null, MID: null, ADC: null, SUPP: null },
    substitutes: []
  };
  await updateInviteTable(guild);
}

module.exports = {
  setDiscordClient,
  getDiscordClient,
  getOrCreateChannel,
  updateInviteTable,
  syncGuildChannels,
  confirmScrim,
  fullReset,
  tryPostConfirmation,
  cleanupOldConfirmations,
  resetDay,
};
