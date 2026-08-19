/**
 * Pipeline de transmissão rodando num DedicatedWorker (browser V2, captura de
 * jogos).
 *
 * Objetivo: tirar do caminho crítico a main thread (UI, preview, repaint).
 * Quando a aba de captura fica em background porque o usuário voltou ao jogo, o
 * loop de captura, o VideoEncoder, o packaging e o WebSocket do transmissor
 * continuam aqui — sem depender de rAF, timers visuais, repaint da página nem
 * preview.
 *
 * Transferência: a main thread chama getDisplayMedia (permissão + gesto do
 * usuário) e transfere um CLONE do MediaStreamTrack para cá com
 * postMessage(track,[track]). O original fica na main thread (preview/fallback)
 * — falhar aqui nunca destrói a captura escolhida pelo usuário.
 *
 * Handshake explícito (fix do race de init):
 *   main  → { type:'init' }
 *   worker → { type:'initialized' }   (config + socket + encoder prontos)
 *   main  → { type:'track', track }   (clone transferido)
 *   worker → { type:'capture-pumping' } → { type:'first-frame' } → { type:'stream-ready' }
 * O worker TAMBÉM aceita o track antes do init terminar: ele fica pendente e o
 * pump começa assim que o init completa — nunca há corrida entre mensagens.
 *
 * Sem DOM: resize usa OffscreenCanvas (nunca canvas de documento). A lógica de
 * gargalo (bottleneck) e adaptive bitrate são módulos puros compartilhados.
 */

import { contentHintFor } from './broadcast-mode.mjs';
import { createAdaptiveController } from './adaptive.mjs';
import { identifyBottleneck } from './bottleneck.mjs';

const CANDIDATES = [
  { codec: 'avc1.42E01E', avc: { format: 'annexb' } },
  { codec: 'avc1.42E01E' },
  { codec: 'vp8' },
  { codec: 'vp09.00.10.08' },
];

const KEYFRAME_EVERY_MS = 3000;
const TIPO_KEYFRAME = 1;
const TIPO_DELTA = 2;
const TIPO_AUDIO = 3;
const AUDIO_BITRATE = 96_000;
const MAX_W = 1920;
const MAX_H = 1080;
const DROP_QUEUE_THRESHOLD = 3;
const MIN_BITRATE = 500_000;

let DEBUG_PROBING = false; // debug só via mensagem 'init' para não depender de process

const even = (n) => Math.max(2, n - (n % 2));
const fitWithin = (w, h, limitH = MAX_H) => {
  const scale = Math.min(1, MAX_W / w, limitH / h);
  return { width: even(Math.round(w * scale)), height: even(Math.round(h * scale)) };
};

let ws = null;
let encoder = null;
let audioEncoder = null;
let reader = null;
let audioReader = null;
let videoTrack = null;
let config = null;
let stage = null; // OffscreenCanvas quando há resize
let stageCtx = null;

let hint = null;
let mode = 'auto';
let running = false;
let initDone = false;
let ended = false;
let serverStarted = false;
let firstFrameSubmitted = false;
let pendingTrack = null;
let pendingAudioTrack = null;
let mySlot = 0;
let wantKeyframe = true;
let lastKeyframeAt = 0;
let srcW = 0;
let srcH = 0;
let startedAt = 0;
let bytes = 0;
let frames = 0;
let viewers = 0;
let statsTimer = null;
let fps = 60;
let bitrate = 8_000_000;

let somBloqueado = false;

const t = {
  capturePath: null,
  transport: 'WebSocket',
  hardwareAcceleration: 'requested',
  probing: [],
  probingSummary: null,
  displaySurface: null,
  trackReportedFps: null,
  captureWidth: null,
  captureHeight: null,
  contentHintReal: null,
  documentVisibility: null,
  previewActive: false,
  workerPipeline: true,
  captureFrameIntervalMs: null,
};

let tel = { captured: 0, submitted: 0, encoded: 0, dropped: 0, keyframes: 0 };
let windowStartAt = 0;
let feedback = null;
let lastTelemetry = null;

const adaptive = createAdaptiveController({
  initialBitrate: bitrate,
  onApply: applyBitrate,
  onChange: (msg) => post({ type: 'aviso', msg }),
});

function post(obj) {
  self.postMessage(obj);
}

