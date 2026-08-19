/**
 * Testes da fachada (broadcaster.js) com fakes injetados.
 *
 * Rode com: node shared/facade.test.mjs
 *
 * Cobre os bugs da regressão pós-DedicatedWorker:
 * 1. worker não suporta transferência (probe falha) → fallback inline com o MESMO
 *    stream e o track original vivo.
 * 2. transferência do clone falha (postMessage lança) → fallback inline e o
 *    track original vivo.
 * 3. worker saudável → clone transferido (nunca o original) e start() resolve.
 * 4. worker que nunca produz stream-ready (watchdog) → fallback inline com o
 *    track original vivo.
 * 5. worker crash (onerror) → fallback inline com o track original vivo.
 * 6. nunca re-pede a tela (getDisplayMedia chamado uma vez).
 */

import { strict as assert } from 'node:assert';
import { PHASES } from './lifecycle.mjs';

let getDisplayMediaCalls = 0;
let stream = null;
let originalTrack = null;
let cloneTrack = null;

function makeTrack() {
  return {
    readyState: 'live',
    contentHint: null,
    listeners: {},
    getSettings() {
      return {
        displaySurface: 'window',
        frameRate: 60,
        width: 1920,
        height: 1080,
        sampleRate: 48000,
        channelCount: 2,
      };
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    applyConstraints() {
      return Promise.resolve();
    },
    stop() {
      this.readyState = 'ended';
    },
    clone() {
      return makeTrack();
    },
  };
}

function makeStream() {
  const video = makeTrack();
  const audio = {
    readyState: 'live',
    getSettings: () => ({ displaySurface: 'browser', sampleRate: 48000, channelCount: 2 }),
    stop() {
      this.readyState = 'ended';
    },
  };
  const tracks = [video, audio];
  return {
    getVideoTracks: () => [video],
    getAudioTracks: () => [audio],
    getTracks: () => tracks,
    removeTrack(t) {
      const idx = tracks.indexOf(t);
      if (idx !== -1) tracks.splice(idx, 1);
    },
  };
}

globalThis.navigator = {
  mediaDevices: {
    getDisplayMedia: async () => {
      getDisplayMediaCalls++;
      stream = makeStream();
      originalTrack = stream.getVideoTracks()[0];
      return stream;
    },
    getSupportedConstraints: () => ({ restrictOwnAudio: true }),
  },
};
globalThis.window = { VideoEncoder: class {}, VideoFrame: class {}, EncodedVideoChunk: class {} };
globalThis.Worker = class {};
globalThis.MediaStreamTrackProcessor = class {};

// Instância nova da fachada por caso: ela guarda stream/running/phase em closure.
let caseId = 0;
async function freshBroadcaster(opts) {
  caseId++;
  const { createBroadcaster } = await import(`./broadcaster.js?case=${caseId}`);
  return createBroadcaster(opts);
}

function fakeInlineFactory(record) {
  return (opts) => ({
    start: async () => {
      record.inlineCalled = true;
      record.inlineStream = opts.stream;
      opts.onPhase?.(PHASES.STREAM_READY);
      return 'inline-result';
    },
    stop: () => {},
    setPreviewActive: () => {},
    setVisibility: () => {},
    getPreviewActive: () => false,
    getSettings: () => ({ bitrate: opts.bitrate, fps: opts.fps }),
    getTelemetry: () => null,
    temSom: () => false,
    somBloqueado: () => false,
  });
}

function fakeWorker(opts) {
  const w = {
    onmessage: null,
    onerror: null,
    terminated: false,
    received: [],
    postMessage(msg, transfer) {
      w.received.push({ msg, transfer });
      if (opts.onMessage) opts.onMessage(msg, transfer, w);
    },
    terminate() {
      w.terminated = true;
    },
  };
  return w;
}

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FALHOU'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

// --------------------------------------------------------------- teste 1
// Probe falha (navegador sem track transferible) → inline com o MESMO stream e
// o track original vivo.

{
  getDisplayMediaCalls = 0;
  const record = { inlineCalled: false, inlineStream: null };
  const b = await freshBroadcaster({
    wsUrl: 'ws://x',
    bitrate: 8_000_000,
    fps: 60,
    audio: true,
    __internals: {
      probeTransfer: async () => false,
      createInline: fakeInlineFactory(record),
    },
  });

  const result = await b.start();
  check('probe falhou → inline usado', record.inlineCalled === true);
  check('inline recebe o MESMO stream (sem re-pedir tela)', record.inlineStream === stream);
  check('getDisplayMedia chamado UMA vez', getDisplayMediaCalls === 1);
  check('track original continua live', originalTrack.readyState === 'live');
  check('start() resolveu', result === 'inline-result');
  check('fase final STREAM_READY (inline pronta)', b.getPhase() === 'STREAM_READY');
}

// --------------------------------------------------------------- teste 2
// Transferência do clone falha (postMessage lança) → fallback inline, original vivo.

{
  getDisplayMediaCalls = 0;
  const record = { inlineCalled: false, inlineStream: null };
  const b = await freshBroadcaster({
    wsUrl: 'ws://x',
    bitrate: 8_000_000,
    fps: 60,
    audio: false,
    __internals: {
      probeTransfer: async () => true,
      createWorker: () =>
        fakeWorker({
          onMessage(msg, transfer, w) {
            if (msg.type === 'init') {
              setTimeout(() => w.onmessage({ data: { type: 'initialized' } }), 0);
            }
            if (msg.type === 'track') {
              throw new Error('Value at index 0 does not have a transferable type.');
            }
          },
        }),
      createInline: fakeInlineFactory(record),
    },
  });

  const result = await b.start();
  check('clone transfer falhou → inline usado', record.inlineCalled === true);
  check('track original continua live', originalTrack.readyState === 'live');
  check('getDisplayMedia chamado UMA vez', getDisplayMediaCalls === 1);
  check('start() resolveu', result === 'inline-result');
}

// --------------------------------------------------------------- teste 3
// Worker saudável → clone transferido (nunca o original) e start() resolve em
// STREAM_READY.

{
  getDisplayMediaCalls = 0;
  const record = { inlineCalled: false };
  let transferredClone = null;
  const b = await freshBroadcaster({
    wsUrl: 'ws://x',
    bitrate: 8_000_000,
    fps: 60,
    audio: false,
    __internals: {
      probeTransfer: async () => true,
      createWorker: () =>
        fakeWorker({
          onMessage(msg, transfer, w) {
            if (msg.type === 'init') {
              setTimeout(() => w.onmessage({ data: { type: 'initialized' } }), 0);
            } else if (msg.type === 'track') {
              transferredClone = msg.track;
              setTimeout(() => {
                w.onmessage({ data: { type: 'capture-pumping' } });
                w.onmessage({ data: { type: 'first-frame' } });
                w.onmessage({ data: { type: 'stream-ready' } });
              }, 0);
            }
          },
        }),
      createInline: fakeInlineFactory(record),
    },
  });

  const result = await b.start();
  check('inline NÃO usado no caminho saudável', record.inlineCalled === false);
  check('clone transferido é um CLONE (nunca o original)', transferredClone !== null && transferredClone !== originalTrack);
  check('track original continua live', originalTrack.readyState === 'live');
  check('start() resolveu com o stream', result === stream);
  check('fase final STREAM_READY', b.getPhase() === 'STREAM_READY');
}

// --------------------------------------------------------------- teste 4
// Worker inicializa mas nunca produz stream-ready (watchdog) → fallback inline
// com o track original vivo.

{
  getDisplayMediaCalls = 0;
  const record = { inlineCalled: false };
  const b = await freshBroadcaster({
    wsUrl: 'ws://x',
    bitrate: 8_000_000,
    fps: 60,
    audio: false,
    __internals: {
      probeTransfer: async () => true,
      streamReadyTimeoutMs: 50,
      createWorker: () =>
        fakeWorker({
          onMessage(msg, transfer, w) {
            if (msg.type === 'init') {
              setTimeout(() => w.onmessage({ data: { type: 'initialized' } }), 0);
            }
          },
        }),
      createInline: fakeInlineFactory(record),
    },
  });

  await b.start();
  check('watchdog disparou → inline usado', record.inlineCalled === true);
  check('track original continua live (pipeline morta não matou a captura)', originalTrack.readyState === 'live');
}

// --------------------------------------------------------------- teste 5
// Worker crash (onerror) durante o start → fallback inline com o track vivo.

{
  getDisplayMediaCalls = 0;
  const record = { inlineCalled: false };
  let workerRef = null;
  const b = await freshBroadcaster({
    wsUrl: 'ws://x',
    bitrate: 8_000_000,
    fps: 60,
    audio: false,
    __internals: {
      probeTransfer: async () => true,
      createWorker: () => {
        const w = fakeWorker({
          onMessage(msg, transfer, w) {
            if (msg.type === 'init') {
              setTimeout(() => w.onmessage({ data: { type: 'initialized' } }), 0);
            }
          },
        });
        workerRef = w;
        return w;
      },
      createInline: fakeInlineFactory(record),
    },
  });

  const startPromise = b.start();
  await new Promise((r) => setTimeout(r, 20));
  workerRef.onerror(new Error('pipeline crashou'));
  await startPromise;
  check('worker crash → inline usado', record.inlineCalled === true);
  check('track original continua live após crash', originalTrack.readyState === 'live');
}

// --------------------------------------------------------------- teste 6
// Fallback por stream-ready nunca re-pede a tela (getDisplayMedia chamado uma vez).

{
  getDisplayMediaCalls = 0;
  const record = { inlineCalled: false };
  await freshBroadcaster({
    wsUrl: 'ws://x',
    bitrate: 8_000_000,
    fps: 60,
    audio: false,
    __internals: {
      probeTransfer: async () => true,
      streamReadyTimeoutMs: 30,
      createWorker: () =>
        fakeWorker({
          onMessage(msg, transfer, w) {
            if (msg.type === 'init') {
              setTimeout(() => w.onmessage({ data: { type: 'initialized' } }), 0);
            }
          },
        }),
      createInline: fakeInlineFactory(record),
    },
  }).then((b) => b.start());

  await new Promise((r) => setTimeout(r, 80));
  check('nenhuma re-pergunta de tela no fallback', getDisplayMediaCalls === 1);
}

// --------------------------------------------------------------- resultado

console.log(failures ? `\n${failures} verificacao(oes) falharam` : '\nTudo passou');
process.exit(failures ? 1 : 0);