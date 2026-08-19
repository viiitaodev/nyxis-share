/**
 * Modos de conteúdo e perfis de qualidade (browser V2).
 *
 * Módulo puro (sem dependência de browser) para a lógica que a UI e o
 * broadcaster compartilham: decidir o contentHint pelo modo e resolver perfis
 * de qualidade. Testável de ponta a ponta.
 */

/** Modos suportados. */
export const MODES = ['auto', 'motion', 'text'];

/**
 * ContentHint efetivo para um modo.
 * - motion → 'motion' (jogos/movimento: prioriza FPS e fluidez)
 * - text   → 'text'   (UI/trabalho: prioriza nitidez de bordas)
 * - auto   → null     (deixa o navegador decidir; comportamento equilibrado)
 */
export function contentHintFor(mode) {
  if (mode === 'motion') return 'motion';
  if (mode === 'text') return 'text';
  return null;
}

/**
 * Perfis de qualidade por modo. Valores são ponto de partida, nunca garantia —
 * o adaptive bitrate ajusta em tempo real. `bitrate` é o alvo inicial.
 */
export const PROFILES = {
  auto: {
    label: 'Automático',
    contentHint: null,
    options: [
      { label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 },
      { label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 6_500_000 },
      { label: '720p · 60 fps', width: 1280, height: 720, fps: 60, bitrate: 6_000_000 },
      { label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 4_000_000 },
    ],
  },
  motion: {
    label: 'Jogos / Movimento',
    contentHint: 'motion',
    options: [
      { label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 12_000_000 },
      { label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 },
      { label: '720p · 60 fps', width: 1280, height: 720, fps: 60, bitrate: 7_000_000 },
      { label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 5_000_000 },
    ],
  },
  text: {
    label: 'Texto / Trabalho',
    contentHint: 'text',
    options: [
      { label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
      { label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 5_000_000 },
      { label: '720p · 60 fps', width: 1280, height: 720, fps: 60, bitrate: 5_000_000 },
      { label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
    ],
  },
};

/** Resolve um perfil pelo modo + índice (0..3). */
export function resolveProfile(mode, index) {
  const resolved = PROFILES[mode] ? mode : 'auto';
  const m = PROFILES[resolved];
  const opt = m.options[index] ?? m.options[0];
  return { mode: resolved, contentHint: m.contentHint, ...opt };
}
