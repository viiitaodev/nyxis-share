/**
 * Pipeline de transmissão: captura → codifica → envia.
 *
 * Fachada que decide entre inline (default, main thread) e worker (experimental,
 * opt-in). O pipeline inline é o baseline de produção — já funcionava antes da
 * introdução do worker.
 *
 * Worker só é ativado quando explicitamente habilitado via:
 *   - URL:   ?experimentalWorker=1
 *   - localStorage: nyxisExperimentalWorker = "1"
 *
 * Regra: funcionamento vem antes de otimização. O worker é uma otimização
 * experimental que só entra em produção quando comprovadamente estável.
 */
import { createInlineBroadcaster } from './broadcaster-inline.js';
import { contentHintFor } from './broadcast-mode.mjs';

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

/**
 * Worker experimental só é usado quando explicitamente habilitado.
 * Browser suportar Worker/MediaStreamTrackProcessor NÃO significa que
 * transferir um display MediaStreamTrack seja confiável.
 */
function experimentalWorkerEnabled() {
  try {
    if (new URLSearchParams(location.search).get('experimentalWorker') === '1') return true;
    if (localStorage.getItem('nyxisExperimentalWorker') === '1') return true;
  } catch {}
  return false;
}

function workerSupported() {
  if (typeof Worker === 'undefined') return false;
  if (typeof MediaStreamTrackProcessor === 'undefined') return false;
  return true;
}

/**
 * @param {object} opts
 * @param {string} opts.wsUrl
 * @param {number} opts.bitrate
 * @param {number} opts.fps
 * @param {boolean} [opts.audio]
 * @param {string} [opts.mode]
 * @param {string} [opts.contentHint]
 * @param {(info:object)=>void} [opts.onStatus]
 * @param {(stats:object)=>void} [opts.onStats]
 * @param {(phase:string)=>void} [opts.onPhase]  fase do lifecycle
 * @param {(reason:string)=>void} [opts.onEnd]
 * @param {(msg:string)=>void} [opts.onAviso]
 * @param {(msg:string)=>void} [opts.onError]
 */
export function createBroadcaster(opts) {
  // Default: inline. Worker só com flag.
  if (experimentalWorkerEnabled() && workerSupported()) {
    try {
      console.log('[broadcaster] worker experimental habilitado — usando worker pipeline');
      return createWorkerBroadcaster(opts);
    } catch (err) {
      console.warn('[broadcaster] worker falhou, caindo para inline:', err?.message ?? err);
    }
  }
  return createInlineBroadcaster(opts);
}

// ----------------------------------------------------------------- worker (experimental)