function emitStatus() {
  post({
    type: 'status',
    status: {
      codec: config?.codec,
      width: config?.width,
      height: config?.height,
      direct: t.capturePath === 'direct',
      mode,
      hint: hint ?? 'none',
      hintReal: t.contentHintReal ?? 'none',
      hardwareAcceleration: t.hardwareAcceleration ?? 'requested',
      transport: t.transport,
      displaySurface: t.displaySurface,
      trackReportedFps: t.trackReportedFps,
      documentVisibility: t.documentVisibility,
      previewActive: t.previewActive,
      workerPipeline: true,
      hasAudio: Boolean(audioEncoder),
    },
  });
}

// ------------------------------------------------------------------- init

async function init({ wsUrl, bitrate: br, fps: f, audio, mode: m, contentHint, debugProbing }) {
  bitrate = br;
  fps = f;
  mode = m;
  hint = contentHint || contentHintFor(mode);
  if (debugProbing) DEBUG_PROBING = true;
  adaptive.reset(bitrate);

  // Captura já adquirida na main thread (gesto/permissão). Aqui só se prepara o
  // caminho de áudio se pedido e o encoder, e conecta o socket.
  config = await pickConfig(MAX_W, MAX_H);
  if (!config) {
    post({ type: 'end', reason: 'Nenhum codec de vídeo suportado por este navegador.' });
    return;
  }

  await connect(wsUrl);

  encoder = new VideoEncoder({
    output: onEncoded,
    error: (err) => stop(`Erro no encoder: ${err.message}`),
  });
  encoder.configure(config);

  t.capturePath = 'direct';
  t.hardwareAcceleration = config.hardwareAcceleration ?? 'requested';

  emitStatus();
  initDone = true;
  post({ type: 'initialized' });

  // Track/áudio que chegaram enquanto o init ainda rodava: a partir daqui o
  // pipeline arranca — sem corrida entre mensagens.
  if (pendingTrack) {
    const tr = pendingTrack;
    pendingTrack = null;
    setVideoTrack(tr);
  }
  if (pendingAudioTrack) {
    const a = pendingAudioTrack;
    pendingAudioTrack = null;
    setAudioTrack(a);
  }
}

// ------------------------------------------------------------------ capture

function setVideoTrack(track) {
  videoTrack = track;
  const s = track.getSettings();
  t.displaySurface = s.displaySurface ?? null;
  t.trackReportedFps = s.frameRate ?? null;
  t.captureWidth = s.width ?? null;
  t.captureHeight = s.height ?? null;
  if (hint) track.contentHint = hint;
  t.contentHintReal = track.contentHint ?? null;

  const target = fitWithin(s.width ?? 1280, s.height ?? 720);
  config = { ...config, ...target };
  if (encoder?.state === 'configured') {
    encoder.configure(config);
    wantKeyframe = true;
  }

  track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));

  // Chegou antes do init terminar: guarda e o init arranca depois (handshake).
  if (!initDone) {
    pendingTrack = track;
    return;
  }

  // Troca de tela no ar: a leitura anterior morre e recomeça da fonte nova.
  if (running && reader) {
    reader.cancel().catch(() => {});
    reader = null;
    srcW = 0;
    srcH = 0;
    wantKeyframe = true;
  }
  startPump();
}

function startPump() {
  if (!videoTrack) return;

  if (!running) {
    running = true;
    wantKeyframe = true;
    lastKeyframeAt = 0;
    startedAt = Date.now();
    tel = { captured: 0, submitted: 0, encoded: 0, dropped: 0, keyframes: 0 };
    windowStartAt = performance.now();
    statsTimer = setInterval(tickStats, 1000);
  }

  try {
    reader = new MediaStreamTrackProcessor({ track: videoTrack }).readable.getReader();
  } catch (err) {
    stop(`Falha ao ler a captura: ${err.message}`);
    return;
  }
  post({ type: 'capture-pumping' });
  pumpLoop();
  if (pendingAudioTrack) {
    const a = pendingAudioTrack;
    pendingAudioTrack = null;
    setAudioTrack(a);
  }
  emitStatus();
}

