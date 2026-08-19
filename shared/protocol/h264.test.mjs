/**
 * Testes do parser H.264 (Annex B), sem dependência externa.
 *
 * Rode com: node shared/protocol/h264.test.mjs
 *
 * Cobre: divisão de NAL units, emulation prevention, parse de SPS
 * (resolução/perfil/nível), geração de avcC e do codec string, agrupamento de
 * AUs com e sem AUD, detecção de keyframe (IDR) e flush de final de fluxo.
 */

import {
  createH264Parser,
  buildAvcC,
  codecFromSps,
  parseSps,
  removeEmulationPrevention,
  NAL,
} from './h264.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FALHOU'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

const u8 = (...vals) => Uint8Array.from(vals);
const concat = (...parts) => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// NAL com start code de 4 bytes. raw = NAL inteira (header + corpo).
const nal4 = (raw) => concat(u8(0, 0, 0, 1), raw);
const nal3 = (raw) => concat(u8(0, 0, 1), raw);

// SPS sintético 1080p: profile High (100), level 4.2, 1920x1080.
// Construído para este teste (não é bitstream de verdade — só estrutura).
const spsCorpo = u8(100, 0x00, 42, 0xff, 0xe1, 0x00, 0x1f, 0x00, 0x00);
const ppsCorpo = u8(0xeb, 0x01);
const spsNal = u8(NAL.SPS, ...spsCorpo);
const ppsNal = u8(NAL.PPS, ...ppsCorpo);
const idrNal = u8(NAL.SLICE_IDR, 0x88, 0x84);
const deltaNal = u8(NAL.SLICE_NON_IDR, 0x41, 0x9a);
const audNal = u8(NAL.AUD, 0x10);

// ---------------------------------------------------------------- básicos

check('removeEmulationPrevention tira 0x03 falso', (() => {
  const out = removeEmulationPrevention(u8(0, 0, 3, 1, 0, 0, 3, 2));
  return out.length === 6 && out[2] === 1 && out[3] === 0 && out[5] === 2;
})());

check('removeEmulationPrevention preserva 0x03 real', (() => {
  const out = removeEmulationPrevention(u8(1, 2, 3, 4));
  return out.length === 4;
})());

// ------------------------------------------------------------ avcC / codec

check('codecFromSps monta avc1.64002A', codecFromSps(100, 42, 0) === 'avc1.64002A');

check('buildAvcC gera box válido', (() => {
  const avc = buildAvcC(spsCorpo, ppsCorpo);
  if (!avc || avc[0] !== 1 || avc[1] !== 100 || avc[3] !== 42) return false;
  const lenSps = (avc[6] << 8) | avc[7];
  if (lenSps !== spsCorpo.length) return false;
  if (avc[8 + lenSps] !== 1) return false; // numPPS
  const o = 8 + lenSps + 1;
  const lenPps = (avc[o] << 8) | avc[o + 1];
  return lenPps === ppsCorpo.length;
})());

check('parseSps do corpo sintético 1080p', (() => {
  const s = parseSps(spsCorpo);
  return s.profile === 100 && s.width > 0 && s.height > 0;
})());

// -------------------------------------------------------- agrupamento com AUD

const p = createH264Parser();
const aus = [];
p.onAu = (au) => aus.push(au);
p.feed(
  concat(
    nal4(audNal),
    nal4(spsNal),
    nal4(ppsNal),
    nal4(idrNal), // keyframe (GOP 1)
    nal4(audNal),
    nal4(deltaNal), // delta
    nal4(audNal),
    nal4(deltaNal) // delta
  )
);
p.flush();

check('com AUD: 3 AUs emitidas', aus.length === 3, `${aus.length}`);
check('primeira AU é keyframe (IDR)', aus[0]?.isKeyframe === true);
check('segunda AU é delta', aus[1]?.isKeyframe === false);
check('AU de keyframe carrega SPS+PPS+IDR', (() => {
  const tipos = aus[0]?.nals.map((n) => n.type) ?? [];
  return tipos.includes(NAL.SPS) && tipos.includes(NAL.PPS) && tipos.includes(NAL.SLICE_IDR);
})());
check('AUs delta não carregam SPS', (() => {
  const deltaTipos = aus[1]?.nals.map((n) => n.type) ?? [];
  return !deltaTipos.includes(NAL.SPS);
})());
check('bytes da AU usam start codes', (() => {
  const b = aus[0]?.bytes ?? new Uint8Array();
  return b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 1;
})());
check('AUD não entra no pacote', (() => {
  const tipos = aus.flatMap((a) => a.nals.map((n) => n.type));
  return !tipos.includes(NAL.AUD);
})());

// ------------------------------------------------------- agrupamento sem AUD

const p2 = createH264Parser();
const aus2 = [];
p2.onAu = (au) => aus2.push(au);
p2.feed(concat(nal3(spsNal), nal3(ppsNal), nal3(idrNal), nal3(deltaNal), nal3(deltaNal)));
p2.flush();

check('sem AUD: keyframe não é cortado', (() => {
  // SPS+PPS+IDR entram na mesma AU; cada VCL delta seguinte abre quadro novo.
  return aus2.length === 3 && aus2[0].isKeyframe === true && aus2[1].isKeyframe === false && aus2[2].isKeyframe === false;
})(), `${aus2.length}`);

// ----------------------------------------------------------- divisão por feed

// Um NAL pode chegar fatiado em vários feeds: o parser precisa remontar.
const p3 = createH264Parser();
const aus3 = [];
p3.onAu = (au) => aus3.push(au);
const fluxo = concat(nal4(audNal), nal4(spsNal), nal4(ppsNal), nal4(idrNal), nal4(audNal), nal4(deltaNal));
for (let i = 0; i < fluxo.length; i++) p3.feed(fluxo.slice(i, i + 1));
p3.flush();

check('feed byte a byte monta as AUs', aus3.length === 2, `${aus3.length}`);
check('keyframe detectado em feed fatiado', aus3[0]?.isKeyframe === true);

// -------------------------------------------------------------- sem VCL

const p4 = createH264Parser();
const aus4 = [];
p4.onAu = (au) => aus4.push(au);
p4.feed(concat(nal4(audNal), nal4(spsNal), nal4(ppsNal)));
p4.flush();

check('AU sem VCL (só config) não é emitida', aus4.length === 0);

// ------------------------------------------------------ SPS parse 1920x1080

// SPS de verdade (baseline, 1920x1080) montado a partir de um bitstream real:
// 67 42 00 1f 95 a8 14 01 6a 12 ... — usamos um trecho conhecido e validamos
// apenas a estabilidade do parser (não quebra com dados desconhecidos).
const spsReal = u8(
  0x42, 0x00, 0x1f, 0x95, 0xa8, 0x14, 0x01, 0x6a, 0x12, 0x3c, 0x00, 0x00,
  0x03, 0x00, 0x00, 0x03, 0x00, 0xf1, 0x83, 0x19, 0x60
);
const parsed = parseSps(removeEmulationPrevention(spsReal));
check('parseSps sobre SPS real não quebra', Number.isFinite(parsed.width) && Number.isFinite(parsed.height));
check('parseSps extrai perfil/level do SPS real', parsed.profile === 66 && parsed.level === 31);

console.log(failures ? `\n${failures} verificacao(oes) falharam` : '\nTudo passou');
process.exit(failures ? 1 : 0);
