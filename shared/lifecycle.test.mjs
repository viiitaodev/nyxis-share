/**
 * Testes do ciclo de vida da transmissão (pós-DedicatedWorker).
 *
 * Rode com: node shared/lifecycle.test.mjs
 *
 * Cobre: ordem das fases, STREAM_READY como única fase "pronta", e o contrato
 * de que nada antes de STREAM_READY é mídia.
 */
import { PHASES, PHASE_ORDER, isStreamReady, comparePhases, nextPhase } from './lifecycle.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FALHOU'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

// -------------------------------------------------------------------- ordem

check(
  'ordem: INITIALIZING primeiro, STREAM_READY último',
  PHASE_ORDER[0] === PHASES.INITIALIZING &&
    PHASE_ORDER[PHASE_ORDER.length - 1] === PHASES.STREAM_READY
);

check(
  'ordem completa e sem duplicatas',
  new Set(PHASE_ORDER).size === PHASE_ORDER.length &&
    PHASE_ORDER.length === Object.keys(PHASES).length
);

check(
  'comparePhases respeita a sequência',
  comparePhases(PHASES.CAPTURE_ACQUIRED, PHASES.TRANSPORT_CONNECTED) < 0 &&
    comparePhases(PHASES.FIRST_FRAME_ENCODED, PHASES.STREAM_READY) < 0
);

check(
  'nextPhase de FIRST_FRAME_ENCODED é STREAM_READY',
  nextPhase(PHASES.FIRST_FRAME_ENCODED) === PHASES.STREAM_READY
);

// --------------------------------------------------------------- pronto (?)

check('INITIALIZING não está pronto', !isStreamReady(PHASES.INITIALIZING));
check('CAPTURE_ACQUIRED não está pronto', !isStreamReady(PHASES.CAPTURE_ACQUIRED));
check('TRANSPORT_CONNECTED não está pronto', !isStreamReady(PHASES.TRANSPORT_CONNECTED));
check('ENCODER_READY não está pronto', !isStreamReady(PHASES.ENCODER_READY));
check('CAPTURE_PUMPING não está pronto', !isStreamReady(PHASES.CAPTURE_PUMPING));
check('FIRST_FRAME_SUBMITTED não está pronto', !isStreamReady(PHASES.FIRST_FRAME_SUBMITTED));
check('FIRST_FRAME_ENCODED não está pronto', !isStreamReady(PHASES.FIRST_FRAME_ENCODED));
check('STREAM_READY está pronto', isStreamReady(PHASES.STREAM_READY));
check('undefined não está pronto', !isStreamReady(undefined));

console.log(failures ? `\n${failures} verificacao(oes) falharam` : '\nTudo passou');
process.exit(failures ? 1 : 0);