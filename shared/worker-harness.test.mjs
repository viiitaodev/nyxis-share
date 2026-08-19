/**
 * Testes do worker real (broadcast-worker.mjs) rodando em Node com fakes.
 *
 * Rode com: node shared/worker-harness.test.mjs
 *
 * Cobre os bugs da regressão pós-DedicatedWorker:
 * 1. track chega ANTES do init terminar → pump começa depois e produz frames.
 * 2. init termina ANTES do track → pump começa quando o track chega.
 * 3. o servidor só recebe 'start' DEPOIS do primeiro config (nada de "no ar" sem mídia).
 * 4. probe responde ok/fail conforme a transferibilidade.
 * 5. áudio é configurado quando chega (mesmo antes do start do servidor).
 *
 * O módulo do worker usa `self` e as APIs de WebCodecs/WebSocket; o teste
 * fornece fakes globais ANTES do import dinâmico. Cada caso importa uma
 * instância nova do módulo (com query na URL) para o estado do worker não
 * vazar de um caso para o outro.
 */

const messages = [];
const wsSent = [];
let wsOpenDelayMs = 0;
let fakeFrames = [];
let encodes = 0;

// --------------------------------------------------------------- fakes globais

globalThis.self = globalThis;
globalThis.postMessage = (obj) => messages.push(obj);
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.listeners = {};
    this._openTimer = setTimeout(() => this.open(), wsOpenDelayMs);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data) {
    wsSent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }
  close() {
    clearTimeout(this._openTimer);
    this.readyState = 3;
    this.emit('close');
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }
  emit(type, evt) {
    (this.listeners[type] ?? []).forEach((fn) => fn(evt ?? { data: '' }));
  }
}
globalThis.WebSocket = FakeWebSocket;

class FakeVideoEncoder {
  static async isConfigSupported() {
    return { supported: true };
  }
  constructor({ output, error }) {
    this.output = output;
    this.error = error;
    this.state = 'unconfigured';
    this.encodeQueueSize = 0;
  }
  configure(cfg) {
    this.state = 'configured';
    this.config = cfg;
  }
  encode(frame, opts) {
    encodes++;
    const chunk = {
      type: opts?.keyFrame ? 'key' : 'delta',
      timestamp: frame.timestamp ?? 0,
      byteLength: 120,
      copyTo(arr) {
        new Uint8Array(arr.buffer, 0, 120).fill(9);
      },
    };
    const metadata = {
      decoderConfig: {
        codec: this.config.codec,
        codedWidth: this.config.width,
        codedHeight: this.config.height,
      },
    };
    this.output(chunk, metadata);
  }
  close() {
    if (this.state !== 'closed') this.state = 'closed';
  }
}
globalThis.VideoEncoder = FakeVideoEncoder;

class FakeAudioEncoder {
  constructor({ output, error }) {
    this.output = output;
    this.error = error;
    this.state = 'unconfigured';
  }
  configure(cfg) {
    this.state = 'configured';
    this.config = cfg;
  }
  encode() {
    const chunk = {
      timestamp: 0,
      byteLength: 40,
      copyTo(arr) {
        new Uint8Array(arr.buffer, 0, 40).fill(3);
      },
    };
    this.output(chunk);
  }
  close() {
    if (this.state !== 'closed') this.state = 'closed';
  }
}
globalThis.AudioEncoder = FakeAudioEncoder;

class FakeOffscreenCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    return { drawImage() {} };
  }
}
globalThis.OffscreenCanvas = FakeOffscreenCanvas;

globalThis.VideoFrame = class {
  constructor(src, opts = {}) {
    this.timestamp = opts.timestamp ?? 0;
    this.displayWidth = src?.width ?? 1920;
    this.displayHeight = src?.height ?? 1080;
  }
  close() {}
};

function makeReader(frames) {
  let i = 0;
  return {
    read: async () =>
      i < frames.length ? { done: false, value: frames[i++] } : { done: true, value: undefined },
    cancel: async () => {},
    releaseLock: () => {},
  };
}

globalThis.MediaStreamTrackProcessor = class {
  constructor({ track }) {
    this.track = track;
    this.readable = { getReader: () => makeReader(fakeFrames) };
  }
};

// --------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msgsOf = (type) => messages.filter((m) => m.type === type);

function fakeTrack() {
  return {
    readyState: 'live',
    contentHint: null,
    getSettings: () => ({
      displaySurface: 'window',
      frameRate: 60,
      width: 1920,
      height: 1080,
      sampleRate: 48000,
      channelCount: 2,
    }),
    addEventListener: () => {},
    applyConstraints: async () => {},
    stop() {
      this.readyState = 'ended';
    },
  };
}

function makeFrames(n) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push({ displayWidth: 1920, displayHeight: 1080, timestamp: i + 1, close() {} });
  }
  return arr;
}

