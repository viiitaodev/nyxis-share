#!/usr/bin/env node
/**
 * Nyxis Share Sender — CLI.
 *
 * Transmissão nativa: captura de tela (Windows) → H.264 por hardware → SRT.
 *
 * Uso:
 *   node apps/sender/src/index.mjs --session <token> [--server <url>]
 *   node apps/sender/src/index.mjs --url "nyxisshare://publish?session=..."
 *   node apps/sender/src/index.mjs --probe
 *
 * Opções:
 *   --profile 720p30|720p60|1080p30|1080p60   (padrão: o que a sessão pediu)
 *   --bitrate 10M                             (override; range do perfil é só referência)
 *   --monitor desktop|0|1                     (ddagrab aceita índice de monitor)
 *   --encoder nvenc|amf|qsv|x264              (força um encoder)
 *   --demo                                    (usa testsrc em vez da tela; valida o pipeline)
 *
 * O binário do ffmpeg vem de FFMPEG_PATH (pode incluir args) ou do PATH.
 */

import { spawnLive, detectEncoders, runProbe } from './ffmpeg.mjs';
import { PROFILES, parseBitrate, formatBitrate, gopFor } from './profiles.mjs';
import { encoderArgs, ENCODER_ORDER } from './encoders.mjs';
import { detectCaptureBackend, captureArgs, scaleFilter } from './capture.mjs';
import { buildSrtUrl } from './srt.mjs';
import { resolveSession, stopSession, parseDeepLink, normalizeServer } from './api.mjs';

const args = parseArgs(process.argv.slice(2));

if (args.probe) {
  await probeOnly();
  process.exit(0);
}

// ------------------------------------------------------------ resolução

let token = args.session;
let server = args.server;
if (args.url) {
  const link = parseDeepLink(args.url);
  if (!link) {
    fail('Link inválido. Esperado: nyxisshare://publish?session=...');
  }
  token = link.session;
  server = server ?? link.host ?? null;
}
if (!token) {
  fail(
    'Falta o token da sessão. Abra a atividade, escolha "Alta qualidade" e use o link gerado:\n' +
      '  --session <token>   ou   --url "nyxisshare://publish?session=..."'
  );
}

// ------------------------------------------------------------ banner

console.log('\n  Nyxis Share Sender\n');

// ------------------------------------------------------------ encoders

const available = await detectEncoders();
if (!available.length) {
  fail('Nenhum encoder H.264 encontrado no ffmpeg. Instale um ffmpeg com NVENC/AMF/QSV ou libx264.');
}

let chosen = args.encoder ? ENCODER_ORDER.find((e) => e.id === args.encoder) : null;
if (args.encoder && !available.some((e) => e.id === args.encoder)) {
  fail(`Encoder ${args.encoder} não disponível neste ffmpeg. Encontrados: ${available.map((e) => e.name).join(', ')}`);
}
chosen = chosen ?? available[0];

console.log(`  GPU encoder:  ${chosen.label}`);

// ------------------------------------------------------------ sessão

console.log('  Servidor:     aguardando resolução da sessão…');
const resolved = await resolveSession({ server: server ?? 'http://localhost:3001', token }).catch((err) => {
  fail(`Não deu para resolver a sessão: ${err.message}`);
});
const serverFinal = normalizeServer(server ?? 'http://localhost:3001');

const profileName = args.profile ?? resolved.profile;
const base = PROFILES[profileName];
if (!base) fail(`Perfil desconhecido: ${profileName}`);

let bitrate = args.bitrate !== null ? args.bitrate : base.bitrate;
console.log(
  `  Servidor:     ${serverFinal}\n` +
  `  Sessão:       ${resolved.sessionId}\n` +
  `  Perfil:       ${profileName} (${base.width}x${base.height} @ ${base.fps}fps)\n` +
  `  Bitrate:      ${formatBitrate(bitrate)} (perfil sugere ${formatBitrate(base.min)}–${formatBitrate(base.max)})`
);

// ------------------------------------------------------------ captura

const backend = args.demo ? null : await detectCaptureBackend();
const captureLabel = args.demo ? 'testsrc (demo)' : backend === 'ddagrab' ? 'ddagrab (Desktop Duplication)' : 'gdigrab';
console.log(`  Captura:      ${captureLabel}${args.demo ? '' : ` · ${args.monitor}`}`);

// ------------------------------------------------------------ pipeline

const profile = { ...base, bitrate };
const gop = gopFor(profile.fps);
const srtUrl = buildSrtUrl({
  host: resolved.publish.host,
  port: resolved.publish.port,
  streamId: resolved.publish.streamId,
});

