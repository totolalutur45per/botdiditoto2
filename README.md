# Bot Scrim Manager

Discord bot for managing scrim lineups with role preferences. Includes a web dashboard for managing player preferences and viewing scrim status.

## Setup

```bash
npm install
cd web && npm install && cd ..
```

Copy `.env` and fill in your Discord credentials:

```bash
cp .env.example .env
# Edit .env with your values
```

## Local Development

The dashboard connects directly to the Railway-hosted API. No need to run the bot locally.

1. Set your Railway URL in `web/.env.development`:
   ```
   API_URL=https://your-railway-app.up.railway.app
   ```

2. Start the React dev server:
   ```bash
   cd web && npm run dev
   ```

Opens at http://localhost:5173, proxying API calls to Railway.

> **Do not run `npm start` locally with the same Discord token as Railway.** The local bot will overwrite the Discord channel with empty state.

## Production Build

```bash
npm run build
npm start
```

Builds the React app to `web/dist/` and serves it from the Express server.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DISCORD_TOKEN` | Discord bot token | Required |
| `DISCORD_CLIENT_ID` | Discord application client ID | Required |
| `STATE_FILE` | Path to state JSON file | `./scrims-state.json` |
| `PORT_WEB` | Web dashboard/API port | `3001` |

| Variable (web/) | Description | Default |
|---|---|---|
| `API_URL` | Railway API URL for dev proxy | `http://localhost:3001` |

## Railway Deployment

Set `npm run build` as the build command and `node index.js` as the start command. Set `STATE_FILE=/data/scrims-state.json` as a Railway env var. Mount a persistent volume at `/data/`.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/players` | List all players with role preferences |
| PUT | `/api/players/:id` | Update a player's role preferences |
| GET | `/api/scrims` | Get scrim state for all days |