function reset() {
  messages.length = 0;
  wsSent.length = 0;
  encodes = 0;
  fakeFrames = makeFrames(3);
  wsOpenDelayMs = 0;
}

// Instância nova do worker por caso: o estado do módulo não pode vazar entre
// casos (initDone/serverStarted/running são variáveis do módulo).
let caseId = 0;
async function freshHandler() {
  caseId++;
  await import(`./broadcast-worker.mjs?case=${caseId}`);
  return globalThis.onmessage;
}

const INIT_MSG = {
  type: 'init',
  wsUrl: 'ws://fake',
  bitrate: 8_000_000,
  fps: 60,
  audio: false,
  mode: 'auto',
  contentHint: null,
  debugProbing: false,
};

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FALHOU'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

// --------------------------------------------------------------- teste 1
// track chega ANTES do init terminar (race) → pump começa depois e produz frames.

{
  reset();
  wsOpenDelayMs = 40;
  const onmessage = await freshHandler();
  const initPromise = onmessage({ data: INIT_MSG });
  await sleep(5); // init ainda aguardando o socket abrir
  await onmessage({ data: { type: 'track', track: fakeTrack() } });
  await sleep(80); // init completa e o pump arranca
  await onmessage({ data: { type: 'stop' } });
  await sleep(10);

  check('initialized emitido', msgsOf('initialized').length === 1);
  check('capture-pumping emitido', msgsOf('capture-pumping').length >= 1);
  check('first-frame emitido', msgsOf('first-frame').length >= 1);
  check('stream-ready emitido', msgsOf('stream-ready').length >= 1);
  check('quadros codificados (raça não matou o pump)', encodes >= 3);
  const startIdx = wsSent.findIndex((m) => m.type === 'start');
  const configIdx = wsSent.findIndex((m) => m.type === 'config');
  check('config chega ANTES do start (nada de "no ar" sem mídia)', configIdx !== -1 && startIdx > configIdx);
  check('start enviado uma vez só', wsSent.filter((m) => m.type === 'start').length === 1);
}

// --------------------------------------------------------------- teste 2
// init termina ANTES do track → pump começa quando o track chega.

{
  reset();
  wsOpenDelayMs = 0;
  const onmessage = await freshHandler();
  await onmessage({ data: INIT_MSG });
  await sleep(20); // init concluiu
  check('inicializou antes do track', msgsOf('initialized').length === 1);
  await onmessage({ data: { type: 'track', track: fakeTrack() } });
  await sleep(20);
  await onmessage({ data: { type: 'stop' } });
  await sleep(10);

  check('pump começa quando o track chega', msgsOf('capture-pumping').length >= 1);
  check('stream-ready chega (ordem init→track)', msgsOf('stream-ready').length >= 1);
  check('quadros codificados (ordem init→track)', encodes >= 3);
}

// --------------------------------------------------------------- teste 3
// probe: track vivo → ok; track morto → fail.

{
  reset();
  const onmessage = await freshHandler();
  await onmessage({ data: { type: 'probe', track: { readyState: 'live', getSettings: () => ({}) } } });
  check('probe-ok para track vivo', msgsOf('probe-ok').length === 1);

  await onmessage({ data: { type: 'stop' } });
}

{
  reset();
  const onmessage = await freshHandler();
  await onmessage({ data: { type: 'probe', track: { readyState: 'ended' } } });
  check('probe-fail para track morto', msgsOf('probe-fail').length === 1);
  await onmessage({ data: { type: 'stop' } });
}

// --------------------------------------------------------------- teste 4
// áudio: config de áudio vai ao servidor e o encoder de áudio é configurado
// mesmo com o start do vídeo ainda não enviado.

{
  reset();
  wsOpenDelayMs = 0;
  const onmessage = await freshHandler();
  await onmessage({ data: INIT_MSG });
  await sleep(20);
  // Áudio ANTES do vídeo: a config de áudio precisa ser guardada pelo servidor
  // mesmo que o start do vídeo ainda não tenha saído (fix Bug 3/5).
  await onmessage({ data: { type: 'audioTrack', track: fakeTrack() } });
  await sleep(10);
  await onmessage({ data: { type: 'track', track: fakeTrack() } });
  await sleep(20);
  await onmessage({ data: { type: 'stop' } });
  await sleep(10);

  const audioConfig = wsSent.find((m) => m.type === 'audio-config');
  check('audio-config enviado ao servidor', Boolean(audioConfig));
  const startIdx2 = wsSent.findIndex((m) => m.type === 'start');
  const audioIdx = wsSent.findIndex((m) => m.type === 'audio-config');
  check('audio-config chega antes do start (servidor guarda)', audioIdx !== -1 && (startIdx2 === -1 || audioIdx < startIdx2));
}

// --------------------------------------------------------------- resultado

console.log(failures ? `\n${failures} verificacao(oes) falharam` : '\nTudo passou');
process.exit(failures ? 1 : 0);