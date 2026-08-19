/**
 * Pipeline de transmissão: captura → codifica → envia.
 *
 * Módulo compartilhado entre a Activity (captura dentro do modal, quando o
 * Discord permite) e a página de captura externa (quando não permite). Uma
 * implementação só — duas cópias divergiriam na primeira correção.
 *
 * Sem WebRTC porque a Activity não tem, e sem MediaRecorder porque o container
 * impõe piso de latência. WebCodecs codifica quadro a quadro e envia direto.
 */
import { contentHintFor } from './broadcast-mode.mjs';
import { createAdaptiveController } from './adaptive.mjs';
import { identifyBottleneck } from './bottleneck.mjs';

// H264 costuma ter encoder por hardware; VP8 quase sempre cai em software, que
// a 1080p derruba o framerate. Por isso as duas variantes de H264 vêm antes:
// annexb dispensa o blob `description`, e avcC é aceito onde annexb não é.
const CANDIDATES = [
  { codec: 'avc1.42E01E', avc: { format: 'annexb' } },
  { codec: 'avc1.42E01E' },
  { codec: 'vp8' },
  { codec: 'vp09.00.10.08' },
];

// Keyframe periódico: seguro barato para quem reconecta fora do fluxo normal.
const KEYFRAME_EVERY_MS = 3000;

// Tipos do primeiro byte útil de cada pacote. O áudio anda pelo mesmo socket e
// pelo mesmo cabeçalho do vídeo: um canal só, um formato só, e o servidor
// continua repassando o buffer sem precisar abrir nada.
const TIPO_KEYFRAME = 1;
const TIPO_DELTA = 2;
const TIPO_AUDIO = 3;

// 96 kbps em Opus estéreo é transparente para som de aplicativo e de vídeo, e é
// ruído perto dos megabits do vídeo — não vale economizar aqui.
const AUDIO_BITRATE = 96_000;

// Teto de resolução: acima disso banda e CPU disparam sem ganho de legibilidade.
// A imagem é reduzida proporcionalmente, nunca cortada.
const MAX_W = 1920;
const MAX_H = 1080;

// Política de fila do encoder (Fase 5): >= 3 significa atraso acumulado.
const DROP_QUEUE_THRESHOLD = 3;
// Piso do bitrate no adaptive (Fase 6): não vale a pena mandar vídeo inútil.
const MIN_BITRATE = 500_000;

// Diagnóstico de probing de codec: só em modo debug (nunca spam ao usuário).
const DEBUG_PROBING = typeof process !== 'undefined' && process.env?.DEBUG_PROBING === '1';

const even = (n) => Math.max(2, n - (n % 2));

function fitWithin(w, h) {
  const scale = Math.min(1, MAX_W / w, MAX_H / h);
  return { width: even(Math.round(w * scale)), height: even(Math.round(h * scale)) };
}

/** Motivo pelo qual este navegador não consegue transmitir, ou null. */
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
 * @param {string} [opts.mode]       'auto' | 'motion' | 'text' — modo de conteúdo
 * @param {string} [opts.contentHint] força o contentHint ('motion'|'text'); ignora mode
 * @param {(info:object)=>void} [opts.onStatus]  codec/resolução/caminho de captura
 * @param {(stats:object)=>void} [opts.onStats]  viewers, fps, mbps, segundos no ar
 * @param {(reason:string)=>void} [opts.onEnd]   encerrou (por qualquer motivo)
 * @param {(msg:string)=>void} [opts.onAviso]    algo mudou sem ser erro
 * @param {(msg:string)=>void} [opts.onError]
 */