function createWorkerBroadcaster(opts) {
  let worker = null;
  let stream = null;
  let running = false;
  let somBloqueado = false;
  let previewActive = false;
  let visibility = null;
  let hasAudio = false;

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

  function post(msg) { worker.postMessage(msg); }
  function postTrack(track, key) { worker.postMessage({ type: key, track }, [track]); }

  function makeHandle() {
    const hint = opts.contentHint || contentHintFor(opts.mode ?? 'auto');
    worker = new Worker(new URL('./broadcast-worker.mjs', import.meta.url), { type: 'module' });
    let startedPromise = null;

    worker.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      switch (msg.type) {
        case 'status':
          if (typeof msg.status?.hasAudio === 'boolean') hasAudio = msg.status.hasAudio;
          opts.onStatus?.(msg.status);
          break;
        case 'stats':
          opts.onStats?.(msg.stats);
          break;
        case 'aviso':
          opts.onAviso?.(msg.msg);
          break;
        case 'ready':
          startedPromise?.resolve?.();
          startedPromise = null;
          break;
        case 'end':
          if (startedPromise) { startedPromise.reject?.(new Error(msg.reason)); startedPromise = null; }
          if (running) { running = false; opts.onEnd?.(msg.reason); }
          break;
        case 'error':
          opts.onError?.(msg.message);
          break;
      }
    };
    worker.onerror = (err) => {
      if (running) { running = false; opts.onEnd?.('Worker falhou.'); }
    };

    return {
      start: async () => {
        const track = stream.getVideoTracks()[0];
        if (hint) track.contentHint = hint;
        track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));
        post({ type: 'init', wsUrl: opts.wsUrl, bitrate: opts.bitrate, fps: opts.fps, audio: opts.audio, mode: opts.mode ?? 'auto', contentHint: hint });
        startedPromise = {};
        const started = new Promise((resolve, reject) => { startedPromise.resolve = resolve; startedPromise.reject = reject; });
        const audioTrack = prepararSom(track, stream);
        let videoOk = true;
        try { postTrack(track, 'track'); } catch { videoOk = false; }
        if (!videoOk) {
          if (audioTrack) audioTrack.stop();
          worker.terminate(); worker = null;
          return { fallbackInline: true };
        }
        if (audioTrack) {
          try { postTrack(audioTrack, 'audioTrack'); } catch { audioTrack.stop(); }
        } else if (somBloqueado) {
          post({ type: 'audioTrack', track: null, somBloqueado: true });
        }
        await started;
        running = true;
        return stream;
      },
      stop: (reason) => {
        const was = running; running = false;
        try { post({ type: 'stop', reason }); } catch {}
        if (was) opts.onEnd?.(reason ?? '');
      },
      changeScreen: async () => {
        const fresh = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: opts.fps, max: opts.fps } }, audio: opts.audio ? audioConstraints() : false });
        const prev = stream; const t = fresh.getVideoTracks()[0];
        if (hint) t.contentHint = hint;
        t.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));
        postTrack(t, 'track'); prev?.getTracks().forEach(tr => tr.stop()); stream = fresh;
        return fresh;
      },
      trocarSom: async () => {
        const es = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: audioConstraints() });
        const f = es.getAudioTracks()[0]; const sup = es.getVideoTracks()[0]?.getSettings?.().displaySurface;
        es.getVideoTracks().forEach(t => t.stop());
        if (!f) throw new Error('Essa escolha veio sem som.');
        if (sup !== 'browser') { f.stop(); throw new Error('Só aba tem som isolado.'); }
        somBloqueado = false;
        try { postTrack(f, 'swapAudio'); } catch { f.stop(); throw new Error('Transferência de áudio falhou.'); }
        return f;
      },
      setQuality: (q) => post({ type: 'setQuality', ...q }),
      getSettings: () => ({ bitrate: opts.bitrate, fps: opts.fps }),
      temSom: () => hasAudio,
      somBloqueado: () => somBloqueado,
      setPreviewActive: (v) => { previewActive = v; post({ type: 'previewState', previewActive: v, visibility }); },
      setVisibility: (v) => { visibility = v; post({ type: 'previewState', previewActive, visibility: v }); },
      getPreviewActive: () => previewActive,
    };
  }

  async function start() {
    opts.onPhase?.('INITIALIZING');
    opts.onPhase?.('AWAITING_PICKER');
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: opts.fps, max: opts.fps } },
      audio: opts.audio ? audioConstraints() : false,
    });
    opts.onPhase?.('CAPTURE_ACQUIRED');

    const handle = makeHandle();
    const res = await handle.start();
    if (res?.fallbackInline) {
      opts.onPhase?.('FALLBACK_INLINE');
      const inline = createInlineBroadcaster({ ...opts, stream });
      return inline.start();
    }
    return res;
  }

  function stop(r) { /* delegate to handle if needed */ }

  return {
    start, stop,
    changeScreen: () => { throw new Error('worker changeScreen not implemented'); },
    trocarSom: () => { throw new Error('worker trocarSom not implemented'); },
    setQuality: () => {},
    getSettings: () => ({ bitrate: opts.bitrate, fps: opts.fps }),
    getTelemetry: () => null,
    temSom: () => false,
    somBloqueado: () => somBloqueado,
    isRunning: () => running,
    getMode: () => opts.mode ?? 'auto',
    setPreviewActive: () => {},
    setVisibility: () => {},
    getPreviewActive: () => false,
  };
}
