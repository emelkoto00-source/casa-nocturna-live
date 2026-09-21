# Casa Nocturna Music Desk — live build

This turns the approved HTML preview into a deployable Node/Express website. It accepts your own/licensed audio or video file, converts it with one of the 2.1× / 2.3× / 2.6× / 2.7× / 2.9× presets, stores the inverse playback speed, uploads the processed asset through a Roblox Open Cloud adapter, and exposes the resulting library to your Roblox game.

## 1. Configure secrets

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

- `ADMIN_PASSWORD` — protects website admin endpoints.
- `ROBLOX_API_KEY` — your Roblox Open Cloud API key.
- `ROBLOX_CREATOR_TYPE` — `group` or `user`.
- `ROBLOX_CREATOR_ID` — the owning group/user ID.
- `GAME_SYNC_TOKEN` — a different long random secret for the Roblox server.
- `GAME_SYNC_BASE_URL` / `PUBLIC_BASE_URL` — your deployed HTTPS URL.

**Do not put `ROBLOX_API_KEY` in `public/index.html` or a Roblox LocalScript.** It belongs only in the server `.env` / hosting provider secret settings.

## 2. Run locally

```bash
npm install
cp .env.example .env
# For a no-Roblox test, set SIMULATE_ROBLOX=true in .env
npm start
```

Open `http://localhost:3000`, click the connection pill, and enter the `ADMIN_PASSWORD` from `.env`.

## 3. Roblox integration

Copy `roblox/RobloxSync.server.lua` into `ServerScriptService`, set `BASE_URL` and `GAME_SYNC_TOKEN`, and enable **Allow HTTP Requests** in your experience security settings.

`roblox/RuntimePlaylist.module.lua` shows the compatibility layer for the music system you uploaded. The website deliberately publishes each entry with:

```lua
speed = 1 / conversionSpeed
```

For example, 2.3× conversion becomes approximately `0.434783` playback speed.

Your existing music system already uses per-track playback speed, so adapt its playlist source to read these runtime records instead of manually pasting IDs.

## 4. Deploy

The included `Dockerfile` works on Docker-capable hosts. Persist the `/app/data` directory if you want the library and job history to survive redeploys. Also persist nothing under `uploads` or `processed`; those are temporary working files.

Typical production command:

```bash
npm install --omit=dev
npm start
```

The service needs `ffmpeg` and `ffprobe` installed. The Docker image includes both.

## API endpoints

- `GET /api/health` — public status, no secrets.
- `POST /api/uploads` — admin-authenticated multipart upload.
- `GET /api/jobs` — admin queue.
- `POST /api/jobs/clear` — clear finished jobs.
- `GET /api/library` — admin library.
- `PATCH /api/library/:id` — edit metadata/playback speed.
- `DELETE /api/library/:id` — remove from website/game library.
- `GET /api/game/library` — game-sync JSON, protected by `GAME_SYNC_TOKEN`.

## Roblox API compatibility note

This package makes the upload and operation URLs configurable with `ROBLOX_UPLOAD_URL` and `ROBLOX_OPERATION_BASE_URL`. The defaults follow the common Open Cloud Assets API v1 request pattern, but Roblox can change endpoint details, scopes, quotas, and moderation behavior. The website therefore does not expose or hard-code your credential in the frontend, and you can update the adapter settings without redesigning the site.

An asset-creation operation succeeding does **not** guarantee that Roblox will make every audio asset playable immediately; playback can still depend on Roblox moderation, ownership, permissions, and experience configuration.

## Audio behavior

The converter uses resampling to create a faster/higher-pitched copy. The game uses the inverse `PlaybackSpeed` to restore the intended rate approximately. This is intended for music you own or are authorized to upload and is not a guarantee about moderation outcomes.
