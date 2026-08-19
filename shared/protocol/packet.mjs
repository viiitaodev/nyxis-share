/**
 * Empacotamento binário dos quadros do caminho nativo.
 *
 * Mesmo formato do broadcaster do navegador (docs/NATIVE_MEDIA_PROTOCOL.md):
 *
 *   [1B slot][1B tipo][8B timestamp][8B relógio de envio][payload]
 *
 * O slot é atribuído pelo servidor ao transmissor; o tipo segue a convenção já
 * usada pelo relay (1=keyframe, 2=delta, 3=áudio). Manter o formato idêntico é
 * o que deixa o gateway injetar o stream nativo no relay existente sem tocar
 * em `rooms.js` nem no player WebCodecs.
 */

export const TIPO_KEYFRAME = 1;
export const TIPO_DELTA = 2;
export const TIPO_AUDIO = 3;

/**
 * @param {number} slot      slot do transmissor, carimbado pelo servidor
 * @param {number} tipo      1|2|3
 * @param {number} timestamp µs (ordem de decodificação do quadro)
 * @param {Uint8Array} payload bytes Annex B da AU (sem o AUD)
 * @returns {ArrayBuffer}
 */
export function empacotarQuadro(slot, tipo, timestamp, payload) {
  const buf = new ArrayBuffer(18 + payload.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, slot);
  view.setUint8(1, tipo);
  view.setFloat64(2, timestamp);
  view.setFloat64(10, Date.now());
  new Uint8Array(buf, 18).set(payload);
  return buf;
}
