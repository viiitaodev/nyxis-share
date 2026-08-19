#!/usr/bin/env node
/**
 * FFmpeg shim — SUBSTITUTO DE TESTE, não para produção.
 *
 * Comporta-se como o ffmpeg o suficiente para validar o pipeline do Sender e
 * do gateway sem depender de um ffmpeg instalado:
 *
 *   -version                → imprime versão falsa, sai 0
 *   -encoders               → lista h264_nvenc/amf/qsv/libx264
 *   -h demuxer=ddagrab      → diz que ddagrab existe
 *   -h encoder=...          → aceita
 *   listener SRT (pipe:1)   → emite um fluxo H.264 Annex B sintético a 30fps
 *                             (SPS/PPS/IDR + deltas), sem nunca sair
 *   qualquer outra coisa    → sai 0
 *
 * Uso (validação local): FFMPEG_PATH="node scripts/ffmpeg-shim.mjs" npm start
 */

const args = process.argv.slice(2);

if (args.includes('-version')) {
  console.log('ffmpeg version 6.0-shim Copyright (c) 2000-2024 the FFmpeg developers');
  process.exit(0);
}

if (args.includes('-encoders')) {
  console.log(' V....D h264_nvenc            NVIDIA NVENC H.264 encoder (codec h264)');
  console.log(' V....D h264_amf              AMD AMF H.264 encoder (codec h264)');
  console.log(' V....D h264_qsv              H.264 (Intel Quick Sync Video) encoder (codec h264)');
  console.log(' V....D libx264               libx264 H.264 / AVC (codec h264)');
  process.exit(0);
}

const demuxerIdx = args.indexOf('demuxer=ddagrab');
if (args.includes('-h') && demuxerIdx !== -1) {
  console.log('ddagrab Demuxer avfoundation AVFoundation indev');
  console.log('    Desktop Duplication');
  process.exit(0);
}

if (args.includes('-h') && args.some((a) => a.startsWith('encoder='))) {
  process.exit(0);
}

// ------------------------------------------------------ listener SRT (gateway)

if (args.includes('pipe:1')) {
  const exitNow = args.includes('--exit-now');
  if (exitNow) process.exit(0);

  const exitAfter = (() => {
    const i = args.indexOf('--exit-after');
    return i === -1 ? null : Number(args[i + 1]);
  })();

  // --- gera um fluxo Annex B sintético (mesma estrutura do h264.test.mjs)
  const u8 = (...vals) => Buffer.from(vals);
  const concat = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const nal = (type, body) => concat(Buffer.from([0, 0, 0, 1, type]), body);

  const sps = Buffer.from([0x64, 0x00, 0x2a, 0xff, 0xe1, 0x00, 0x1f, 0x00, 0x00]);
  const pps = Buffer.from([0xeb, 0x01]);
  const aud = Buffer.from([0x10]);
  const idr = Buffer.from([0x88, 0x84]);
  const delta = Buffer.from([0x41, 0x9a]);

  const keyframe = concat(nal(9, aud), nal(7, sps), nal(8, pps), nal(5, idr));
  const deltaFrame = concat(nal(9, aud), nal(1, delta));

  let frames = 0;
  let statsCount = 0;
  const period = 1000 / 30;

  console.error('shim: listener SRT ativo (sintético, 30fps)');
  const timer = setInterval(() => {
    process.stdout.write(frames++ % 30 === 0 ? keyframe : deltaFrame);
    statsCount++;
    if (exitAfter !== null && statsCount >= exitAfter) {
      clearInterval(timer);
      process.exit(0);
    }
  }, period);

  // Stats periódicos no stderr, como o ffmpeg real.
  const statsTimer = setInterval(() => {
    const sec = Math.floor(frames / 30);
    console.error(
      `frame=${frames} fps=30.0 q=23.0 size=10240kB time=00:00:${String(sec).padStart(2, '0')}.00 bitrate=8000.0kbits/s speed=1x`
    );
  }, 1000);
  statsTimer.unref?.();

  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });

  setTimeout(() => {}, 2147483647); // segura o processo caso o intervalo falhe
} else {
  process.exit(0);
}