function tickStats() {
  const nowPerf = performance.now();
  const dt = (nowPerf - windowStartAt) / 1000;
  const now = Date.now();
  const actualMbps = (bytes * 8) / 1e6;
  const sample = {
    viewers,
    captureFps: dt > 0 ? Math.round(tel.captured / dt) : 0,
    submittedFps: dt > 0 ? Math.round(tel.submitted / dt) : 0,
    encodedFps: dt > 0 ? Math.round(tel.encoded / dt) : 0,
    encoderQueueSize: encoder?.encodeQueueSize ?? 0,
    droppedBeforeEncode: tel.dropped,
    actualMbps: Number(actualMbps.toFixed(2)),
    targetBitrate: adaptive.initialBitrate,
    currentBitrate: adaptive.currentBitrate,
    targetFps: fps,
    codec: config.codec,
    resolution: `${config.width}x${config.height}`,
    contentHint: t.contentHintReal ?? hint ?? 'none',
    hardwareAcceleration: t.hardwareAcceleration,
    bufferedAmount: ws?.bufferedAmount ?? 0,
    transport: t.transport,
    keyframes: tel.keyframes,
    mode,
    seconds: Math.floor((now - startedAt) / 1000),
    feedback,
    probingSummary: t.probingSummary,
    displaySurface: t.displaySurface,
    trackReportedFps: t.trackReportedFps,
    captureWidth: t.captureWidth,
    captureHeight: t.captureHeight,
    documentVisibility: t.documentVisibility,
    previewActive: t.previewActive,
    workerPipeline: true,
    captureFrameIntervalMs: t.captureFrameIntervalMs,
  };
  sample.bottleneck = identifyBottleneck(sample, config?.framerate ?? fps);
  if (bottleneckIsCaptureStarved(sample, config?.framerate ?? fps)) {
    sample.bottleneck = 'CAPTURE STARVED';
  }
  lastTelemetry = sample;
  post({ type: 'stats', stats: sample });
  adaptive.onTick(sample);

  tel.captured = 0;
  tel.submitted = 0;
  tel.encoded = 0;
  tel.dropped = 0;
  tel.keyframes = 0;
  bytes = 0;
  frames = 0;
  windowStartAt = nowPerf;
}

async function pumpLoop() {
  while (running) {
    let frame;
    try {
      const { done, value } = await reader.read();
      if (done) break;
      frame = value;
    } catch {
      break;
    }
    if (!encodeFrame(frame)) break;
  }
}

function encodeFrame(frame) {
  if (!running || encoder?.state !== 'configured') {
    frame.close();
    return false;
  }
  tel.captured++;

  const q = encoder.encodeQueueSize;
  if (q >= DROP_QUEUE_THRESHOLD) {
    frame.close();
    tel.dropped++;
    adaptive.onPressure('encode-queue', q);
    return true;
  }

  const timestamp = frame.timestamp ?? performance.now() * 1000;
  syncSize(frame);

  const now = Date.now();
  if (now - lastKeyframeAt > KEYFRAME_EVERY_MS) wantKeyframe = true;

  let out = frame;
  if (stage) {
    stageCtx.drawImage(frame, 0, 0, stage.width, stage.height);
    frame.close();
    out = new VideoFrame(stage, { timestamp });
  }

  if (!firstFrameSubmitted) {
    firstFrameSubmitted = true;
    post({ type: 'first-frame' });
  }

  tel.submitted++;
  try {
    encoder.encode(out, { keyFrame: wantKeyframe });
    if (wantKeyframe) {
      tel.keyframes++;
      lastKeyframeAt = now;
      wantKeyframe = false;
    }
  } catch (err) {
    console.error('[encode]', err);
  }

  out.close();
  frames++;

  if (q >= 2) adaptive.onPressure('encode-queue', q);
  return true;
}

function applyBitrate(novoBitrate) {
  if (encoder?.state !== 'configured') return;
  config = { ...config, bitrate: novoBitrate };
  encoder.configure(config);
  wantKeyframe = true;
}

function bottleneckIsCaptureStarved(sample, targetFps = 60) {
  const target = targetFps || 60;
  if (sample.captureFps <= 0) return false;
  if (sample.captureFps >= target) return false;
  if (sample.captureFps !== sample.submittedFps) return false;
  if (sample.captureFps !== sample.encodedFps) return false;
  if (sample.encoderQueueSize >= 2) return false;
  if (sample.droppedBeforeEncode > 0) return false;
  return true;
}

function syncSize(frame) {
  const sw = frame.displayWidth;
  const sh = frame.displayHeight;
  if (!sw || !sh || (sw === srcW && sh === srcH)) return;

  srcW = sw;
  srcH = sh;
  const target = fitWithin(sw, sh);

  if (target.width !== config.width || target.height !== config.height) {
    config = { ...config, ...target };
    encoder.configure(config);
    wantKeyframe = true;
    emitStatus();
  }

  if (target.width === sw && target.height === sh) {
    stage = null;
    stageCtx = null;
  } else {
    // OffscreenCanvas: sem DOM no worker, sem custo de repaint da página.
    stage = new OffscreenCanvas(target.width, target.height);
    stageCtx = stage.getContext('2d', { alpha: false, desynchronized: true });
  }
  t.captureFrameIntervalMs = 1000 / fps;
}

