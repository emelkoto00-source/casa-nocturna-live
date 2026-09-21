import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(stderr) : reject(new Error(`${bin} exited ${code}: ${stderr.slice(-4000)}`)));
  });
}

export async function probeDuration(file, ffprobe = 'ffprobe') {
  const out = await new Promise((resolve, reject) => {
    const p = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    let stdout = '', stderr = '';
    p.stdout.on('data', d => stdout += d.toString());
    p.stderr.on('data', d => stderr += d.toString());
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `ffprobe exited ${code}`)));
  });
  const n = Number(out);
  if (!Number.isFinite(n)) throw new Error('Could not determine audio duration.');
  return n;
}

export async function convertReversibleSpeed({ input, outDir, jobId, factor, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', format = 'mp3', bitrate = '192k', maxPartSeconds = 360 }) {
  await fs.mkdir(outDir, { recursive: true });
  const safeFactor = Number(factor);
  if (![2.1, 2.3, 2.6, 2.7, 2.9].includes(safeFactor)) throw new Error('Unsupported conversion preset.');

  // Resample to a fixed base rate, raise sample rate by factor, then resample back.
  // PlaybackSpeed = 1/factor in Roblox restores the intended rate/pitch approximately.
  const full = path.join(outDir, `${jobId}-converted.${format}`);
  const codecArgs = format === 'ogg' ? ['-c:a', 'libvorbis', '-q:a', '5'] : ['-c:a', 'libmp3lame', '-b:a', bitrate];
  const filter = `aresample=48000,asetrate=${Math.round(48000 * safeFactor)},aresample=48000`;
  await run(ffmpeg, ['-y', '-i', input, '-vn', '-af', filter, ...codecArgs, full]);

  const duration = await probeDuration(full, ffprobe);
  if (duration <= maxPartSeconds) return [{ index: 1, file: full, duration }];

  const pattern = path.join(outDir, `${jobId}-part-%03d.${format}`);
  await run(ffmpeg, ['-y', '-i', full, '-f', 'segment', '-segment_time', String(maxPartSeconds), '-reset_timestamps', '1', '-c', 'copy', pattern]);
  const names = (await fs.readdir(outDir))
    .filter(n => n.startsWith(`${jobId}-part-`) && n.endsWith(`.${format}`))
    .sort();
  const parts = [];
  for (let i = 0; i < names.length; i++) {
    const file = path.join(outDir, names[i]);
    parts.push({ index: i + 1, file, duration: await probeDuration(file, ffprobe) });
  }
  await fs.rm(full, { force: true });
  return parts;
}
