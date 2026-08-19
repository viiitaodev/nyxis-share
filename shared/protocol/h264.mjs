/**
 * Parser H.264 (Annex B) para o caminho nativo.
 *
 * O gateway recebe do FFmpeg um fluxo H.264 cru (Annex B) no stdout — NAL units
 * separadas por start codes `00 00 01` / `00 00 00 01`. Este módulo faz o
 * trabalho que o relay não deve fazer com heurística frágil:
 *
 *   - separa NAL units pelo start code;
 *   - remove emulation prevention e lê SPS (profile/level/resolução);
 *   - monta o `avcC` (description) e a string `avc1.xxxxxx` do codec;
 *   - agrupa NAL units em Access Units (AUs);
 *   - detecta IDR/keyframe de forma determinística (tipo de NAL, não regex).
 *
 * É um módulo puro: não toca em rede, FFmpeg nem navegador, e por isso é
 * testável de ponta a ponta com bytes sintéticos (ver h264.test.mjs).
 *
 * Formato decidido (documentado em docs/NATIVE_MEDIA_PROTOCOL.md): as AUs
 * seguem o mesmo anexo B já usado pelo broadcaster do navegador, com a
 * `description` avcC via config. O AUD é consumido aqui e não viaja (é só
 * delimitador); SPS/PPS viajam dentro da AU de keyframe junto com o IDR.
 */

// ------------------------------------------------------------------- NAL type

export const NAL = Object.freeze({
  SLICE_NON_IDR: 1,
  SLICE_DATA_A: 2,
  SLICE_DATA_B: 3,
  SLICE_DATA_C: 4,
  SLICE_IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
  AUD: 9,
  END_SEQUENCE: 10,
  END_STREAM: 11,
  FILLER: 12,
});

const isVcl = (t) => t >= 1 && t <= 5;
const isSpsPps = (t) => t === NAL.SPS || t === NAL.PPS;

/** Remove o emulation prevention (0x03 após 0x0000) de um RBSP. */
export function removeEmulationPrevention(bytes) {
  if (bytes.length < 3) return bytes;
  const out = new Uint8Array(bytes.length);
  let o = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (i >= 2 && bytes[i] === 0x03 && bytes[i - 1] === 0x00 && bytes[i - 2] === 0x00) {
      continue;
    }
    out[o++] = bytes[i];
  }
  return out.subarray(0, o);
}

// ------------------------------------------------------------------ bit reader

/** Leitor de bits (big-endian) com Exp-Golomb, sobre um RBSP já decodificado. */
class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0; // em bits
  }

  readBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.pos >> 3];
      if (byte === undefined) break;
      const bit = (byte >> (7 - (this.pos & 7))) & 1;
      v = (v << 1) | bit;
      this.pos++;
    }
    return v;
  }

  ue() {
    let zeros = 0;
    while (this.readBits(1) === 0 && zeros < 64) zeros++;
    if (zeros === 64) return 0;
    return (1 << zeros) - 1 + this.readBits(zeros);
  }

  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

/**
 * Lê um SPS e devolve o que o relay precisa. `sps` é o corpo da NAL **sem**
 * o header de NAL (sem o byte de tipo) e com emulation prevention já removido.
 */
export function parseSps(sps) {
  const r = new BitReader(sps);
  const profileIdc = r.readBits(8);
  r.readBits(8); // constraint flags + reserved
  const levelIdc = r.readBits(8);
  r.ue(); // seq_parameter_set_id

  // SPS com perfil alto/extendido tem campos extras antes do que interessa.
  const high = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
  if (high.includes(profileIdc)) {
    const chromaFormat = r.ue();
    if (chromaFormat === 3) r.readBits(1);
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.readBits(1); // qpprime_y_zero_transform_bypass_flag
    if (r.readBits(1)) {
      // seq_scaling_matrix_present_flag
      const count = chromaFormat !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) {
        if (r.readBits(1)) {
          const size = i < 6 ? 16 : 64;
          for (let j = 0; j < size; j++) r.se();
        }
      }
    }
  }

  r.ue(); // log2_max_frame_num_minus4
  const picOrderCntType = r.ue();
  if (picOrderCntType === 0) r.ue();
  else if (picOrderCntType === 1) {
    r.readBits(1);
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.readBits(1); // gaps_in_frame_num_value_allowed_flag

  const mbW = r.ue() + 1;
  const mbH = r.ue() + 1;
  const frameMbsOnly = r.readBits(1);
  if (!frameMbsOnly) r.readBits(1);
  r.readBits(1); // direct_8x8_inference_flag

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (r.readBits(1)) {
    cropLeft = r.ue();
    cropRight = r.ue();
    cropTop = r.ue();
    cropBottom = r.ue();
  }

  const width = mbW * 16 - (cropLeft + cropRight) * 2;
  // frameMbsOnly=0 é interlaced: altura em map units dobra.
  const height = mbH * 16 * (frameMbsOnly ? 1 : 2) - (cropTop + cropBottom) * 2;

  return { profile: profileIdc, level: levelIdc, width, height };
}

// ------------------------------------------------------------------ avcC/codec

const hex2 = (n) => n.toString(16).padStart(2, '0');
const hex2up = (n) => n.toString(16).padStart(2, '0').toUpperCase();

/** String do codec no formato avc1.PPCCLL, derivada do SPS. */
export function codecFromSps(profile, level, compatibility = 0) {
  return `avc1.${hex2up(profile)}${hex2up(compatibility)}${hex2up(level)}`;
}

/**
 * Monta o box avcC a partir dos corpos de SPS e PPS (sem header de NAL).
 * É a `description` que o WebCodecs espera junto com a string do codec.
 */
