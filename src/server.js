import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { JsonStore } from './store.js';
import { convertReversibleSpeed } from './audio.js';
import { RobloxClient } from './roblox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const uploadDir = path.join(root, 'uploads');
const processedDir = path.join(root, 'processed');
const dataFile = path.join(root, 'data', 'state.json');
await Promise.all([fs.mkdir(uploadDir, { recursive: true }), fs.mkdir(processedDir, { recursive: true })]);

const store = new JsonStore(dataFile);
await store.load();
const roblox = new RobloxClient(process.env);

const GENRES = {
  'West Coast': ['The Hood', 'Pop', 'R&B'],
  'Young Stunna': ['Tambay Kalye', 'OPM Daily', 'Sugbo Trip'],
  'Jejemons': [],
  'Casa Floor': ['Dance Pop', 'Rave Mix', 'Disco'],
  'KPOP': ['K-Pop', 'Latin']
};
const PRESETS = [2.1, 2.3, 2.6, 2.7, 2.9];
const FINAL = new Set(['in_map', 'approved', 'accepted', 'declined', 'rejected', 'failed']);
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 200);
const moderationPollMs = Math.max(5, Number(process.env.ROBLOX_MODERATION_POLL_SECONDS || 15)) * 1000;
const upload = multer({ dest: uploadDir, limits: { fileSize: maxUploadMb * 1_000_000, files: 1 } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir, { extensions: ['html'] }));

function constantEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function bearer(req) { return String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); }
function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected || !constantEqual(bearer(req), expected)) return res.status(401).json({ error: 'Admin password required.' });
  next();
}
function gameAuth(req, res, next) {
  const expected = process.env.GAME_SYNC_TOKEN || '';
  const supplied = bearer(req) || req.query.token || '';
  if (!expected || !constantEqual(supplied, expected)) return res.status(401).json({ error: 'Game sync token required.' });
  next();
}
function cleanText(v, max = 80) { return String(v || '').trim().slice(0, max); }
function validGenre(g) { return Object.prototype.hasOwnProperty.call(GENRES, g); }
function inverseSpeed(factor) { return Number((1 / Number(factor)).toFixed(9)); }
function approvedPart(p) { return p?.status === 'approved' || p?.status === 'accepted'; }
function declinedPart(p) { return p?.status === 'declined' || p?.status === 'rejected'; }

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    placeName: process.env.PLACE_NAME || 'Casa Nocturna',
    genres: GENRES,
    presets: PRESETS,
    robloxConfigured: roblox.configured,
    simulation: roblox.simulate,
    gameSyncConfigured: Boolean(process.env.GAME_SYNC_TOKEN),
    moderationGate: true,
    casaUniverseConfigured: Boolean(process.env.CASA_UNIVERSE_ID),
    automaticAssetAccess: true
  });
});

app.get('/api/jobs', adminAuth, (req, res) => res.json({ jobs: store.state.jobs }));
app.get('/api/library', adminAuth, (req, res) => res.json({ songs: store.state.library }));
app.post('/api/jobs/clear', adminAuth, async (req, res) => {
  store.state.jobs = store.state.jobs.filter(j => !FINAL.has(j.stage));
  await store.save();
  res.json({ ok: true });
});

app.patch('/api/library/:id', adminAuth, async (req, res) => {
  const song = store.state.library.find(s => s.id === req.params.id);
  if (!song) return res.status(404).json({ error: 'Song not found.' });
  if (req.body.title != null) song.title = cleanText(req.body.title);
  if (req.body.artist != null) song.artist = cleanText(req.body.artist);
  if (req.body.genre != null && validGenre(req.body.genre)) song.genre = req.body.genre;
  if (req.body.sub != null) song.sub = cleanText(req.body.sub, 60);
  if (req.body.speed != null) {
    const n = Number(req.body.speed);
    if (!Number.isFinite(n) || n <= 0 || n > 2) return res.status(400).json({ error: 'Invalid playback speed.' });
    song.speed = n;
    song.conversionSpeed = Number((1 / n).toFixed(6));
  }
  await store.save();
  res.json({ song });
});

app.delete('/api/library/:id', adminAuth, async (req, res) => {
  const before = store.state.library.length;
  store.state.library = store.state.library.filter(s => s.id !== req.params.id);
  if (before === store.state.library.length) return res.status(404).json({ error: 'Song not found.' });
  await store.save();
  res.json({ ok: true });
});

