/**
 * Pipeline de transmissão: captura → codifica → envia.
 *
 * Módulo compartilhado entre a Activity (captura dentro do modal, quando o
 * Discord permite) e a página de captura externa (quando não permite). Uma
 * fachada única — o pipeline real roda num DedicatedWorker quando o navegador
 * permite transferir o MediaStreamTrack, e cai para a implementação inline
 * (main thread) caso contrário.
 *
 * Por que worker: quando o usuário coloca um jogo em primeiro plano e a aba de
 * captura vai para background, o pipeline pesado (MediaStreamTrackProcessor,
 * VideoEncoder, packaging, WebSocket, telemetria) não deve depender de
 * requestAnimationFrame, de timers visuais, de repaint da página nem de
 * preview. Isso isola a main thread para UI/permissões/start-stop/preview.
 *
 * A captura SEMPRE nasce aqui (getDisplayMedia exige gesto + permissão na main
 * thread).
 *
 * SEGURANÇA DA CAPTURA (fix pós-DedicatedWorker):
 * 1. Antes de qualquer coisa destrutiva, um probe com track descartável de
 *    canvas testa se o navegador aceita transferir MediaStreamTrack. O track
 *    escolhido pelo usuário NUNCA entra nesse teste.
 * 2. Mesmo com o probe ok, o worker recebe um CLONE do track de vídeo. O
 *    original fica na main thread (preview, telemetria, e o fallback inline
 *    intacto). Se a transferência do clone falhar, o clone é parado e o
 *    original segue usado no pipeline inline — a captura nunca é destruída.
 * 3. O áudio só é preparado/transferido DEPOIS que a estratégia de pipeline
 *    está confirmada — falhar no worker não perde o som escolhido.
 *
 * Handshake: main → init; worker → initialized; main → track (clone); worker →
 * capture-pumping → first-frame → stream-ready. `start()` resolve apenas em
 * STREAM_READY (a pipeline tem condições de produzir mídia). O worker também
 * aceita o track antes do init terminar (bufferiza e arranca depois) — nunca
 * há corrida entre mensagens.
 *
 * Sem WebRTC porque a Activity não tem, e sem MediaRecorder porque o container
 * impõe piso de latência. WebCodecs codifica quadro a quadro e envia direto.
 */
import { createInlineBroadcaster } from './broadcaster-inline.js';
import { contentHintFor } from './broadcast-mode.mjs';
import { PHASES } from './lifecycle.mjs';

const STREAM_READY_TIMEOUT_MS = 15_000;
const INIT_TIMEOUT_MS = 25_000;

function workerSupported() {
  if (typeof Worker === 'undefined') return false;
  if (typeof MediaStreamTrackProcessor === 'undefined') return false;
  return true;
}

export function supportError({ requireChromium = false } = {}) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return 'Este navegador não permite captura de tela. Navegador de celular não suporta captura — use um desktop.';
  }
  if (!window.VideoEncoder || !window.VideoFrame || !window.EncodedVideoChunk) {
    return 'Este navegador não tem WebCodecs, necessário para transmitir. Use Chrome, Edge ou outro navegador Chromium no desktop.';
  }
  if (requireChromium && !window.MediaStreamTrackProcessor) {
    return 'Transmitir exige um navegador Chromium — Chrome, Edge, Brave ou Opera. Nos outros a captura fica com qualidade ruim, então está desabilitada. Você continua podendo assistir.';
  }
  return null;
}

function defaultCreateWorker() {
  return new Worker(new URL('./broadcast-worker.mjs', import.meta.url), { type: 'module' });
}

/**
 * Testa se o navegador aceita transferir MediaStreamTrack para um worker.
 *
 * Usa um track descartável de canvas.captureStream() — NUNCA a captura
 * escolhida pelo usuário. Se o postMessage lançar (track não transferível), se
 * o worker receber o track morto, ou se nada responder em 3s, o resultado é
 * false e a fachada segue direto para o inline com o stream intacto.
 */
