/**
 * CaptureBackend: abstração da captura de tela no Windows.
 *
 * No MVP o motor é o FFmpeg (ddagrab preferido, gdigrab fallback). A interface
 * existe para, mais tarde, trocar por Windows Graphics Capture / Desktop
 * Duplication API sem tocar no resto do Sender.
 */
import { spawn } from 'node:child_process';
import { ffmpegCommand } from './ffmpeg.mjs';

/** Descobre se o demuxer ddagrab (Desktop Duplication) existe no ffmpeg. */
export async function detectCaptureBackend() {
  const [bin, ...prefix] = ffmpegCommand();
  const ok = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, [...prefix, '-hide_banner', '-h', 'demuxer=ddagrab'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(false), 4000);
    child.on('error', () => resolve(false));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
  return ok ? 'ddagrab' : 'gdigrab';
}

/**
 * Args de entrada da captura. `monitor` pode ser 'desktop' (padrão) ou um
 * número (índice de monitor, ddagrab apenas).
 */
export function captureArgs(backend, { fps, monitor }) {
  const src = backend === 'ddagrab' ? String(monitor ?? 'desktop') : 'desktop';
  if (backend === 'ddagrab') {
    return ['-f', 'ddagrab', '-framerate', String(fps), '-draw_mouse', '1', '-i', src];
  }
  return ['-f', 'gdigrab', '-framerate', String(fps), '-i', src];
}

/**
 * Filtro de escala para caber no perfil preservando a proporção.
 * Altura `-2` garante par (obrigatório para H.264); largura limitada pelo
 * perfil, sem esticar telas menores que o alvo.
 */
export function scaleFilter(width) {
  return `scale='min(${width},iw)':-2:force_original_aspect_ratio=decrease,setsar=1`;
}