app.get('/api/game/library', gameAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    version: Date.now(),
    songs: store.state.library.map(s => ({
      id: s.id,
      title: s.title,
      artist: s.artist || '',
      genre: s.genre,
      sub: s.sub || '',
      speed: s.speed,
      conversionSpeed: s.conversionSpeed,
      assetIds: s.assetIds,
      addedAt: s.addedAt
    }))
  });
});

app.post('/api/uploads', adminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an audio/video file.' });
  const title = cleanText(req.body.title) || cleanText(req.file.originalname.replace(/\.[^.]+$/, '')) || 'Untitled';
  const artist = cleanText(req.body.artist) || 'Unknown Artist';
  const conversionSpeed = Number(req.body.conversionSpeed);
  if (!PRESETS.includes(conversionSpeed)) {
    await fs.rm(req.file.path, { force: true });
    return res.status(400).json({ error: 'Unsupported conversion preset.' });
  }
  const genre = validGenre(req.body.genre) ? req.body.genre : Object.keys(GENRES)[0];
  const sub = cleanText(req.body.sub, 60);
  const pushToMap = String(req.body.pushToMap) !== '0';
  const job = {
    id: crypto.randomUUID(), title, artist, genre, sub, conversionSpeed,
    speed: inverseSpeed(conversionSpeed), pushToMap,
    stage: 'processing', parts: [], createdAt: Date.now(), originalName: req.file.originalname,
    moderationGate: true
  };
  store.state.jobs.unshift(job);
  await store.save();
  res.status(202).json({ job });
  processJob(job, req.file.path).catch(async err => {
    job.stage = 'failed'; job.error = err.message || String(err); job.finishedAt = Date.now();
    await store.save();
    await fs.rm(req.file.path, { force: true }).catch(() => {});
  });
});

async function addApprovedJobToLibrary(job) {
  if (!store.state.library.some(s => s.jobId === job.id)) {
    store.state.library.unshift({
      id: crypto.randomUUID(), jobId: job.id,
      title: job.title, artist: job.artist || 'Unknown Artist', genre: job.genre, sub: job.sub,
      conversionSpeed: job.conversionSpeed, speed: job.speed,
      assetIds: job.parts.map(p => p.assetId), addedAt: Date.now(),
      moderationStatus: 'approved',
      accessStatus: 'granted',
      casaUniverseId: String(process.env.CASA_UNIVERSE_ID || '')
    });
  }
}

const activeAccessMonitors = new Set();

async function grantCasaAccess(job) {
  if (!job.pushToMap) return true;

  const universeId = String(process.env.CASA_UNIVERSE_ID || '').trim();
  if (!universeId) {
    job.stage = 'access_required';
    job.error = 'CASA_UNIVERSE_ID is missing on Railway.';
    await store.save();
    return false;
  }

  job.stage = 'granting_access';
  job.error = undefined;
  await store.save();

  try {
    for (const part of job.parts || []) {
      if (!part.assetId || !approvedPart(part)) continue;
      if (part.accessStatus === 'granted') continue;

      const result = await roblox.grantUniverseUsePermission(part.assetId, universeId);
      part.accessStatus = 'granted';
      part.accessGrantedAt = Date.now();
      part.accessHttpStatus = result?.status || 200;
      part.accessError = undefined;
      await store.save();
    }

    const approvedParts = (job.parts || []).filter(approvedPart);
    const allGranted = approvedParts.length > 0 && approvedParts.every(p => p.accessStatus === 'granted');
    if (!allGranted) throw new Error('Not every approved asset received Casa Nocturna access.');

    return true;
  } catch (err) {
    job.stage = 'access_required';
    job.error = err.message || String(err);
    for (const part of job.parts || []) {
      if (approvedPart(part) && part.accessStatus !== 'granted') {
        part.accessStatus = 'failed';
        part.accessError = job.error;
      }
    }
    await store.save();
    return false;
  }
}

async function monitorCasaAccess(job) {
  if (!job?.id || activeAccessMonitors.has(job.id) || !job.pushToMap) return;
  activeAccessMonitors.add(job.id);
  try {
    while (job.stage === 'access_required' || job.stage === 'granting_access') {
      const granted = await grantCasaAccess(job);
      if (granted) {
        await addApprovedJobToLibrary(job);
        job.stage = 'in_map';
        job.finishedAt = Date.now();
        job.error = undefined;
        await store.save();
        return;
      }
      await sleep(30000);
    }
  } finally {
    activeAccessMonitors.delete(job.id);
  }
}

async function finalizeApprovedJob(job) {
  if (job.pushToMap) {
    const granted = await grantCasaAccess(job);
    if (!granted) {
      monitorCasaAccess(job).catch(err => console.error('[Casa access monitor]', err));
      return;
    }
    await addApprovedJobToLibrary(job);
    job.stage = 'in_map';
  } else {
    job.stage = 'approved';
  }
  job.finishedAt = Date.now();
  job.error = undefined;
  await store.save();
}

