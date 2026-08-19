/**
 * EncoderBackend: opções de baixa latência por encoder.
 *
 * O Sender detecta os encoders disponíveis nesta ordem (probing real, nunca
 * suposição):
 *
 *   NVIDIA NVENC (h264_nvenc) → AMD AMF (h264_amf) → Intel QSV (h264_qsv)
 *   → software (libx264)
 *
 * Configuração **por encoder** — opções específicas de NVENC não são copiadas
 * para AMF/QSV. Objetivos comuns: B-frames desligados, lookahead mínimo, GOP
 * curto e CBR/constrained VBR.
 */
import { gopFor } from './profiles.mjs';

export const ENCODER_ORDER = [
  { id: 'nvenc', name: 'h264_nvenc', label: 'NVIDIA NVENC' },
  { id: 'amf', name: 'h264_amf', label: 'AMD AMF' },
  { id: 'qsv', name: 'h264_qsv', label: 'Intel Quick Sync' },
  { id: 'x264', name: 'libx264', label: 'libx264 (software)' },
];

/**
 * @param {string} id nvenc|amf|qsv|x264
 * @param {{width:number,height:number,fps:number,bitrate:number,min:number,max:number}} p
 */
export function encoderArgs(id, p) {
  const gop = gopFor(p.fps);
  const max = Math.round(p.bitrate * 1.2);
  const buf = Math.round(p.bitrate);
  const bit = String(p.bitrate);

  switch (id) {
    case 'nvenc':
      return [
        '-c:v', 'h264_nvenc',
        '-preset', 'p1', // mais rápido; baixa latência
        '-tune', 'll',
        '-rc', 'vbr',
        '-b:v', bit,
        '-maxrate', String(max),
        '-bufsize', String(buf),
        '-g', String(gop),
        '-keyint_min', String(gop),
        '-bf', '0',
        '-rc-lookahead', '0',
      ];
    case 'amf':
      return [
        '-c:v', 'h264_amf',
        '-usage', 'lowlatency',
        '-quality', 'speed',
        '-rc', 'cbr',
        '-b:v', bit,
        '-g', String(gop),
        '-bf', '0',
      ];
    case 'qsv':
      return [
        '-c:v', 'h264_qsv',
        '-preset', 'veryfast',
        '-rc', 'CBR',
        '-b:v', bit,
        '-maxrate', String(max),
        '-bufsize', String(buf),
        '-g', String(gop),
        '-bf', '0',
        '-look_ahead', '0',
        '-low_power', '1',
      ];
    case 'x264':
      return [
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-profile:v', 'high',
        '-b:v', bit,
        '-maxrate', String(max),
        '-bufsize', String(buf),
        '-g', String(gop),
        '-keyint_min', String(gop),
        '-x264-params', 'bframes=0:scenecut=0',
      ];
    default:
      throw new Error(`encoder desconhecido: ${id}`);
  }
}