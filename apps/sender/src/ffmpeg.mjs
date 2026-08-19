/**
 * Helpers do FFmpeg para o Sender.
 *
 * Regras de segurança: o processo é sempre criado com `spawn(bin, args[])` —
 * nunca `exec("ffmpeg " + input)` — e o binário vem de FFMPEG_PATH (que pode
 * incluir args, ex. "node scripts/ffmpeg-shim.mjs") ou do PATH.
 */
import { spawn } from 'node:child_process';
import { ENCODER_ORDER } from './encoders.mjs';

export function ffmpegCommand() {
  const raw = process.env.FFMPEG_PATH || 'ffmpeg';
  return raw.split(/\s+/).filter(Boolean);
}

/** Roda um comando curto e captura a saída. `exit 0` com `must` no stdout = ok. */
export function runProbe(args, { must = null, timeout = 6000 } = {}) {
  return new Promise((resolve) => {
    const [bin, ...prefix] = ffmpegCommand();
    let child;
    try {
      child = spawn(bin, [...prefix, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, out: '', err: '' });
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, out: out.join(''), err: err.join('') });
    }, timeout);
    child.on('error', () => resolve({ ok: false, out: '', err: '' }));
    child.on('exit', (code) => {
      clearTimeout(timer);
      const text = out.join('') + err.join('');
      resolve({ ok: code === 0 && (must ? text.includes(must) : true), out: out.join(''), err: err.join('') });
    });
  });
}

/**
 * Detecta os encoders H.264 disponíveis na ordem de preferência.
 * @returns {Promise<Array<{id:string,name:string,label:string}>>}
 */
export async function detectEncoders() {
  const { ok, out } = await runProbe(['-hide_banner', '-encoders']);
  if (!ok) return [];
  const found = [];
  for (const enc of ENCODER_ORDER) {
    // Linha de encoder H.264: " V....D h264_nvenc NVIDIA NVENC H.264 encoder"
    if (new RegExp(`\\b${enc.name}\\b`).test(out)) found.push(enc);
  }
  return found;
}

// ------------------------------------------------------------------- stats

const STATS_RE = /frame=\s*(\d+)\s+fps=\s*([\d.]+).*?bitrate=\s*([\d.]+)kbits\/s.*?drop=\s*(\d+)/;
const STATS_RE_2 = /frame=\s*(\d+)\s+fps=\s*([\d.]+).*?bitrate=\s*([\d.]+)kbits\/s/;

/** Extrai frame/fps/bitrate/drop de uma linha de stats do ffmpeg. */
export function parseStats(line) {
  const m = line.match(STATS_RE) ?? line.match(STATS_RE_2);
  if (!m) return null;
  return {
    frame: Number(m[1]),
    fps: Number(m[2]),
    bitrate: m[3] !== undefined ? Math.round(Number(m[3]) * 1000) : null,
    drop: m[4] !== undefined ? Number(m[4]) : null,
  };
}

/**
 * Sobe a transmissão ao vivo. `args` completo (captura → encoder → SRT).
 * O stderr é consumido linha a linha: stats viram `onStats`, o resto vira
 * `onLog` (com filtro para não virar torrente).
 */
export function spawnLive(args, { onStats, onLog, onExit }) {
  const [bin, ...prefix] = ffmpegCommand();
  const full = [...prefix, ...args];
  let child;
  try {
    child = spawn(bin, full, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    onExit?.(null, `não deu para iniciar o ffmpeg: ${err.message}`);
    return null;
  }

  let rest = '';
  child.stderr.on('data', (d) => {
    rest += d.toString();
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const stats = parseStats(line);
      if (stats) onStats?.(stats);
      else if (/(error|failed|conversion failed|could not)/i.test(line)) onLog?.(line.trim());
    }
  });
  child.stderr.on('end', () => {
    if (rest.trim()) onLog?.(rest.trim());
  });
  child.on('exit', (code, signal) => onExit?.(code, signal));
  child.on('error', (err) => onLog?.(`[ffmpeg] erro: ${err.message}`));

  return child;
}