async function finalizeDeclinedJob(job) {
  job.stage = 'declined';
  job.error = job.parts.find(declinedPart)?.moderationLabel || 'Roblox moderation declined this audio.';
  job.finishedAt = Date.now();
  await store.save();
}

const activeModerationMonitors = new Set();
async function monitorModeration(job) {
  if (!job?.id || activeModerationMonitors.has(job.id) || job.stage !== 'moderating') return;
  activeModerationMonitors.add(job.id);
  try {
    while (job.stage === 'moderating') {
      let allApproved = true;
      let anyDeclined = false;

      for (const part of job.parts || []) {
        if (!part.assetId) { allApproved = false; continue; }
        if (approvedPart(part)) continue;
        if (declinedPart(part)) { anyDeclined = true; allApproved = false; continue; }

        try {
          const result = await roblox.getModerationStatus(part.assetId, part.operationId);
          part.lastModerationCheckAt = Date.now();
          part.moderationSource = result.source;
          part.moderationLabel = result.label;
          if (result.status === 'approved') part.status = 'approved';
          else if (result.status === 'declined') { part.status = 'declined'; anyDeclined = true; }
          else { part.status = 'pending'; allApproved = false; }
        } catch (err) {
          part.status = 'pending';
          part.lastModerationCheckAt = Date.now();
          part.moderationLabel = `Status check failed: ${err.message || String(err)}`;
          allApproved = false;
        }
      }

      job.lastModerationCheckAt = Date.now();
      await store.save();

      if (anyDeclined) {
        await finalizeDeclinedJob(job);
        return;
      }
      if (allApproved && (job.parts || []).length > 0) {
        await finalizeApprovedJob(job);
        return;
      }

      await sleep(moderationPollMs);
    }
  } finally {
    activeModerationMonitors.delete(job.id);
  }
}

let worker = Promise.resolve();
function processJob(job, inputPath) {
  worker = worker.catch(() => {}).then(async () => {
    try {
      job.stage = 'processing'; await store.save();
      const parts = await convertReversibleSpeed({
        input: inputPath, outDir: processedDir, jobId: job.id, factor: job.conversionSpeed,
        ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg', ffprobe: process.env.FFPROBE_BIN || 'ffprobe',
        format: process.env.OUTPUT_FORMAT || 'mp3', bitrate: process.env.OUTPUT_BITRATE || '192k',
        maxPartSeconds: Number(process.env.ROBLOX_MAX_UPLOAD_SECONDS || 360)
      });

      job.stage = 'moderating';
      job.moderationStartedAt = Date.now();
      job.parts = parts.map(p => ({ index: p.index, status: 'pending', duration: p.duration }));
      await store.save();

      for (const part of parts) {
        const result = await roblox.uploadAudio(part.file, job.title, part.index);
        const rec = job.parts.find(p => p.index === part.index);
        rec.assetId = result.assetId;
        rec.operationId = result.operationId || null;
        rec.simulated = Boolean(result.simulated);
        rec.uploadedAt = Date.now();
        rec.moderationLabel = result.moderation?.label || 'Pending review';
        rec.status = result.moderation?.status === 'approved' ? 'approved'
          : result.moderation?.status === 'declined' ? 'declined'
          : 'pending';
        await store.save();
      }

      for (const p of parts) await fs.rm(p.file, { force: true }).catch(() => {});

      if (job.parts.some(declinedPart)) {
        await finalizeDeclinedJob(job);
      } else if (job.parts.every(approvedPart)) {
        await finalizeApprovedJob(job);
      } else {
        // Do not block future conversions while Roblox reviews this asset.
        monitorModeration(job).catch(err => console.error('[moderation monitor]', err));
      }
    } finally {
      await fs.rm(inputPath, { force: true }).catch(() => {});
    }
  });
  return worker;
}

// Resume moderation watches after a Railway restart/redeploy.
for (const job of store.state.jobs) {
  if (job.stage === 'moderating' && (job.parts || []).some(p => p.assetId)) {
    monitorModeration(job).catch(err => console.error('[moderation resume]', err));
  }
  if ((job.stage === 'access_required' || job.stage === 'granting_access') && job.pushToMap) {
    monitorCasaAccess(job).catch(err => console.error('[Casa access resume]', err));
  }
}

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File exceeds ${maxUploadMb} MB.` : err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Casa Nocturna Music Desk listening on http://localhost:${port}`));