const inputArgs = args.demo
  ? ['-f', 'lavfi', '-i', `testsrc2=size=${profile.width}x${profile.height}:rate=${profile.fps}`]
  : [...captureArgs(backend, { fps: profile.fps, monitor: args.monitor })];

const videoArgs = [
  ...(args.demo ? [] : ['-vf', scaleFilter(profile.width)]),
  ...encoderArgs(chosen.id, profile),
  ...(chosen.id === 'x264' ? ['-pix_fmt', 'yuv420p'] : []),
  '-r', String(profile.fps),
  '-stats_period', '1',
];

const args2 = [
  ...inputArgs,
  ...videoArgs,
  '-f', 'mpegts',
  '-muxdelay', '0.1',
  srtUrl,
];

console.log(`  Transporte:   SRT (${srtUrl})`);
console.log(`  GOP:          ${gop} quadros (~${Math.round(gop / profile.fps)}s entre keyframes)`);

// ------------------------------------------------------------ ao vivo

let exited = false;
let stopping = false;
let sentStop = false;
const startedAt = Date.now();
let lastStats = null;

const finish = async (code, signal) => {
  if (exited) return;
  exited = true;
  if (signal === 'SIGKILL' && stopping) return;
  if (!stopping) {
    try {
      await stopSession({ server: serverFinal, token, sessionId: resolved.sessionId });
    } catch {}
  }
  console.log(`\n  Transmissão encerrada (${code === 0 ? 'fim do fluxo' : `ffmpeg saiu com código ${code}`}).`);
  process.exit(code === 0 ? 0 : 1);
};

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log('\n  Encerrando…');
  try {
    await stopSession({ server: serverFinal, token, sessionId: resolved.sessionId });
    sentStop = true;
  } catch {}
  try {
    child?.kill('SIGTERM');
  } catch {}
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const child = spawnLive(args2, {
  onStats: (s) => {
    lastStats = s;
    const uptime = Math.floor((Date.now() - startedAt) / 1000);
    const mm = String(Math.floor(uptime / 60)).padStart(2, '0');
    const ss = String(uptime % 60).padStart(2, '0');
    const drop = s.drop != null ? ` drop=${s.drop}` : '';
    const bps = s.bitrate != null ? ` bitrate=${formatBitrate(s.bitrate)}` : '';
    const line =
      `  LIVE ${profile.width}x${profile.height} ${profile.fps}fps` +
      ` fps=${s.fps.toFixed(1)}${bps}${drop} tempo=${mm}:${ss}`;
    process.stdout.write('\r\x1b[K' + line);
  },
  onLog: (line) => {
    if (!lastStats) process.stdout.write('\r\x1b[K');
    console.log(`  [ffmpeg] ${line}`);
  },
  onExit: (code, signal) => finish(code, signal),
});

if (!child) process.exit(1);

// ------------------------------------------------------------ helpers

function parseArgs(argv) {
  const out = { bitrate: null, monitor: 'desktop', profile: null, encoder: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--session') out.session = next();
    else if (a === '--url') out.url = next();
    else if (a === '--server') out.server = next();
    else if (a === '--profile') out.profile = next();
    else if (a === '--monitor') out.monitor = next();
    else if (a === '--encoder') out.encoder = next();
    else if (a === '--probe') out.probe = true;
    else if (a === '--demo') out.demo = true;
    else if (a === '--bitrate') {
      const v = parseBitrate(next());
      if (v === null) fail(`Bitrate inválido: ${argv[i]}`);
      out.bitrate = v;
    }
  }
  return out;
}

function fail(msg) {
  console.error(`\n  Erro: ${msg}\n`);
  process.exit(1);
}

async function probeOnly() {
  const available = await detectEncoders();
  const backend = await detectCaptureBackend();
  console.log('\n  Nyxis Share Sender — probe\n');
  console.log('  Encoders H.264 disponíveis:');
  for (const enc of ENCODER_ORDER) {
    const ok = available.some((e) => e.id === enc.id);
    console.log(`    ${ok ? '✅' : '—'} ${enc.label.padEnd(20)} ${enc.name}${ok ? '' : ' (não encontrado)'}`);
  }
  console.log(`\n  Captura: ${backend === 'ddagrab' ? 'ddagrab (Desktop Duplication)' : 'gdigrab'}`);
  console.log('  FFmpeg:', (await runProbe(['-version'])).out.split('\n')[0] || '?');
  console.log('');
}