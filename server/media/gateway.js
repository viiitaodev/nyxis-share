/**
 * Media gateway do caminho nativo.
 *
 * Conecta as pontas: SRT → H.264 Annex B → relay existente (WebSocket).
 *
 *   ffmpeg (listener SRT, -c:v copy)  →  parser H.264  →  WS broadcaster
 *
 * O gateway abre um WebSocket **real** para o próprio relay, como o browser
 * faria, com um broadcasterToken emitido na criação da sessão. Assim `rooms.js`
 * e o player WebCodecs da Activity não mudam: o stream nativo é idêntico ao do
 * navegador (mesmo slot, mesmo formato de pacote, mesma máquina de keyframe).
 *
 * A VPS **nunca transcodifica**: o ffmpeg aqui só demuxa (`-c:v copy`), e o
 * comando é logado para auditoria.
 *
 * Ciclo de vida:
 *  - reconexão: queda curta é retransmissão do SRT e o ffmpeg nem sai; queda
 *    longa faz o ffmpeg sair e o listener é **ressubido** na mesma porta
 *    enquanto a sessão estiver ativa;
 *  - teardown: `stop()` mata o ffmpeg (sem zombie), fecha o WS, e o index.js
 *    remove a sessão e libera a porta.
 */

import WebSocket from 'ws';
import { spawnSrtListener, srtListenerUrl } from '../transport/srt.mjs';
import { createH264Parser, buildAvcC, codecFromSps, parseSps, removeEmulationPrevention } from '../../shared/protocol/h264.mjs';
import { empacotarQuadro, TIPO_KEYFRAME, TIPO_DELTA } from '../../shared/protocol/packet.mjs';

const MAX_RESPAWNS = 5;
const RESPAWN_DELAY_MS = 1500;
const PENDING_CAP = 60; // fila de AUs esperando o slot — além disso, vive > perfeição

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

function buildConfig(au) {
  const sps = removeEmulationPrevention(au.sps);
  const pps = removeEmulationPrevention(au.pps);
  const info = parseSps(sps);
  const avc = buildAvcC(sps, pps);
  if (!avc) return null;
  return {
    codec: codecFromSps(info.profile, info.level),
    codedWidth: info.width,
    codedHeight: info.height,
    description: b64(avc),
    source: 'native',
  };
}

function sameConfig(a, b) {
  return Boolean(a && b && a.codec === b.codec && a.description === b.description);
}

/**
 * @param {object} opts
 * @param {object} opts.session          sessão de ingest (server/ingest/session.js)
 * @param {number} opts.appPort          porta HTTP/WS do próprio servidor
 * @param {(reason:string)=>void} opts.onSessionEnd  encerra a sessão inteira
 * @param {(line:string)=>void} [opts.onLog]
 * @returns {{ stop: () => void }}
 */
