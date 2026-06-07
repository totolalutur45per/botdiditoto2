const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const state = require('./state');

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

const ROLE_PERMUTATIONS = permute(state.ROLES);

function evaluateCombo(combo) {
  let bestScore = -1;
  let bestAssignment = null;
  let bestTiebreaker = 0;
  let bestMainRoles = 0;

  for (const roleOrder of ROLE_PERMUTATIONS) {
    let score = 0;
    let tiebreaker = 0;
    let mainRoles = 0;
    for (let i = 0; i < combo.length; i++) {
      const prefs = state.playerProfiles[combo[i]] || {};
      const pref = prefs[roleOrder[i]] || 0;
      score += pref;
      if (pref === 3) {
        mainRoles++;
        tiebreaker += combo.length - i;
      }
    }
    if (score > bestScore || (score === bestScore && tiebreaker > bestTiebreaker)) {
      bestScore = score;
      bestAssignment = roleOrder;
      bestTiebreaker = tiebreaker;
      bestMainRoles = mainRoles;
    }
  }

  return { score: bestScore, assignment: bestAssignment, mainRoles: bestMainRoles };
}

function calculateBestLineup(day) {
  const available = state.scrims[day].available;

  if (available.length < 5) {
    return { lineup: null, substitutes: [] };
  }

  const combinations = generateCombinations(available, 5);
  let bestScore = -1;
  let bestCombination = null;
  let bestAssignment = null;
  let bestMainRoles = 0;

  for (const combo of combinations) {
    const { score, assignment, mainRoles } = evaluateCombo(combo);
    if (score > bestScore || (score === bestScore && mainRoles > bestMainRoles)) {
      bestScore = score;
      bestCombination = combo;
      bestAssignment = assignment;
      bestMainRoles = mainRoles;
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
  const todayIdx = state.DAYS.indexOf(state.DAYS[(jsToday + 6) % 7]);
  const diff = (7 + state.DAYS.indexOf(day) - todayIdx) % 7;
  const d = new Date(now);
  d.setDate(now.getDate() + diff);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function isDayLocked(day) {
  const jsDay = new Date().getDay();
  const today = state.DAYS[(jsDay + 6) % 7];
  const todayIdx = state.DAYS.indexOf(today);
  const targetIdx = state.DAYS.indexOf(day);

  const lineupComplete = state.ROLES.every(r => state.scrims[day].lineup[r] != null);
  if (!lineupComplete) return false;

  if (targetIdx < todayIdx) return true;
  if (targetIdx > todayIdx) return false;

  const now = new Date();
  const time = now.toLocaleString('fr-FR', { timeZone: state.TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = time.split(':').map(Number);
  return h > 5 || (h === 5 && m >= 30);
}

function buildInviteContent() {
  const jsDay = new Date().getDay();
  const todayIdx = (jsDay + 6) % 7;
  const ordered = [...state.DAYS.slice(todayIdx), ...state.DAYS.slice(0, todayIdx)];

  let text = '## DISPO — SCRIM\n';

  for (const day of ordered) {
    const count = state.scrims[day].available.length;
    const lineup = state.scrims[day].lineup;
    const complete = state.ROLES.every(r => lineup[r] != null);
    const date = dayDate(day);

    const inviteSuffix = isDayLocked(day) ? ' 🔒' : ' — 🔓 Inscrivez-vous !';
    text += `\n📅 **${day.toUpperCase()} ${date}**\n👥 **${count}** joueurs inscrits${inviteSuffix}\n`;

    if (complete) {
      const parts = [];
      const scores = [];
      for (const role of state.ROLES) {
        const pid = lineup[role];
        if (pid) {
          const score = state.playerProfiles[pid]?.[role] || 0;
          parts.push(`\`${role}\` ${state.playerName(pid)} **${score}**`);
          scores.push(String(score));
        }
      }
      text += parts.join(' · ') + '\n';

      const subs = state.scrims[day].substitutes;
      if (subs.length > 0) {
        text += `*Sub: ${subs.map(id => state.playerName(id)).join(', ')}*\n`;
      }

      const total = scores.reduce((a, b) => a + Number(b), 0);
      const lineupLabel = !isDayLocked(day) && count >= 5 ? 'Best lineup' : 'Lineup';
      text += `${lineupLabel}: **${total}** (${scores.join('+')})\n`;
    } else if (count > 0) {
      text += state.scrims[day].available.map(id => state.playerName(id)).join(' · ') + '\n';
    }
  }

  return text;
}

function buildInviteButtons() {
  const makeRow = (days) => {
    const row = new ActionRowBuilder();
    for (const day of days) {
      const count = state.scrims[day].available.length;
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

  return [makeRow(state.DAYS.slice(0, 5)), makeRow(state.DAYS.slice(5))];
}

function showPrefModal(userId, day = null) {
  const customId = day ? `PREF_MODAL:${userId}:${day}` : `PREF_MODAL:${userId}`;
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Préférences rôles (0-3 max 1 rôle 3)');

  for (const role of state.ROLES) {
    const current = state.playerProfiles[userId]?.[role] || 1;
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`PREF_${role}`)
          .setLabel(`${role} (0=non, 3=principal, un seul 3)`)
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
        .setValue(state.playerProfiles[userId]?.riotId || '')
        .setRequired(true)
        .setPlaceholder('toto#euw')
    )
  );

  return modal;
}

module.exports = {
  permute,
  evaluateCombo,
  calculateBestLineup,
  generateCombinations,
  dayDate,
  isDayLocked,
  buildInviteContent,
  buildInviteButtons,
  showPrefModal,
  showRiotIdModal,
};
