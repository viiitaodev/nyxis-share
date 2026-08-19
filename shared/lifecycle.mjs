/**
 * Ciclo de vida da transmissão (browser V2, fix pós-DedicatedWorker).
 *
 * Estados claros da pipeline, do gesto do usuário até a mídia de fato rodando.
 * `broadcaster.start()` só resolve em STREAM_READY — antes disso nada é
 * anunciado como "no ar". Módulo puro (sem dependência de browser), testável.
 */
export const PHASES = {
  // Gesto do usuário ainda nem aconteceu / worker ainda não subiu.
  INITIALIZING: 'INITIALIZING',
  // getDisplayMedia devolveu a tela escolhida.
  CAPTURE_ACQUIRED: 'CAPTURE_ACQUIRED',
  // WebSocket do transmissor conectado ao relay.
  TRANSPORT_CONNECTED: 'TRANSPORT_CONNECTED',
  // VideoEncoder configurado com codec/resolução.
  ENCODER_READY: 'ENCODER_READY',
  // Lendo quadros da captura (reader/pump ativos).
  CAPTURE_PUMPING: 'CAPTURE_PUMPING',
  // Primeiro quadro entregue ao encoder.
  FIRST_FRAME_SUBMITTED: 'FIRST_FRAME_SUBMITTED',
  // Primeiro chunk codificado (e decoderConfig disponível).
  FIRST_FRAME_ENCODED: 'FIRST_FRAME_ENCODED',
  // Config + stream-start já enviados ao servidor; a pipeline produz mídia.
  STREAM_READY: 'STREAM_READY',
};

export const PHASE_ORDER = [
  PHASES.INITIALIZING,
  PHASES.CAPTURE_ACQUIRED,
  PHASES.TRANSPORT_CONNECTED,
  PHASES.ENCODER_READY,
  PHASES.CAPTURE_PUMPING,
  PHASES.FIRST_FRAME_SUBMITTED,
  PHASES.FIRST_FRAME_ENCODED,
  PHASES.STREAM_READY,
];

const INDEX = new Map(PHASE_ORDER.map((p, i) => [p, i]));

/** True apenas em STREAM_READY — a única fase em que há mídia produzida. */
export function isStreamReady(phase) {
  return phase === PHASES.STREAM_READY;
}

/** Ordem relativa entre duas fases: negativo = a<b, 0 = igual, positivo = a>b. */
export function comparePhases(a, b) {
  return (INDEX.get(a) ?? -1) - (INDEX.get(b) ?? -1);
}

/** Fase posterior à dada (por ex. para aguardar a próxima etapa). */
export function nextPhase(phase) {
  const i = INDEX.get(phase) ?? -1;
  return PHASE_ORDER[i + 1] ?? null;
}