export function createBroadcaster({
  wsUrl,
  bitrate,
  fps,
  audio = false,
  mode = 'auto',
  contentHint = null,
  onStatus,
  onStats,
  onEnd,
  onError,
  onAviso,
}) {
  let ws = null;
  let stream = null;
  let encoder = null;
  let reader = null;
  let audioEncoder = null;
  let audioReader = null;
  // Pediram som, mas a superfície escolhida traria o Discord junto. Guardado
  // para a interface poder oferecer a saída em vez de só avisar e esquecer.
  let somBloqueado = false;
  let video = null;
  let config = null;
  let stage = null;
  let stageCtx = null;

  // contentHint efetivo, decidido pelo modo quando não foi forçado.
  const hint = contentHint || contentHintFor(mode);

  let running = false;
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

  // Configuração de telemetria (sem contadores — esses vivem em `tel`).
  let t = {
    capturePath: null, // 'direct' | 'video'
    transport: 'WebSocket',
    hardwareAcceleration: 'requested',
    probing: [], // resultado de cada variante testada no pickConfig
    probingSummary: null,
  };
  let lastTelemetry = null;
  let feedback = null; // resumo do viewer (Fase 7)

  // Contadores acumulados desde o início da janela de telemetria. O FPS é
  // calculado por delta de tempo real (frames / dt), nunca assumindo 1s.
  let tel = { captured: 0, submitted: 0, encoded: 0, dropped: 0, keyframes: 0 };
  let windowStartAt = 0;
  let lastStatus = null;

  // AdaptiveQualityController (Bug 4): degrada rápido, recupera devagar,
  // nunca passa do bitrate escolhido pelo usuário/perfil.
  const adaptive = createAdaptiveController({
    initialBitrate: bitrate,
    onApply: applyBitrate,
    onChange: (msg) => onAviso?.(msg),
  });

  /**
   * Estrutura de status SEMPRE consistente (Bug 5). Chamada no start() e em
   * syncSize() — nunca duplicar estruturas que divergem.
   */
  function emitStatus() {
    const status = {
      codec: config?.codec,
      width: config?.width,
      height: config?.height,
      direct: t.capturePath === 'direct',
      mode,
      hint: hint ?? 'none',
      hardwareAcceleration: t.hardwareAcceleration ?? 'requested',
      transport: t.transport,
    };
    lastStatus = status;
    onStatus?.(status);
  }

  async function start() {
    // Precisa vir do gesto do usuário; qualquer await antes disso o invalida.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps } },
      // systemAudio: 'include' pede o som do computador em vez de só o da aba.
      // Os tratamentos de voz ficam desligados: eles existem para microfone e,
      // em som de aplicativo, cortam justamente o que se queria ouvir.
      audio: audio ? audioConstraints() : false,
    });

    const track = stream.getVideoTracks()[0];
    // Diz ao encoder o tipo de conteúdo: 'text' preserva nitidez de UI,
    // 'motion' prioriza movimento. No modo auto, deixamos o navegador decidir.
    if (hint) track.contentHint = hint;
    track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));

    const s = track.getSettings();
    const target = fitWithin(s.width ?? 1280, s.height ?? 720);

    config = await pickConfig(target.width, target.height);
    if (!config) {
      cleanup();
      throw new Error('Nenhum codec de vídeo suportado por este navegador.');
    }

    await connect();

    encoder = new VideoEncoder({
      output: onEncoded,
      error: (err) => stop(`Erro no encoder: ${err.message}`),
    });
    encoder.configure(config);

    ws.send(JSON.stringify({ type: 'start' }));

    running = true;
    wantKeyframe = true;
    lastKeyframeAt = 0;
    srcW = 0;
    srcH = 0;
    startedAt = Date.now();

    t.capturePath = window.MediaStreamTrackProcessor ? 'direct' : 'video';
    t.hardwareAcceleration = config.hardwareAcceleration ?? 'requested';

    tel = { captured: 0, submitted: 0, encoded: 0, dropped: 0, keyframes: 0 };
    windowStartAt = performance.now();
    emitStatus();

    statsTimer = setInterval(() => {
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
        contentHint: hint ?? 'none',
        hardwareAcceleration: t.hardwareAcceleration,
        bufferedAmount: ws?.bufferedAmount ?? 0,
        transport: t.transport,
        keyframes: tel.keyframes,
        mode,
        seconds: Math.floor((now - startedAt) / 1000),
        feedback,
        probingSummary: t.probingSummary,
      };
      // Bug 2: montar o objeto primeiro e só então derivar o gargalo.
      sample.bottleneck = identifyBottleneck(sample, config?.framerate ?? fps);
      lastTelemetry = sample;
      onStats?.(sample);
      adaptive.onTick(sample);

      // Nova janela: zera contadores e bitrate (contadores de bytes/telemetria).
      tel.captured = 0;
      tel.submitted = 0;
      tel.encoded = 0;
      tel.dropped = 0;
      tel.keyframes = 0;
      bytes = 0;
      frames = 0;
      windowStartAt = nowPerf;
      adaptive.onTick(sample);
    }, 1000);

    pump(track);
    // Pedir áudio não garante receber: em vários sistemas a caixa "compartilhar
    // o som" fica desmarcada, e o navegador devolve a tela sem faixa de som.
    const audioTrack = prepararSom(track, stream);
    if (audioTrack) pumpAudio(audioTrack);

    return stream;
  }

  /**
   * Restrições da captura de som.
   *
   * Os tratamentos de voz ficam desligados: existem para microfone e, em som de
   * aplicativo, cortam justamente o que se queria ouvir.
   *
   * restrictOwnAudio tira da captura o que esta própria página está tocando —
   * sem ele, quem transmite enquanto assiste a outra tela devolveria o som dela
   * de volta para a sala, em laço. É experimental, então vai sob detecção.
   */
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