function onEncoded(chunk, metadata) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  tel.encoded++;

  // Bug 3: o servidor só recebe 'start' quando existe pipeline utilizável —
  // primeiro o decoderConfig real, depois o anúncio. Nada de "no ar" sem mídia.
  if (metadata?.decoderConfig) {
    ws.send(JSON.stringify({ type: 'config', config: serializeConfig(metadata.decoderConfig) }));
    if (!serverStarted) {
      serverStarted = true;
      ws.send(JSON.stringify({ type: 'start' }));
      post({ type: 'stream-ready' });
    }
  }

  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  const buf = empacotar(
    chunk.type === 'key' ? TIPO_KEYFRAME : TIPO_DELTA,
    chunk.timestamp ?? 0,
    data
  );
  ws.send(buf);
  bytes += buf.byteLength;
}

function empacotar(tipo, timestamp, data) {
  const buf = new ArrayBuffer(18 + data.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, mySlot);
  view.setUint8(1, tipo);
  view.setFloat64(2, timestamp);
  view.setFloat64(10, Date.now());
  new Uint8Array(buf, 18).set(data);
  return buf;
}

function serializeConfig(dc) {
  const out = { codec: dc.codec, codedWidth: dc.codedWidth, codedHeight: dc.codedHeight };
  if (dc.description) {
    const b = new Uint8Array(
      dc.description instanceof ArrayBuffer ? dc.description : dc.description.buffer
    );
    let bin = '';
    for (const x of b) bin += String.fromCharCode(x);
    out.description = btoa(bin);
  }
  return out;
}

// ------------------------------------------------------------------ audio

function setAudioTrack(track) {
  if (!track) return;
  if (!running) {
    pendingAudioTrack = track;
    return;
  }
  configureAudio(track);
  pumpAudioLoop();
}

function configureAudio(track) {
  const s = track.getSettings();
  const sampleRate = s.sampleRate || 48_000;
  const numberOfChannels = Math.min(2, s.channelCount || 2);
  try {
    audioEncoder = new AudioEncoder({
      output: onAudioEncoded,
      error: (err) => console.warn('[audio encoder]', err.message),
    });
    audioEncoder.configure({ codec: 'opus', sampleRate, numberOfChannels, bitrate: AUDIO_BITRATE });
  } catch (err) {
    console.warn('[audio encoder]', err.message);
    audioEncoder = null;
    return;
  }
  ws?.send(
    JSON.stringify({ type: 'audio-config', config: { codec: 'opus', sampleRate, numberOfChannels } })
  );
  audioReader = new MediaStreamTrackProcessor({ track }).readable.getReader();
}

async function pumpAudioLoop() {
  while (running) {
    let dados;
    try {
      const { done, value } = await audioReader.read();
      if (done) break;
      dados = value;
    } catch {
      break;
    }
    if (audioEncoder?.state === 'configured') {
      try {
        audioEncoder.encode(dados);
      } catch (err) {
        console.warn('[audio encode]', err.message);
      }
    }
    dados.close();
  }
}

function onAudioEncoded(chunk) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  ws.send(empacotar(TIPO_AUDIO, chunk.timestamp ?? 0, data));
  bytes += 18 + data.byteLength;
}

function setSomBloqueado(v) {
  somBloqueado = v;
}

// ----------------------------------------------------------------- websocket

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Não foi possível falar com o servidor (timeout).'));
    }, 10_000);

    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') return;
      const msg = JSON.parse(e.data);
      if (msg.type === 'slot') mySlot = msg.slot;
      else if (msg.type === 'state') viewers = msg.viewers;
      else if (msg.type === 'need-keyframe') wantKeyframe = true;
      else if (msg.type === 'viewer-health') feedback = msg.health ?? null;
      else if (msg.type === 'stop-request') stop('Transmissão encerrada pela atividade.');
      else if (msg.type === 'error') {
        if (running) stop(msg.message);
        else {
          clearTimeout(timeout);
          reject(new Error(msg.message));
        }
      }
    });

    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('Falha ao conectar no servidor.'));
    });

    ws.addEventListener('close', () => {
      clearTimeout(timeout);
      if (running) stop('Conexão com o servidor caiu.');
    });
  });
}

// ------------------------------------------------------------ mudanças

function setQuality({ bitrate: nextBitrate, fps: nextFps } = {}) {
  if (nextBitrate) {
    bitrate = nextBitrate;
    adaptive.reset(nextBitrate);
  }
  if (nextFps) fps = nextFps;
  if (encoder?.state !== 'configured') return;
  config = { ...config, bitrate: adaptive.currentBitrate, framerate: fps };
  encoder.configure(config);
  wantKeyframe = true;
  videoTrack
    ?.applyConstraints({ frameRate: { ideal: fps, max: fps } })
    .catch(() => {});
}