async function canTransferTrack() {
  if (!workerSupported()) return false;
  try {
    const canvas = document.createElement('canvas');
    const stream = canvas.captureStream();
    const track = stream.getVideoTracks()[0];
    if (!track) return false;

    const w = defaultCreateWorker();
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        w.terminate();
        track.stop();
        resolve(false);
      }, 3000);
      const done = (ok) => {
        clearTimeout(timer);
        w.terminate();
        track.stop();
        resolve(ok);
      };
      w.onmessage = (e) => {
        if (e?.data?.type === 'probe-ok') done(true);
        else if (e?.data?.type === 'probe-fail') done(false);
      };
      w.onerror = () => done(false);
      try {
        w.postMessage({ type: 'probe', track }, [track]);
      } catch {
        done(false);
      }
    });
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.wsUrl
 * @param {number} opts.bitrate
 * @param {number} opts.fps
 * @param {boolean} [opts.audio]
 * @param {string} [opts.mode]        'auto' | 'motion' | 'game' | 'text'
 * @param {string} [opts.contentHint]
 * @param {(info:object)=>void} [opts.onStatus]
 * @param {(stats:object)=>void} [opts.onStats]
 * @param {(reason:string)=>void} [opts.onEnd]
 * @param {(msg:string)=>void} [opts.onAviso]
 * @param {(msg:string)=>void} [opts.onError]
 * @param {(phase:string)=>void} [opts.onPhase]
 * @param {object} [opts.__internals]   hooks de teste (não usar em produção)
 */
