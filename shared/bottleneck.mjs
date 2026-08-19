/**
 * Classificação do gargalo do pipeline (browser V2).
 *
 * Módulo puro (sem dependência de browser) — testável. Regras conceituais:
 *
 *   CAPTURE LIMITED : capture FPS abaixo do target.
 *   ENCODER LIMITED : capture saudável, mas encoded significativamente menor
 *                     que o alvo OU encoder queue alta.
 *   NETWORK LIMITED : encoder saudável, mas bufferedAmount/backpressure cresce.
 *   VIEWER LIMITED  : sender/relay saudável, mas rendered FPS do viewer cai.
 *   HEALTHY         : nenhum gargalo significativo.
 *
 * Nunca reduzir em silêncio: se o FPS real ficar abaixo do alvo, aponta onde.
 */

const HEALTHY = 'HEALTHY';
const CAPTURE_LIMITED = 'CAPTURE LIMITED';
const ENCODER_LIMITED = 'ENCODER LIMITED';
const NETWORK_LIMITED = 'NETWORK LIMITED';
const VIEWER_LIMITED = 'VIEWER LIMITED';

// Limiares.
const TARGET_RATIO_OK = 0.9; // capture >= 90% do alvo = saudável
const FPS_LOW_RATIO = 0.7; // abaixo de 70% do alvo = limitado
const QUEUE_HIGH = 3; // queue >= 3 = encoder atrasado
const BUFFERED_HIGH = 2 * 1024 * 1024; // 2 MB de backpressure = rede

/**
 * @param {object} sample
 * @param {number} [sample.captureFps]
 * @param {number} [sample.encodedFps]
 * @param {number} [sample.encoderQueueSize]
 * @param {number} [sample.bufferedAmount]
 * @param {object} [sample.feedback] { worstRenderedFps?, congestedViewers? }
 * @param {number} [targetFps] FPS alvo (default 60)
 * @returns {string}
 */
export function identifyBottleneck(sample = {}, targetFps = 60) {
  const target = targetFps || 60;

  if ((sample.encoderQueueSize ?? 0) >= QUEUE_HIGH) return ENCODER_LIMITED;
  if (sample.captureFps >= target * TARGET_RATIO_OK && sample.encodedFps > 0 && sample.encodedFps < target * FPS_LOW_RATIO) {
    return ENCODER_LIMITED;
  }
  if (sample.captureFps > 0 && sample.captureFps < target * FPS_LOW_RATIO) return CAPTURE_LIMITED;
  if ((sample.bufferedAmount ?? 0) > BUFFERED_HIGH) return NETWORK_LIMITED;
  if (sample.feedback?.worstRenderedFps && sample.feedback.worstRenderedFps < target * FPS_LOW_RATIO) {
    return VIEWER_LIMITED;
  }
  return HEALTHY;
}

export const BOTTLENECKS = { HEALTHY, CAPTURE_LIMITED, ENCODER_LIMITED, NETWORK_LIMITED, VIEWER_LIMITED };