function swapAudio(track) {
  audioReader?.cancel().catch(() => {});
  audioReader = null;
  if (audioEncoder?.state === 'configured') {
    try {
      audioEncoder.close();
    } catch {}
  }
  audioEncoder = null;
  somBloqueado = false;
  setAudioTrack(track);
}

function stop(reason) {
  const wasRunning = running;
  running = false;

  clearInterval(statsTimer);
  statsTimer = null;

  reader?.cancel().catch(() => {});
  reader = null;
  audioReader?.cancel().catch(() => {});
  audioReader = null;

  for (const e of [encoder, audioEncoder]) {
    if (e?.state === 'configured') {
      try {
        e.close();
      } catch {}
    }
  }
  encoder = null;
  audioEncoder = null;

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }));
    ws.close();
  }
  ws = null;

  // Sempre avisa o fim (mesmo antes de 'running'): quem estiver aguardando
  // 'initialized'/'stream-ready' precisa sair do await.
  if (!ended) {
    ended = true;
    post({ type: 'end', reason: reason ?? '' });
  }
}

// ----------------------------------------------------------- message in

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'init':
      try {
        await init(msg);
      } catch (err) {
        post({ type: 'end', reason: err?.message ?? String(err) });
      }
      break;
    case 'track':
      setVideoTrack(msg.track);
      break;
    case 'probe':
      // Teste de transferibilidade: a main envia um track descartável (canvas).
      // Se ele chegar utilizável (live), o navegador suporta transferir track.
      if (msg.track?.readyState === 'live') {
        try {
          msg.track.getSettings();
          post({ type: 'probe-ok' });
        } catch {
          post({ type: 'probe-fail' });
        }
      } else {
        post({ type: 'probe-fail' });
      }
      break;
    case 'audioTrack':
      if (msg.somBloqueado) setSomBloqueado(true);
      setAudioTrack(msg.track);
      break;
    case 'setQuality':
      setQuality(msg);
      break;
    case 'previewState':
      if (typeof msg.previewActive === 'boolean') t.previewActive = msg.previewActive;
      if (typeof msg.visibility === 'string') t.documentVisibility = msg.visibility;
      break;
    case 'swapAudio':
      swapAudio(msg.track);
      break;
    case 'stop':
      stop(msg.reason);
      break;
  }
};

// ------------------------------------------------------------------ probing

async function pickConfig(width, height) {
  const variantes = [];
  for (const hw of ['prefer-hardware', undefined]) {
    for (const realtime of [true, false]) {
      for (const candidate of CANDIDATES) {
        const cfg = { ...candidate, width, height, bitrate, framerate: fps };
        if (hw) cfg.hardwareAcceleration = hw;
        if (realtime) cfg.latencyMode = 'realtime';
        variantes.push(cfg);
      }
    }
  }
  for (const candidate of CANDIDATES) {
    variantes.push({ ...candidate, width, height, bitrate, framerate: fps });
  }

  const probeLog = [];
  t.probing = [];

  for (const cfg of variantes) {
    let supported = false;
    let reason = null;
    try {
      ({ supported } = await VideoEncoder.isConfigSupported(cfg));
    } catch (err) {
      supported = false;
      reason = err?.message ?? String(err);
    }
    const format = cfg.codec.startsWith('avc') ? (cfg.avc?.format ?? 'AVC') : '';
    const hw = cfg.hardwareAcceleration ? '+prefer-hardware' : '+auto';
    const rt = cfg.latencyMode ? '+realtime' : '';
    const rotulo = `${cfg.codec}${format ? ' ' + format : ''}${hw}${rt}`;
    probeLog.push(`${rotulo}: ${supported ? 'SUPPORTED' : reason ? `ERROR(${reason})` : 'UNSUPPORTED'}`);
    t.probing.push({ codec: cfg.codec, format: format || null, hw: cfg.hardwareAcceleration, realtime: Boolean(cfg.latencyMode), supported, reason });
    if (DEBUG_PROBING) console.log('[probe]', rotulo, supported ? 'SUPPORTED' : reason ? `ERROR(${reason})` : 'UNSUPPORTED');
    if (supported) {
      if (DEBUG_PROBING) console.log('[probe] escolhido:', rotulo);
      t.probingSummary = probeLog.join(' | ');
      return cfg;
    }
  }
  t.probingSummary = probeLog.join(' | ');
  return null;
}