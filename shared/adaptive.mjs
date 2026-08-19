/**
 * AdaptiveQualityController (Bug 4).
 *
 * Controla o bitrate de forma adaptativa: DEGRADA rápido sob pressão e
 * RECUPERA devagar quando estável, com cooldown/hysteresis para não oscilar.
 * Nunca ultrapassa o bitrate escolhido pelo usuário/perfil (initialBitrate).
 *
 * Módulo puro (sem dependência de browser) — testável de ponta a ponta.
 *
 * Comportamento:
 *   PRESSÃO:  desce relativamente rápido (ex.: 12 → 9 → 6.75)
 *   ESTÁVEL:  sobe lentamente (ex.: 6.75 → 7.5 → 8.25 → ... → máx 12)
 *   Não sobe se: encoder queue alta, bufferedAmount alto, encode FPS baixo,
 *   ou viewer feedback ruim.
 */

// Fatores de descida e subida. Descida mais agressiva que subida.
const DOWN_FACTOR = 0.75;
const UP_FACTOR = 1.1;
// Piso absoluto: não vale a pena mandar vídeo inútil.
const MIN_BITRATE = 500_000;

// Cooldowns (ms) e janelas.
const DOWN_COOLDOWN_MS = 2000; // entre descidas
const UP_COOLDOWN_MS = 3000; // entre subidas
// Janelas de estabilidade exigidas antes de subir (número de ticks bons).
const STABLE_TICKS_REQUIRED = 5;

// Limiares para NÃO subir.
const MAX_QUEUE_TO_UP = 2; // queue >= 2 bloqueia subida
const MAX_BUFFERED_TO_UP = 1.5 * 1024 * 1024; // buffered alto bloqueia subida
const MIN_ENCODE_FPS_RATIO = 0.75; // encode FPS abaixo de 75% do alvo bloqueia subida

/**
 * @param {object} opts
 * @param {number} opts.initialBitrate  bitrate escolhido pelo usuário/perfil
 * @param {number} [opts.targetFps]     FPS alvo (para julgar encode FPS baixo)
 * @param {(newBitrate:number)=>void} [opts.onApply]  aplica o novo bitrate no encoder
 * @param {(msg:string)=>void} [opts.onChange]        aviso de mudança (opcional)
 */
export function createAdaptiveController({ initialBitrate, targetFps = 60, onApply, onChange }) {
  let currentBitrate = initialBitrate;
  let lastDownAt = 0;
  let lastUpAt = 0;
  let stableTicks = 0;

  function clamp(b) {
    return Math.max(MIN_BITRATE, Math.min(initialBitrate, Math.round(b)));
  }

  function apply(b) {
    const next = clamp(b);
    if (next === currentBitrate) return false;
    currentBitrate = next;
    onApply?.(next);
    return true;
  }

  /** Sinal de pressão (fila alta, drop, feedback ruim) — desce rápido. */
  function onPressure(source) {
    const now = Date.now();
    if (now - lastDownAt < DOWN_COOLDOWN_MS) return false;
    if (currentBitrate <= MIN_BITRATE) return false;
    lastDownAt = now;
    lastUpAt = now;
    stableTicks = 0; // pressão zera a contagem de estabilidade
    const changed = apply(currentBitrate * DOWN_FACTOR);
    if (changed) {
      onChange?.(
        `Rede/encoder sob pressão (${source}) — bitrate ${(currentBitrate / 1e6).toFixed(1)} Mbps. ` +
          `Recupera sozinho quando estabilizar.`
      );
    }
    return changed;
  }

  /**
   * Tick de telemetria (~1x/s). Se a janela está estável (sem pressão), sobe
   * devagar depois de STABLE_TICKS_REQUIRED janelas boas consecutivas.
   */
  function onTick(sample = {}) {
    const now = Date.now();
    // Não subir se ainda está sob pressão recente.
    if (now - lastDownAt < DOWN_COOLDOWN_MS * 3) return;
    if (now - lastUpAt < UP_COOLDOWN_MS) return;

    // Não subir se as métricas indicam que não dá.
    if (sample.encoderQueueSize >= MAX_QUEUE_TO_UP) return;
    if ((sample.bufferedAmount ?? 0) > MAX_BUFFERED_TO_UP) return;
    const alvo = sample.targetFps || targetFps;
    if (sample.encodedFps > 0 && sample.encodedFps < alvo * MIN_ENCODE_FPS_RATIO) return;
    if (sample.feedback?.congestedViewers > 0) return;

    stableTicks++;
    if (stableTicks < STABLE_TICKS_REQUIRED) return;
    if (currentBitrate >= initialBitrate) {
      stableTicks = 0;
      return;
    }
    stableTicks = 0;
    lastUpAt = now;
    const changed = apply(currentBitrate * UP_FACTOR);
    if (changed) {
      onChange?.(`Qualidade recuperada — bitrate ${(currentBitrate / 1e6).toFixed(1)} Mbps.`);
    }
    return changed;
  }

  return {
    onPressure,
    onTick,
    /**
     * Reinicia o teto quando o usuário muda a qualidade manualmente (setQuality).
     * `initialBitrate` vira o novo teto; `currentBitrate` volta para ele.
     */
    reset(newInitial) {
      initialBitrate = newInitial;
      currentBitrate = newInitial;
      lastDownAt = 0;
      lastUpAt = 0;
      stableTicks = 0;
      onApply?.(newInitial);
    },
    get currentBitrate() {
      return currentBitrate;
    },
    get initialBitrate() {
      return initialBitrate;
    },
    // expostos para teste
    _clamp: clamp,
    _apply: apply,
  };
}