/**
   * Devolve a faixa de som, ou null quando ela traria a call de volta em eco.
   *
   * O nó: o som do sistema é capturado como uma mistura única, e nenhum
   * navegador expõe um jeito de tirar um processo dela. O Windows tem essa API
   * (é assim que o Discord nativo compartilha som sem se ouvir), mas página web
   * não alcança. Então "som da tela inteira" é sempre "som do sistema INTEIRO",
   * com a saída do Discord dentro — e a call inteira se escuta, com atraso.
   *
   * Aba é diferente: o som sai só daquela aba, e o Discord nunca entra.
   *
   * Por isso a mistura do sistema é recusada aqui, antes de sair da máquina. O
   * que evita a versão anterior disto virar um beco sem saída é `trocarSom()`:
   * dá para manter o vídeo da tela inteira e pegar o som de uma aba.
   */
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

  /**
   * Troca só a fonte do som, sem tocar no vídeo.
   *
   * É o que torna som e tela inteira compatíveis: o vídeo continua sendo a tela
   * escolhida e o som passa a vir de uma aba, que é isolada por construção. A
   * segunda janela de escolha é o preço, e é um preço honesto — não há como o
   * navegador adivinhar de qual aplicativo o som deveria vir.
   */
  async function trocarSom() {
    // Precisa vir do gesto do usuário, como qualquer getDisplayMedia.
    const escolha = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: audioConstraints(),
    });

    const faixa = escolha.getAudioTracks()[0];
    const superficie = escolha.getVideoTracks()[0]?.getSettings?.().displaySurface;

    // O vídeo desta escolha não interessa: viemos só pelo som.
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

    // Encerra o laço anterior antes de abrir outro, senão os dois alimentam o
    // mesmo encoder e a fila estoura.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    if (audioEncoder?.state === 'configured') {
      try {
        audioEncoder.close();
      } catch {}
    }
    audioEncoder = null;

    somBloqueado = false;
    faixa.addEventListener('ended', () => onAviso?.('A aba do som foi fechada.'));
    pumpAudio(faixa);
    return faixa;
  }

  // -------------------------------------------------------------------- áudio

  /**
   * Captura, codifica e envia o som.
   *
   * O AudioEncoder recebe os blocos no tamanho que o sistema entregar e devolve
   * pacotes Opus de 20 ms — não é preciso reagrupar nada por fora. Cada pacote
   * se decodifica sozinho, então não existe aqui o equivalente ao keyframe.
   */
  async function pumpAudio(track) {
    if (!window.AudioEncoder || !window.MediaStreamTrackProcessor) return;

    const s = track.getSettings();
    const sampleRate = s.sampleRate || 48_000;
    const numberOfChannels = Math.min(2, s.channelCount || 2);

    try {
      audioEncoder = new AudioEncoder({
        output: onAudioEncoded,
        // Som é acessório: se o encoder cair, a tela continua no ar.
        error: (err) => console.warn('[audio encoder]', err.message),
      });
      audioEncoder.configure({ codec: 'opus', sampleRate, numberOfChannels, bitrate: AUDIO_BITRATE });
    } catch (err) {
      console.warn('[audio encoder]', err.message);
      audioEncoder = null;
      return;
    }

    // O mesmo caminho do vídeo: quem chega depois recebe isto ao pedir a tela.
    ws?.send(
      JSON.stringify({ type: 'audio-config', config: { codec: 'opus', sampleRate, numberOfChannels } })
    );

    audioReader = new MediaStreamTrackProcessor({ track }).readable.getReader();
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

  async function pickConfig(width, height) {
    // Três passadas, da mais específica para a mais tolerante:
    //  1. prefer-hardware (quando o navegador conhece o campo)
    //  2. sem o campo (deixa o navegador decidir)
    //  3. sem latencyMode (navegadores que recusam a config inteira por causa dele)
    // `hardwareAcceleration: 'prefer-hardware'` é um pedido, NUNCA uma prova de
    // que a GPU foi usada — a UI mostra "requested", não o nome do backend.
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
    // Passada final sem latencyMode, caso algum navegador recuse a config por ele.
    for (const candidate of CANDIDATES) {
      variantes.push({ ...candidate, width, height, bitrate, framerate: fps });
    }

    // Diagnóstico de probing: só em modo debug (nunca spam para o usuário).
    // Registra por variante para entendermos POR QUE um codec foi escolhido
    // (ex.: por que VP8 e não H.264).
    const probeLog = [];
    t.probing = [];

    for (const cfg of variantes) {
      let supported = false;
      try {
        ({ supported } = await VideoEncoder.isConfigSupported(cfg));
      } catch {
        supported = false;
      }
      const rotulo = `${cfg.codec} ${cfg.avc?.format ?? 'AVC'}${cfg.hardwareAcceleration ? ' +HW' : ''}${cfg.latencyMode ? ' +realtime' : ''}`;
      probeLog.push(`${rotulo}: ${supported ? 'supported' : 'unsupported'}`);
      t.probing.push({ codec: cfg.codec, hw: cfg.hardwareAcceleration, realtime: Boolean(cfg.latencyMode), supported });
      if (supported) {
        if (DEBUG_PROBING) console.log('[probe]', probeLog.join(' | '));
        t.probingSummary = probeLog.join(' | ');
        return cfg;
      }
    }
    if (DEBUG_PROBING) console.log('[probe] nenhum codec suportado:', probeLog.join(' | '));
    t.probingSummary = probeLog.join(' | ');
    return null;
  }

  // ------------------------------------------------------------------ captura

  function pump(track) {
    if (window.MediaStreamTrackProcessor) pumpDirect(track);
    else pumpViaVideo();
  }

  /** Chromium: acesso direto aos quadros, sem cópia intermediária. */
  async function pumpDirect(track) {
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
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

  /** Demais navegadores: extrai os quadros de um <video> alimentado pela stream. */
  function pumpViaVideo() {
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    // Fora do fluxo mas no DOM: alguns navegadores não decodificam um elemento
    // solto, e display:none chega a pausar a reprodução.
    Object.assign(video.style, {
      position: 'fixed',
      left: '-9999px',
      width: '2px',
      height: '2px',
      opacity: '0',
    });
    document.body.append(video);
    video.play().catch(() => {});

    const t0 = performance.now();
    const hasRvfc = typeof video.requestVideoFrameCallback === 'function';
    const minGap = 1000 / (fps + 2);
    let lastAt = 0;

    const schedule = () => {
      if (!running) return;
      if (hasRvfc) video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };

    const tick = () => {
      if (!running) return;
      // Alguns navegadores pausam ao trocar de aba; sem isso o loop morre em
      // silêncio e a transmissão congela sem erro nenhum.
      if (video.paused) video.play().catch(() => {});
      if (video.readyState < 2 || !video.videoWidth) return schedule();

      const now = performance.now();
      // rAF segue o refresh da tela, que pode ser bem acima do fps alvo.
      if (!hasRvfc && now - lastAt < minGap) return schedule();
      lastAt = now;

      let frame;
      try {
        frame = new VideoFrame(video, { timestamp: (now - t0) * 1000 });
      } catch {
        return schedule();
      }
      encodeFrame(frame);
      schedule();
    };

    schedule();
  }

  function encodeFrame(frame) {
    if (!running || encoder?.state !== 'configured') {
      frame.close();
      return false;
    }
    tel.captured++;

    // Política de fila mensurável (Fase 5), em vez de limite mágico:
    //   0–1: normal
    //   2:   atenção — ainda codifica, mas sinaliza o adaptive controller
    //   >=3: drop seletivo — nunca acumular atraso
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

    // submittedFrames: encoder.encode chamado com sucesso.
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

    // encodedFrames é incrementado em onEncoded (Bug 3): só quando o encoder
    // REALMENTE produziu um chunk. Isso diferencia submitted (pedido) de
    // encoded (produzido) e revela gargalo real de encoder (capture 60,
    // submitted 60, encoded 43).

    // Sinaliza pressão de fila ao adaptive (não cai no drop seletivo ainda).
    if (q >= 2) adaptive.onPressure('encode-queue', q);
    return true;
  }

  /** Aplica um novo bitrate ao encoder e força keyframe. */
  function applyBitrate(novoBitrate) {
    if (encoder?.state !== 'configured') return;
    config = { ...config, bitrate: novoBitrate };
    encoder.configure(config);
    wantKeyframe = true;
  }

  /**
   * Mantém o encoder casado com o tamanho real da fonte.
   *
   * displayWidth/Height e não codedWidth/Height: o codificado inclui padding de
   * alinhamento do codec, e configurar o encoder por ele faz recortar as bordas.
   */
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
      // Bug 5: mesma estrutura de status em todo reconfigure — nunca omitir
      // hardwareAcceleration/transport/mode/hint.
      emitStatus();
    }

    // fitWithin preserva a proporção, então reduzir não corta nada.
    if (target.width === sw && target.height === sh) {
      stage = null;
      stageCtx = null;
    } else {
      stage = document.createElement('canvas');
      stage.width = target.width;
      stage.height = target.height;
      stageCtx = stage.getContext('2d', { alpha: false, desynchronized: true });
    }
  }

  function onEncoded(chunk, metadata) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    // Bug 3: encodedFrames é contado aqui — quando o encoder REALMENTE produziu
    // um chunk — e não logo após encoder.encode(). Isso separa submitted
    // (pedido) de encoded (produzido) e revela gargalo real de encoder.
    tel.encoded++;

    // O decoderConfig chega no primeiro chunk e sempre que a config muda.
    if (metadata?.decoderConfig) {
      ws.send(JSON.stringify({ type: 'config', config: serializeConfig(metadata.decoderConfig) }));
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

  /**
   * [1B slot][1B tipo][8B timestamp][8B relógio de envio][payload]
   *
   * O slot vem carimbado na origem para o servidor repassar o buffer intacto, e
   * o relógio de envio é o que permite medir o atraso do outro lado. Áudio e
   * vídeo compartilham o formato: o tipo é a única coisa que os distingue.
   */
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

  // ---------------------------------------------------------------- websocket

  function connect() {
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
        // Alguém entrou na sala e precisa de um ponto de partida.
        else if (msg.type === 'need-keyframe') wantKeyframe = true;
        // Fase 7 — resumo do feedback dos viewers (agregado pelo servidor).
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

  // -------------------------------------------------------------------- parar

  // ------------------------------------------------------------ ao vivo

  /**
   * Troca a tela compartilhada sem derrubar a transmissão.
   *
   * A conexão, o encoder e o slot continuam os mesmos — quem assiste só vê a
   * imagem mudar, sem piscar nem reconectar.
   */
  async function changeScreen() {
    // Precisa vir do gesto do usuário, como qualquer getDisplayMedia.
    const fresh = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps } },
      audio: audio ? audioConstraints() : false,
    });

    const previous = stream;
    const previousReader = reader;

    stream = fresh;
    const track = fresh.getVideoTracks()[0];
    if (hint) track.contentHint = hint;
    track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));

    // Encerra o loop anterior antes de abrir outro, senão os dois disputam o
    // encoder e a fila estoura.
    reader = null;
    await previousReader?.cancel().catch(() => {});
    previous?.getTracks().forEach((t) => t.stop());

    // Zera o tamanho conhecido: a tela nova quase certamente tem outro, e é o
    // syncSize que reconfigura o encoder.
    srcW = 0;
    srcH = 0;
    wantKeyframe = true;

    if (video) {
      video.srcObject = fresh;
      video.play().catch(() => {});
    } else {
      pumpDirect(track);
    }

    // A tela nova traz a própria faixa de som; a antiga morreu com o stream.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    const novoAudio = prepararSom(track, fresh);
    if (novoAudio && audioEncoder) pumpAudio(novoAudio);

    return fresh;
  }

  /** Ajusta qualidade e taxa de quadros com a transmissão no ar. */
  function setQuality({ bitrate: nextBitrate, fps: nextFps } = {}) {
    if (nextBitrate) {
      bitrate = nextBitrate;
      adaptive.reset(nextBitrate); // novo teto; currentBitrate volta para ele
    }
    if (nextFps) fps = nextFps;
    if (encoder?.state !== 'configured') return;

    config = { ...config, bitrate: adaptive.currentBitrate, framerate: fps };
    encoder.configure(config);
    wantKeyframe = true;

    // Pedir a taxa nova à própria captura evita gastar CPU codificando quadros
    // que seriam descartados adiante.
    stream
      ?.getVideoTracks()[0]
      ?.applyConstraints({ frameRate: { ideal: fps, max: fps } })
      .catch(() => {});
  }

  const getSettings = () => ({ bitrate, fps });

  function cleanup() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video?.remove();
    video = null;
    stage = null;
    stageCtx = null;
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

    cleanup();
    if (wasRunning) onEnd?.(reason ?? '');
  }

  return {
    start,
    stop,
    changeScreen,
    trocarSom,
    setQuality,
    getSettings,
    getTelemetry: () => lastTelemetry ?? null,
    temSom: () => Boolean(audioEncoder),
    somBloqueado: () => somBloqueado,
    isRunning: () => running,
    getMode: () => mode,
  };
}