export function createBroadcaster(opts) {
  const internals = opts.__internals ?? {};

  // `backend` é a implementação ativa. Começa como null e é definido no start():
  // worker-handle quando a transferência do track funciona, inline-handle caso
  // contrário (ou quando o navegador não suporta worker). Toda a API delega aqui.
  let backend = null;
  let worker = null;
  let stream = null;
  let running = false;
  let stopped = false;
  let somBloqueado = false;
  let previewActive = false;
  let visibility = null;
  let hasAudio = false;
  let phase = null;

  function setPhase(p) {
    if (phase === p) return;
    phase = p;
    opts.onPhase?.(p);
  }

  function audioConstraints() {
    const c = {
      systemAudio: 'include',
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    if (navigator.mediaDevices.getSupportedConstraints?.().restrictOwnAudio) {
      c.restrictOwnAudio = true;
    }
    return c;
  }

  function prepararSom(videoTrack, capturado) {
    const faixa = capturado.getAudioTracks()[0];
    if (!faixa) return null;
    if (videoTrack.getSettings?.().displaySurface === 'browser') return faixa;
    faixa.stop();
    capturado.removeTrack(faixa);
    somBloqueado = true;
    opts.onAviso?.(
      'A tela inteira carrega o som do Discord junto, e a call se ouviria em eco. ' +
        'Transmitindo sem som — use "Som de uma aba" para escolher de onde vem o áudio.'
    );
    return null;
  }

  function post(msg) {
    worker.postMessage(msg);
  }

  function postTrack(track, key) {
    worker.postMessage({ type: key, track }, [track]);
  }

  // ------------------------------------------------------------- worker-handle

  function makeWorkerHandle() {
    const hint = opts.contentHint || contentHintFor(opts.mode ?? 'auto');
    worker = (internals.createWorker ?? defaultCreateWorker)();

    // Espera por um tipo de mensagem do worker. Sequencial: só há um await por
    // vez em start() ('initialized' e depois 'stream-ready').
    const waiters = new Map();

    function waitFor(type, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(type);
          reject(new Error(`Pipeline parou antes de ficar pronto (aguardando ${type}).`));
        }, timeoutMs);
        waiters.set(type, { resolve, reject, timer });
      });
    }

    function settle(type, value) {
      const w = waiters.get(type);
      if (!w) return;
      clearTimeout(w.timer);
      waiters.delete(type);
      w.resolve(value);
    }

    function settleRejectAll(reason) {
      const err = new Error(reason ?? 'Transmissão encerrada.');
      for (const [, w] of waiters) {
        clearTimeout(w.timer);
        w.reject(err);
      }
      waiters.clear();
    }

    worker.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      switch (msg.type) {
        case 'initialized':
          setPhase(PHASES.TRANSPORT_CONNECTED);
          setPhase(PHASES.ENCODER_READY);
          settle('initialized');
          break;
        case 'capture-pumping':
          setPhase(PHASES.CAPTURE_PUMPING);
          break;
        case 'first-frame':
          setPhase(PHASES.FIRST_FRAME_SUBMITTED);
          break;
        case 'stream-ready':
          setPhase(PHASES.FIRST_FRAME_ENCODED);
          setPhase(PHASES.STREAM_READY);
          settle('stream-ready');
          break;
        case 'status':
          if (typeof msg.status?.hasAudio === 'boolean') hasAudio = msg.status.hasAudio;
          opts.onStatus?.({ ...msg.status, phase });
          break;
        case 'stats':
          opts.onStats?.({ ...msg.stats, phase });
          break;
        case 'aviso':
          opts.onAviso?.(msg.msg);
          break;
        case 'error':
          opts.onError?.(msg.message);
          break;
        case 'end':
          settleRejectAll(msg.reason);
          if (running) {
            running = false;
            opts.onEnd?.(msg.reason);
          }
          break;
      }
    };

    worker.onerror = (err) => {
      console.warn('[broadcaster worker] erro:', err?.message ?? err);
      settleRejectAll('O pipeline de captura no worker falhou.');
      if (running) {
        running = false;
        opts.onEnd?.('O pipeline de captura no worker falhou.');
      }
    };

    return {
      start: async () => {
        const originalTrack = stream.getVideoTracks()[0];
        if (hint) originalTrack.contentHint = hint;
        originalTrack.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));

        post({
          type: 'init',
          wsUrl: opts.wsUrl,
          bitrate: opts.bitrate,
          fps: opts.fps,
          audio: opts.audio,
          mode: opts.mode ?? 'auto',
          contentHint: hint,
          debugProbing: false,
        });

        // Handshake: só transfere o track depois que o worker confirmou que
        // config/socket/encoder estão prontos.
        try {
          await waitFor('initialized', internals.initTimeoutMs ?? INIT_TIMEOUT_MS);
        } catch (err) {
          if (stopped) throw new Error('Transmissão cancelada.');
          console.warn('[broadcaster] worker não inicializou, caindo para inline:', err.message);
          return { fallbackInline: true };
        }

        // Clone para o worker; o ORIGINAL permanece intacto na main thread
        // (preview, telemetria, fallback inline). Nunca transferimos o track real.
        const workerTrack = originalTrack.clone();
        let videoOk = true;
        try {
          postTrack(workerTrack, 'track');
        } catch (err) {
          videoOk = false;
          console.warn('[broadcaster] clone de vídeo não transferível, caindo para inline:', err?.message ?? err);
          workerTrack.stop();
        }
        if (!videoOk) {
          if (stopped) throw new Error('Transmissão cancelada.');
          return { fallbackInline: true };
        }

        // Áudio só depois da estratégia estar confirmada: a decisão de bloquear
        // o som e a transferência acontecem aqui, e só aqui.
        const audioTrack = prepararSom(originalTrack, stream);
        if (audioTrack) {
          try {
            postTrack(audioTrack, 'audioTrack');
          } catch (err) {
            audioTrack.stop();
            console.warn('[broadcaster] track de áudio não transferível; seguindo sem som.');
          }
        } else if (somBloqueado) {
          post({ type: 'audioTrack', track: null, somBloqueado: true });
        }

        // A transmissão só está pronta quando a pipeline produz mídia de fato
        // (primeiro chunk codificado + config enviada ao servidor).
        try {
          await waitFor('stream-ready', internals.streamReadyTimeoutMs ?? STREAM_READY_TIMEOUT_MS);
        } catch (err) {
          if (stopped) throw new Error('Transmissão cancelada.');
          console.warn('[broadcaster] pipeline não produziu vídeo, caindo para inline:', err.message);
          return { fallbackInline: true };
        }
        running = true;
        return stream;
      },
      stop: (reason) => {
        const wasRunning = running;
        running = false;
        try {
          post({ type: 'stop', reason: reason ?? '' });
        } catch {}
        stream?.getTracks().forEach((t) => t.stop());
        if (wasRunning) opts.onEnd?.(reason ?? '');
      },
      changeScreen: async () => {
        const fresh = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: opts.fps, max: opts.fps } },
          audio: opts.audio ? audioConstraints() : false,
        });
        const previous = stream;
        const track = fresh.getVideoTracks()[0];
        if (hint) track.contentHint = hint;
        track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));

        const workerTrack = track.clone();
        try {
          postTrack(workerTrack, 'track');
        } catch (err) {
          workerTrack.stop();
          throw new Error('Não foi possível transferir a nova tela para o worker.');
        }

        previous?.getTracks().forEach((t) => t.stop());
        stream = fresh;

        const novoAudio = prepararSom(track, fresh);
        if (novoAudio) {
          try {
            postTrack(novoAudio, 'audioTrack');
          } catch {
            novoAudio.stop();
          }
        }
        return fresh;
      },
      trocarSom: async () => {
        const escolha = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: audioConstraints(),
        });
        const faixa = escolha.getAudioTracks()[0];
        const superficie = escolha.getVideoTracks()[0]?.getSettings?.().displaySurface;
        escolha.getVideoTracks().forEach((t) => t.stop());

        if (!faixa) {
          escolha.getTracks().forEach((t) => t.stop());
          throw new Error(
            'Essa escolha veio sem som. Escolha uma aba e marque "Compartilhar o áudio da guia".'
          );
        }
        if (superficie !== 'browser') {
          faixa.stop();
          throw new Error(
            'Só aba tem som isolado. Tela inteira traria o Discord junto e a call se ouviria.'
          );
        }
        somBloqueado = false;
        try {
          postTrack(faixa, 'swapAudio');
        } catch {
          faixa.stop();
          throw new Error('Não foi possível transferir o áudio para o worker.');
        }
        return faixa;
      },
      setQuality: ({ bitrate: nextBitrate, fps: nextFps } = {}) => {
        post({ type: 'setQuality', bitrate: nextBitrate, fps: nextFps });
      },
      getSettings: () => ({ bitrate: opts.bitrate, fps: opts.fps }),
      temSom: () => hasAudio,
      somBloqueado: () => somBloqueado,
      setPreviewActive: (v) => {
        previewActive = v;
        post({ type: 'previewState', previewActive: v, visibility });
      },
      setVisibility: (v) => {
        visibility = v;
        post({ type: 'previewState', previewActive, visibility: v });
      },
      getPreviewActive: () => previewActive,
    };
  }

  // ------------------------------------------------------------- inline-handle

  // Fallback do worker: roda o pipeline inline na main thread reutilizando o
  // MESMO stream já escolhido — nunca re-pede a tela. O track original está
  // intacto porque a estratégia de worker só toca num clone.
  function makeInlineHandle() {
    const factory = internals.createInline ?? createInlineBroadcaster;
    const b = factory({
      ...opts,
      stream,
      onPhase: (p) => setPhase(p),
    });
    return {
      ...b,
      setPreviewActive: (v) => {
        previewActive = v;
        b.setPreviewActive?.(v);
      },
      setVisibility: (v) => {
        visibility = v;
        b.setVisibility?.(v);
      },
      getPreviewActive: () => previewActive,
    };
  }

  // -------------------------------------------------------------------- API

  async function startInline() {
    backend = makeInlineHandle();
    try {
      const res = await backend.start();
      if (stopped) throw new Error('Transmissão cancelada.');
      running = true;
      return res;
    } catch (err) {
      if (stopped) throw new Error('Transmissão cancelada.');
      throw err;
    }
  }

  async function start() {
    stopped = false;
    setPhase(PHASES.INITIALIZING);

    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: opts.fps, max: opts.fps } },
      audio: opts.audio ? audioConstraints() : false,
    });
    setPhase(PHASES.CAPTURE_ACQUIRED);

    const probe = internals.probeTransfer ?? canTransferTrack;
    const canWork = workerSupported();
    const probeResult = await probe();
    console.warn('[facade-debug] canWork=%s probeResult=%s', canWork, probeResult);
    if (canWork && probeResult) {
      console.warn('[facade-debug] entrando worker path');
      backend = makeWorkerHandle();
      try {
        const res = await backend.start();
        if (stopped) throw new Error('Transmissão cancelada.');
        // Clone/transfer/stream-ready falhou no worker → inline com o MESMO
        // stream (o original nunca foi tocado). Fora do try: não entrar em loop.
        if (res?.fallbackInline) return startInline();
        running = true;
        return res;
      } catch (err) {
        if (stopped) throw err;
        console.warn('[facade-debug] worker path erro ao iniciar: %s', err.message);
        // Worker falhou de outra forma (codec/network) — cai para inline.
        try { worker?.terminate(); } catch {}
        worker = null;
        backend = null;
        return startInline();
      }
    }

    return startInline();
  }

  function stop(reason) {
    stopped = true;
    if (!backend) return;
    backend.stop?.(reason);
  }

  function changeScreen() {
    return backend?.changeScreen?.();
  }

  function trocarSom() {
    return backend?.trocarSom?.();
  }

  function setQuality(q) {
    backend?.setQuality?.(q);
  }

  function getSettings() {
    return backend?.getSettings?.() ?? { bitrate: opts.bitrate, fps: opts.fps };
  }

  return {
    start,
    stop,
    changeScreen,
    trocarSom,
    setQuality,
    getSettings,
    getTelemetry: () => backend?.getTelemetry?.() ?? null,
    temSom: () => backend?.temSom?.() ?? false,
    somBloqueado: () => backend?.somBloqueado?.() ?? somBloqueado,
    isRunning: () => running,
    getMode: () => opts.mode ?? 'auto',
    getPhase: () => phase,
    setPreviewActive: (v) => backend?.setPreviewActive?.(v),
    setVisibility: (v) => backend?.setVisibility?.(v),
    getPreviewActive: () => backend?.getPreviewActive?.() ?? false,
  };
}