export function startIngestGateway({ session, appPort, onSessionEnd, onLog = () => {} }) {
  let stopping = false;
  let listener = null;
  let ws = null;
  let wsOpened = false;
  let slot = null;
  let started = false;
  let config = null;
  let configSent = false;
  let parser = null;
  let streamStartAt = 0;
  let respawnCount = 0;
  let respawnTimer = null;
  let pending = [];

  const log = (msg) => onLog(`[native-ingest session=${session.id}] ${msg}`);

  const wsUrl = () => `ws://127.0.0.1:${appPort}/ws?t=${encodeURIComponent(session.broadcasterToken)}`;

  // ------------------------------------------------------------- ws → relay

  function ensureWs() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (stopping) return;
    ws = new WebSocket(wsUrl());
    wsOpened = false;
    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
      wsOpened = true;
      log('broadcaster conectado ao relay');
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'slot') {
        slot = msg.slot;
        onSlot();
      } else if (msg.type === 'stop-request') {
        // A Activity (dona da transmissão) pediu para parar.
        log('stop-request recebido da atividade');
        onSessionEnd('parado-pela-atividade');
      } else if (msg.type === 'error') {
        log(`erro do relay: ${msg.message}`);
      }
    });

    ws.on('close', () => {
      const was = ws;
      ws = null;
      slot = null;
      started = false;
      configSent = false;
      pending = [];
      if (stopping) return;
      if (!wsOpened) {
        // Não abriu: token recusado ou sala já era — não há o que reconectar.
        log('conexão de broadcaster recusada — encerrando sessão');
        onSessionEnd('broadcaster-rejeitado');
        return;
      }
      log('conexão de broadcaster caiu — reconecta no próximo quadro');
    });

    ws.on('error', () => {});
  }

  function onSlot() {
    if (stopping) return;
    if (!started) {
      ws.send(JSON.stringify({ type: 'start' }));
      started = true;
      log('stream iniciada no relay');
    }
    if (config && !configSent) {
      sendConfig();
    }
    const pendingToSend = pending;
    pending = [];
    for (const au of pendingToSend) sendAu(au);
  }

  function sendConfig() {
    ws.send(JSON.stringify({ type: 'config', config }));
    configSent = true;
    log(
      `codec=${config.codec} resolution=${config.codedWidth}x${config.codedHeight} ` +
        `source=${config.source}`
    );
  }

  function sendAu(au) {
    if (stopping || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (!started) return;
    if (config && !configSent) sendConfig();
    const ts = (Date.now() - streamStartAt) * 1000;
    ws.send(
      empacotarQuadro(slot, au.isKeyframe ? TIPO_KEYFRAME : TIPO_DELTA, ts, au.bytes),
      { binary: true }
    );
  }

  // ----------------------------------------------------------- ffmpeg → au

  function onData(chunk) {
    parser.feed(chunk);
  }

  function onAu(au) {
    if (stopping) return;
    if (!au.isKeyframe) return; // o relay precisa de keyframe para destravar

    if (respawnCount > 0) {
      respawnCount = 0;
      log('listener recuperado — ressubindo contador de tentativas');
    }
    if (streamStartAt === 0) streamStartAt = Date.now();

    if (au.sps && au.pps) {
      const novo = buildConfig(au);
      if (novo && !sameConfig(novo, config)) {
        config = novo;
        configSent = false;
        log(`config nova: ${novo.codec} ${novo.codedWidth}x${novo.codedHeight}`);
      }
    }

    if (slot === null) {
      ensureWs();
      if (pending.length >= PENDING_CAP) pending.shift();
      pending.push(au);
      return;
    }
    sendAu(au);
  }

  function spawnListener() {
    if (stopping) return;
    log(`abrindo listener SRT em ${srtListenerUrl(session).port}`);
    try {
      listener = spawnSrtListener({
        port: session.port,
        onLog: (line) => log(line),
        onData,
        onExit: (code, signal) => onListenerExit(code, signal),
      });
    } catch (err) {
      log(`não deu para subir o listener: ${err.message}`);
      onSessionEnd('listener-falhou');
    }
  }

  function onListenerExit(code, signal) {
    listener = null;
    if (stopping) return;
    log(`ffmpeg saiu (code=${code} signal=${signal}) — encerrando stream e reabrindo porta`);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
      try {
        ws.close();
      } catch {}
    }
    ws = null;
    slot = null;
    started = false;
    configSent = false;
    pending = [];
    streamStartAt = 0;
    respawnCount++;
    if (respawnCount > MAX_RESPAWNS) {
      log('listener falhou repetidamente — encerrando sessão');
      onSessionEnd('listener-falhou');
      return;
    }
    respawnTimer = setTimeout(spawnListener, RESPAWN_DELAY_MS);
    respawnTimer.unref?.();
  }

  // ------------------------------------------------------------------ teardown

  function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(respawnTimer);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'stop' }));
      } catch {}
      try {
        ws.close();
      } catch {}
    }
    ws = null;
    if (listener) {
      try {
        listener.kill('SIGTERM');
      } catch {}
      // Garantia anti-zombie: se o SIGTERM não resolver, força o kill.
      setTimeout(() => {
        try {
          listener?.kill('SIGKILL');
        } catch {}
      }, 1500).unref?.();
    }
    listener = null;
    log('gateway encerrado');
  }

  parser = createH264Parser();
  parser.onAu = onAu;
  spawnListener();

  return { stop };
}
