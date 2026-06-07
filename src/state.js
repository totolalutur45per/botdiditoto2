const fs = require('fs/promises');

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

module.exports = {
  get DAYS() { return DAYS; },
  get ROLES() { return ROLES; },
  get INVITE_CHANNEL() { return INVITE_CHANNEL; },
  get STATE_FILE() { return STATE_FILE; },
  get TIMEZONE() { return TIMEZONE; },
  get STATE_VERSION() { return STATE_VERSION; },
  get scrims() { return scrims; },
  get playerProfiles() { return playerProfiles; },
  get displayNames() { return displayNames; },
  get locks() { return locks; },
  Lock,
  loadState,
  saveState,
  playerName,
  hasProfile,
};
