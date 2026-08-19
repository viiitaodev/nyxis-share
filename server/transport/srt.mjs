/**
 * Transporte SRT do lado do servidor.
 *
 * O gateway precisa escutar SRT. Para o vertical slice, um FFmpeg por sessão
 * escuta uma porta UDP dedicada e demuxa para H.264 Annex B no stdout com
 * `-c:v copy` — **sem recodificação**. A interface `SrtTransport` isola essa
 * escolha para a futura migração para `srt-live-server`/`srtla-receiver`, que
 * passariam a entregar o mesmo fluxo sem mexer no resto do gateway.
 *
 * Requisitos de operação:
 *  - ffmpeg nunca vira zombie: o dono do handle chama `kill()` no teardown e
 *    o `exit` é sempre tratado;
 *  - se o processo cair, `exit` notifica para o gateway decidir (respawn
 *    enquanto a sessão estiver ativa);
 *  - a porta é devolvida ao pool no release, mesmo se o processo morrer.
 */

import { spawn } from 'node:child_process';

const RANGE = (process.env.NYXIS_SRT_PORT_RANGE ?? '4001-4016')
  .split('-')
  .map((n) => Number.parseInt(n, 10));
const MIN_PORT = Math.min(...RANGE);
const MAX_PORT = Math.max(...RANGE);

const usedPorts = new Map(); // port -> sessionId
let availableCached = null;

/** Binário do ffmpeg: FFMPEG_PATH (pode conter args, ex. "node scripts/ffmpeg-shim.mjs") ou `ffmpeg` no PATH. */
export function ffmpegCommand() {
  const raw = process.env.FFMPEG_PATH || 'ffmpeg';
  return raw.split(/\s+/).filter(Boolean);
}

export async function ffmpegAvailable() {
  if (availableCached !== null) return availableCached;
  availableCached = await new Promise((resolve) => {
    const [bin, ...args] = ffmpegCommand();
    let child;
    try {
      child = spawn(bin, [...args, '-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(false);
      return;
    }
    const out = [];
    const fail = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(fail, 5000);
    child.stdout.on('data', (d) => out.push(d));
    child.on('error', fail);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.join('').includes('ffmpeg'));
    });
  });
  return availableCached;
}

export function allocSrtPort(sessionId) {
  if (MAX_PORT < MIN_PORT) return null;
  const free = [];
  for (let p = MIN_PORT; p <= MAX_PORT; p++) {
    if (!usedPorts.has(p)) free.push(p);
  }
  if (!free.length) return null;
  const port = free[Math.floor(Math.random() * free.length)];
  usedPorts.set(port, sessionId);
  return port;
}

export function releaseSrtPort(port) {
  usedPorts.delete(port);
}

export function portStats() {
  return { min: MIN_PORT, max: MAX_PORT, used: usedPorts.size, free: MAX_PORT - MIN_PORT + 1 - usedPorts.size };
}

/**
 * Escuta SRT numa porta e entrega H.264 Annex B no stdout.
 *
 * Args fixos garantem o "no transcode": `-map 0:v:0 -c:v copy -f h264 pipe:1`.
 * Qualquer log/erro do ffmpeg vai para `onLog` (stderr), sem jamais imprimir
 * token completo.
 *
 * @param {object} opts
 * @param {number} opts.port
 * @param {(line:string)=>void} [opts.onLog]
 * @param {(chunk:Buffer)=>void} opts.onData    bytes Annex B do stdout
 * @param {(code:number|null, signal:string|null)=>void} opts.onExit
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnSrtListener({ port, onLog, onData, onExit }) {
  const [bin, ...prefix] = ffmpegCommand();
  const url = `srt://0.0.0.0:${port}?mode=listener&pkt_size=1316&latency=150000000&timeout=10000000`;
  const args = [
    ...prefix,
    '-hide_banner',
    '-loglevel', 'info',
    '-nostdin',
    '-i', url,
    '-map', '0:v:0',
    '-c:v', 'copy',
    '-f', 'h264',
    'pipe:1',
  ];

  let child;
  try {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    onExit?.(null, null);
    throw err;
  }

  if (onLog) {
    let rest = '';
    child.stderr.on('data', (d) => {
      rest += d.toString();
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) onLog(line);
      }
    });
    child.stderr.on('end', () => {
      if (rest.trim()) onLog(rest.trim());
    });
  }
  child.stdout.on('data', (d) => onData(d));
  child.on('exit', (code, signal) => onExit?.(code, signal));
  child.on('error', (err) => onLog?.(`[srt-listener] erro ao iniciar: ${err.message}`));

  return child;
}

export function srtListenerUrl(session) {
  const host = process.env.NYXIS_SRT_HOST || 'localhost';
  return {
    protocol: 'srt',
    host,
    port: session.port,
    streamId: session.streamId,
  };
}
