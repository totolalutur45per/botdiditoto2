require('dotenv').config();

const state = require('./src/state');
const { startWebServer } = require('./src/api');
const { startBot, client } = require('./src/bot');
const { setDiscordClient } = require('./src/discord-utils');

async function shutdown() {
  console.log('Arrêt en cours...');
  await state.saveState();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  await state.loadState();
  startWebServer();
  const client = await startBot();
  setDiscordClient(client);
  console.log('Bot prêt et client Discord enregistré.');
})();
