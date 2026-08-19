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
 * thread). Depois o track é transferido ao worker quando possível.
 *
 * Sem WebRTC porque a Activity não tem, e sem MediaRecorder porque o container
 * impõe piso de latência. WebCodecs codifica quadro a quadro e envia direto.
 */
import { createInlineBroadcaster } from './broadcaster-inline.js';
import { contentHintFor } from './broadcast-mode.mjs';

// Detecção de capacidade: worker + track transferível (Chromium). Sem isso,
// fica no inline para não quebrar navegadores existentes.
function workerSupported() {
  if (typeof Worker === 'undefined') return false;
  if (typeof MediaStreamTrackProcessor === 'undefined') return false;
  // Não há como testar "o track é transferível" sem um track real; confiamos
  // na spec: em Chromium MediaStreamTrack é transferível. O try/catch no
  // postMessage cobre os casos em que o transfer falha.
  return true;
}

export function supportError({ requireChromium = false } = {}) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return 'Este navegador não permite captura de tela. Navegador de celular não suporta captura — use um desktop.';
  }
  if (!window.VideoEncoder || !window.VideoFrame || !window.EncodedVideoChunk) {
    return 'Este navegador não tem WebCodecs, necessário para transmitir. Use Chrome, Edge ou outro navegador Chromium no desktop.';
  }
  // Exigência de produto, não de capacidade: o caminho via <video> funciona em
  // Firefox e Safari, mas a captura sai visivelmente pior.
  if (requireChromium && !window.MediaStreamTrackProcessor) {
    return 'Transmitir exige um navegador Chromium — Chrome, Edge, Brave ou Opera. Nos outros a captura fica com qualidade ruim, então está desabilitada. Você continua podendo assistir.';
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.wsUrl        endpoint do relay, com o token de transmissor
 * @param {number} opts.bitrate      bits por segundo
 * @param {number} opts.fps
 * @param {boolean} [opts.audio]     capturar também o som do computador
 * @param {string} [opts.mode]       'auto' | 'motion' | 'game' | 'text'
 * @param {string} [opts.contentHint] força o contentHint ('motion'|'text'); ignora mode
 * @param {(info:object)=>void} [opts.onStatus]
 * @param {(stats:object)=>void} [opts.onStats]
 * @param {(reason:string)=>void} [opts.onEnd]
 * @param {(msg:string)=>void} [opts.onAviso]
 * @param {(msg:string)=>void} [opts.onError]
 */
export function createBroadcaster(opts) {
  const canWorker = workerSupported();

  if (canWorker) {
    try {
      return createWorkerBroadcaster(opts);
    } catch (err) {
      // worker falhou ao nascer (ex.: CSP, URL de módulo, transfer). Não derruba
      // quem já transmitia: cai para o pipeline inline.
      console.warn('[broadcaster] worker indisponível, usando inline:', err?.message ?? err);
    }
  }
  return createInlineBroadcaster(opts);
}

/**
 * Fechadura do worker. Acerta o MediaStreamTrack com a main thread e repassa
 * eventos/telemetria de volta. API idêntica à inline.
 */
function createWorkerBroadcaster({
  wsUrl,
  bitrate,
  fps,
  audio = false,
  mode = 'auto',
  contentHint = null,
  onStatus,
  onStats,
  onEnd,
  onAviso,
  onError,
}) {
  const hint = contentHint || contentHintFor(mode);
  const worker = new Worker(new URL('./broadcast-worker.mjs', import.meta.url), { type: 'module' });

  let stream = null;
  let running = false;
  let startedAt = 0;
  let lastTelemetry = null;
  let somBloqueado = false;
  let previewActive = false;
  let visibility = null;
  let lastStatus = null;

  let startedPromise = null;
  let hasAudio = false;

  worker.onmessage = (e) => {
    const msg = e.data;
    if (!msg) return;
    switch (msg.type) {
      case 'status':
        lastStatus = msg.status;
        if (typeof msg.status?.hasAudio === 'boolean') hasAudio = msg.status.hasAudio;
        onStatus?.(msg.status);
        break;
      case 'stats':
        lastTelemetry = msg.stats;
        onStats?.(msg.stats);
        break;
      case 'aviso':
        onAviso?.(msg.msg);
        break;
      case 'ready':
        if (startedPromise) {
          const resolve = startedPromise.resolve;
          startedPromise = null;
          resolve?.();
        }
        break;
      case 'end':
        if (startedPromise) {
          const reject = startedPromise.reject;
          startedPromise = null;
          reject?.(new Error(msg.reason));
        }
        if (running) {
          running = false;
          onEnd?.(msg.reason);
        }
        break;
      case 'error':
        onError?.(msg.message);
        break;
    }
  };

  worker.onerror = (err) => {
    console.warn('[broadcaster worker] erro:', err?.message ?? err);
    if (running) {
      running = false;
      onEnd?.('O pipeline de captura no worker falhou.');
    }
  };

  function post(msg) {
    worker.postMessage(msg);
  }

  function postTrack(track, key) {
    // Transfere o track. Se a transferência não for aceita (track não
    // transferível), o postMessage lança — tratado por quem chama.
    worker.postMessage({ type: key, track }, [track]);
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
    onAviso?.(
      'A tela inteira carrega o som do Discord junto, e a call se ouviria em eco. ' +
        'Transmitindo sem som — use "Som de uma aba" para escolher de onde vem o áudio.'
    );
    return null;
  }

  async function start() {
    // Precisa vir do gesto do usuário; qualquer await antes disso o invalida.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps } },
      audio: audio ? audioConstraints() : false,
    });

    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));

    // Inicializa o worker com a configuração.
    post({
      type: 'init',
      wsUrl,
      bitrate,
      fps,
      audio,
      mode,
      contentHint: hint,
      debugProbing: false,
    });

    startedPromise = {};
    const started = new Promise((resolve, reject) => {
      startedPromise.resolve = resolve;
      startedPromise.reject = reject;
    });

    // Transfere o track de vídeo.
    let videoOk = true;
    try {
      postTrack(track, 'track');
    } catch (err) {
      videoOk = false;
      console.warn('[broadcaster] track de vídeo não transferível:', err?.message ?? err);
    }
    if (!videoOk) {
      stream.getTracks().forEach((tr) => tr.stop());
      stream = null;
      throw new Error('Este navegador não suporta transferir a captura para o worker.');
    }

    // Áudio: transfere a faixa (se houver e não for bloqueada).
    const audioTrack = prepararSom(track, stream);
    if (audioTrack) {
      try {
        postTrack(audioTrack, 'audioTrack');
      } catch {
        audioTrack.stop();
        console.warn('[broadcaster] track de áudio não transferível; seguindo sem som.');
      }
    } else if (somBloqueado) {
      post({ type: 'audioTrack', track: null, somBloqueado: true });
    }

    // Worker confirma 'ready' quando o socket conecta e o encoder configura.
    try {
      await started;
    } catch (err) {
      // init falhou no worker (ex.: codec/network). Não deixa o track preso.
      stream?.getTracks().forEach((tr) => tr.stop());
      stream = null;
      throw err;
    }
    startedPromise = null;

    running = true;
    startedAt = Date.now();
    return stream;
  }

  function stop(reason) {
    if (!running && !stream) return;
    const wasRunning = running;
    running = false;
    try {
      post({ type: 'stop', reason: reason ?? '' });
    } catch {}
    if (wasRunning) onEnd?.(reason ?? '');
  }

  async function changeScreen() {
    const fresh = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps } },
      audio: audio ? audioConstraints() : false,
    });
    const previous = stream;
    const track = fresh.getVideoTracks()[0];
    if (hint) track.contentHint = hint;
    track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));

    postTrack(track, 'track');
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
  }

  async function trocarSom() {
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
  }

  function setQuality({ bitrate: nextBitrate, fps: nextFps } = {}) {
    if (nextBitrate) bitrate = nextBitrate;
    if (nextFps) fps = nextFps;
    post({ type: 'setQuality', bitrate: nextBitrate, fps: nextFps });
  }

  function getSettings() {
    return { bitrate, fps };
  }

  return {
    start,
    stop,
    changeScreen,
    trocarSom,
    setQuality,
    getSettings,
    getTelemetry: () => lastTelemetry ?? null,
    temSom: () => hasAudio,
    somBloqueado: () => somBloqueado,
    isRunning: () => running,
    getMode: () => mode,
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