export function buildAvcC(sps, pps) {
  if (sps.length < 4 || !pps.length) return null;
  const len = 7 + 2 + sps.length + 1 + 2 + pps.length;
  const out = new Uint8Array(len);
  out[0] = 0x01; // configurationVersion
  out[1] = sps[0]; // AVCProfileIndication
  out[2] = sps[1]; // profile_compatibility
  out[3] = sps[2]; // AVCLevelIndication
  out[4] = 0xff; // 0xFC | 3 → lengthSizeMinusOne = 3 (tamanho NALU de 4 bytes)
  out[5] = 0xe1; // 0xE0 | numOfSequenceParameterSets (1)
  out[6] = sps.length >> 8;
  out[7] = sps.length & 0xff;
  out.set(sps, 8);
  let o = 8 + sps.length;
  out[o++] = 0x01; // numOfPictureParameterSets (1)
  out[o++] = pps.length >> 8;
  out[o++] = pps.length & 0xff;
  out.set(pps, o);
  return out;
}

// -------------------------------------------------------------- Annex B parser

function findStartCode(buf, from) {
  for (let i = from; i + 3 <= buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) return { at: i, len: 3 };
      if (i + 3 < buf.length && buf[i + 2] === 0 && buf[i + 3] === 1) return { at: i, len: 4 };
    }
  }
  return null;
}

/**
 * Parser incremental de fluxo Annex B.
 *
 * Uso:
 *   const p = createH264Parser();
 *   p.onAu = (au) => { au.bytes, au.isKeyframe, au.nals, au.sps, au.pps, au.width, au.height };
 *   p.feed(uint8); p.feed(uint8); ...
 *   p.flush();   // no fim do fluxo
 *
 * Regras de fronteira de AU:
 *   1. AUD delimita sempre;
 *   2. SPS/PPS/IDR começam um quadro novo (config do GOP);
 *   3. sem AUD no fluxo, um NAL VCL novo com a AU atual já tendo VCL começa
 *      quadro novo (resguardo para encoders que não emitem AUD).
 * Prefixos sem VCL (SEI/SPS/PPS) são mantidos na AU até o slice chegar — é o
 * que garante o keyframe completo com SPS+PPS+IDR juntos. AUs sem VCL não são
 * emitidas (não há nada para decodificar).
 */
export function createH264Parser() {
  const state = {
    buf: new Uint8Array(0),
    current: null, // { nals, sps, pps, seenVcl }
    audSeen: false,
    onAu: null,
  };

  function startAu() {
    return { nals: [], sps: null, pps: null, seenVcl: false };
  }

  function emit(au) {
    if (!au.nals.length || !au.seenVcl) return;

    let size = 0;
    for (const n of au.nals) size += 4 + n.raw.length;
    const bytes = new Uint8Array(size);
    let o = 0;
    for (const n of au.nals) {
      bytes[o++] = 0;
      bytes[o++] = 0;
      bytes[o++] = 0;
      bytes[o++] = 1;
      bytes.set(n.raw, o);
      o += n.raw.length;
    }

    const hasIdr = au.nals.some((n) => n.type === NAL.SLICE_IDR);
    state.onAu?.({
      bytes,
      isKeyframe: hasIdr,
      nals: au.nals.map((n) => ({ type: n.type })),
      sps: au.sps,
      pps: au.pps,
      width: au.sps ? parseSps(au.sps).width : null,
      height: au.sps ? parseSps(au.sps).height : null,
    });
  }

  function pushNal(raw) {
    const type = raw[0] & 0x1f;
    let cur = state.current;

    if (type === NAL.AUD) {
      if (cur) emit(cur);
      state.current = startAu();
      state.audSeen = true;
      return;
    }

    const startsFrame =
      isSpsPps(type) || type === NAL.SLICE_IDR || (!state.audSeen && isVcl(type) && cur?.seenVcl);
    if (startsFrame && cur?.seenVcl) {
      emit(cur);
      cur = state.current = startAu();
    }
    if (!cur) cur = state.current = startAu();

    const body = raw.slice(1);
    if (type === NAL.SPS && !cur.sps) cur.sps = body;
    if (type === NAL.PPS && !cur.pps) cur.pps = body;
    if (isVcl(type)) cur.seenVcl = true;
    cur.nals.push({ type, data: body, raw });
  }

  function feed(chunk) {
    const next = new Uint8Array(state.buf.length + chunk.length);
    next.set(state.buf);
    next.set(chunk, state.buf.length);
    state.buf = next;
    process(false);
  }

  /**
   * Varre o buffer atrás de start codes. Quando `final` é verdadeiro, uma NAL
   * cortada no fim do buffer é processada mesmo assim; senão fica guardada
   * para o próximo `feed` (o start code pode estar no meio do próximo chunk).
   */
  function process(final) {
    let at = 0;
    for (;;) {
      const sc = findStartCode(state.buf, at);
      if (!sc) {
        // Pode haver um start code cortado na borda: guarda até 4 bytes.
        if (!final) state.buf = state.buf.slice(Math.max(0, state.buf.length - 4));
        else state.buf = new Uint8Array(0);
        return;
      }
      const nextSc = findStartCode(state.buf, sc.at + sc.len);
      if (!nextSc) {
        if (final) {
          pushNal(state.buf.slice(sc.at + sc.len));
          state.buf = new Uint8Array(0);
          return;
        }
        // NAL incompleta no fim: mantém só o começo para o próximo feed.
        state.buf = state.buf.slice(sc.at);
        return;
      }
      pushNal(state.buf.slice(sc.at + sc.len, nextSc.at));
      at = nextSc.at;
    }
  }

  function flush() {
    process(true);
    if (state.current) emit(state.current);
    state.current = null;
    state.buf = new Uint8Array(0);
  }

  return {
    feed,
    flush,
    set onAu(fn) {
      state.onAu = fn;
    },
  };
}
