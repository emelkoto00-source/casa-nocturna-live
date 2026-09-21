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
const FINAL = new Set(['in_map', 'accepted', 'rejected', 'failed']);
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 200);
const upload = multer({ dest: uploadDir, limits: { fileSize: maxUploadMb * 1_000_000, files: 1 } });

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

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    placeName: process.env.PLACE_NAME || 'Casa Nocturna',
    genres: GENRES,
    presets: PRESETS,
    robloxConfigured: roblox.configured,
    simulation: roblox.simulate,
    gameSyncConfigured: Boolean(process.env.GAME_SYNC_TOKEN)
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
  const conversionSpeed = Number(req.body.conversionSpeed);
  if (!PRESETS.includes(conversionSpeed)) {
    await fs.rm(req.file.path, { force: true });
    return res.status(400).json({ error: 'Unsupported conversion preset.' });
  }
  const genre = validGenre(req.body.genre) ? req.body.genre : Object.keys(GENRES)[0];
  const sub = cleanText(req.body.sub, 60);
  const pushToMap = String(req.body.pushToMap) !== '0';
  const job = {
    id: crypto.randomUUID(), title, genre, sub, conversionSpeed,
    speed: inverseSpeed(conversionSpeed), pushToMap,
    stage: 'processing', parts: [], createdAt: Date.now(), originalName: req.file.originalname
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
      job.parts = parts.map(p => ({ index: p.index, status: 'pending', duration: p.duration }));
      await store.save();

      for (const part of parts) {
        const result = await roblox.uploadAudio(part.file, job.title, part.index);
        const rec = job.parts.find(p => p.index === part.index);
        rec.assetId = result.assetId;
        rec.status = 'accepted'; // Asset creation operation succeeded. Content playback can still depend on Roblox moderation/permissions.
        rec.simulated = Boolean(result.simulated);
        await store.save();
      }

      job.stage = job.pushToMap ? 'in_map' : 'accepted';
      job.finishedAt = Date.now();
      if (job.pushToMap) {
        store.state.library.unshift({
          id: crypto.randomUUID(), title: job.title, genre: job.genre, sub: job.sub,
          conversionSpeed: job.conversionSpeed, speed: job.speed,
          assetIds: job.parts.map(p => p.assetId), addedAt: Date.now()
        });
      }
      await store.save();
      for (const p of parts) await fs.rm(p.file, { force: true }).catch(() => {});
    } finally {
      await fs.rm(inputPath, { force: true }).catch(() => {});
    }
  });
  return worker;
}

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File exceeds ${maxUploadMb} MB.` : err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Casa Nocturna Music Desk listening on http://localhost:${port}`));
