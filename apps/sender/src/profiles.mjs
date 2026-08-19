/**
 * Perfis de qualidade do modo nativo.
 *
 * Valores iniciais (configuráveis via CLI e via env); nunca tratados como
 * limites rígidos — são o ponto de partida do encode.
 */
export const PROFILES = {
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 4_000_000, min: 3_000_000, max: 5_000_000 },
  '720p60': { width: 1280, height: 720, fps: 60, bitrate: 6_000_000, min: 5_000_000, max: 7_000_000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 6_500_000, min: 5_000_000, max: 8_000_000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 10_000_000, min: 8_000_000, max: 15_000_000 },
};

export function parseBitrate(raw) {
  if (typeof raw === 'number' && raw > 0) return raw;
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(k|m|g)?$/i);
  if (!m) return null;
  const mult = { k: 1_000, m: 1_000_000, g: 1_000_000_000 }[m[2]?.toLowerCase() ?? ''] ?? 1_000_000;
  return Math.round(Number(m[1]) * mult);
}

export function formatBitrate(bits) {
  if (bits >= 1_000_000) return `${(bits / 1_000_000).toFixed(1)} Mbps`;
  if (bits >= 1_000) return `${Math.round(bits / 1_000)} kbps`;
  return `${bits} bps`;
}

/** GOP curto: keyframe a cada 2 segundos — recuperação rápida para quem entra. */
export function gopFor(fps) {
  return Math.max(2, Math.round(fps) * 2);
}