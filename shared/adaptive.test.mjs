/**
 * Testes do AdaptiveQualityController (Bug 4).
 *
 * Rode com: node shared/adaptive.test.mjs
 *
 * Cobre: downshift, recovery, recovery nunca passa do teto, cooldown, não subir
 * com queue/encodeFps/feedback ruim, clamp mínimo.
 */

import { createAdaptiveController } from './adaptive.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FALHOU'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

// Mock de relógio para controlar cooldowns determinísticos.
// Começa num valor grande para não disparar o cooldown inicial (lastDownAt=0).
let now = 10_000_000;
const realNow = Date.now;
Date.now = () => now;
const tick = (ms) => (now += ms);

function fresh(initial = 12_000_000) {
  const applied = [];
  const changes = [];
  const ctl = createAdaptiveController({
    initialBitrate: initial,
    targetFps: 60,
    onApply: (b) => applied.push(b),
    onChange: (m) => changes.push(m),
  });
  return { ctl, applied, changes };
}

// ---------------------------------------------------------------- downshift

const { ctl, applied } = fresh();
check('começa no bitrate inicial', ctl.currentBitrate === 12_000_000);

ctl.onPressure('encode-queue');
check('pressão desce 25%', ctl.currentBitrate === 9_000_000, String(ctl.currentBitrate));

tick(3000); // passa do down cooldown (2000ms)
ctl.onPressure('encode-queue');
check('segunda pressão desce de novo', ctl.currentBitrate === 6_750_000, String(ctl.currentBitrate));

// dentro do cooldown não desce
tick(1000);
ctl.onPressure('encode-queue');
check('cooldown impede descida rápida demais', ctl.currentBitrate === 6_750_000);

// --------------------------------------------------------------- clamp mínimo

const { ctl: ctlMin } = fresh(600_000);
for (let i = 0; i < 10; i++) {
  tick(3000);
  ctlMin.onPressure('x');
}
check('bitrate nunca passa do piso', ctlMin.currentBitrate === 500_000, String(ctlMin.currentBitrate));

// ---------------------------------------------------------------- recovery

const { ctl: ctlR, changes } = fresh();
for (let i = 0; i < 3; i++) {
  tick(3000);
  ctlR.onPressure('x'); // desce até bem baixo
}
const baixo = ctlR.currentBitrate;
check('desceu bastante', baixo < 12_000_000, String(baixo));

// Estável por várias janelas (tick ~1s) → sobe devagar.
let prev = ctlR.currentBitrate;
let subiu = false;
for (let i = 0; i < 120; i++) {
  tick(1000);
  ctlR.onTick({ encoderQueueSize: 0, bufferedAmount: 0, encodedFps: 60, targetFps: 60 });
  if (ctlR.currentBitrate > prev) subiu = true;
  prev = ctlR.currentBitrate;
}
check('recuperação sobe depois de estável', subiu === true);
check('recuperação nunca passa do teto', ctlR.currentBitrate <= 12_000_000, String(ctlR.currentBitrate));
check('chegou de volta ao teto', ctlR.currentBitrate === 12_000_000, String(ctlR.currentBitrate));
check('avisou a mudança de qualidade', changes.some((m) => m.includes('recuperada')));

// ------------------------------------------------------ não sobe com pressão

const { ctl: ctlQ } = fresh();
for (let i = 0; i < 3; i++) {
  tick(3000);
  ctlQ.onPressure('x'); // desce
}
tick(10_000);
const antesQ = ctlQ.currentBitrate;
for (let i = 0; i < 20; i++) {
  tick(1000);
  // queue alta o tempo todo → nunca sobe
  ctlQ.onTick({ encoderQueueSize: 4, bufferedAmount: 0, encodedFps: 60, targetFps: 60 });
}
check('queue alta impede recuperação', ctlQ.currentBitrate === antesQ, String(ctlQ.currentBitrate));

const { ctl: ctlF } = fresh();
for (let i = 0; i < 3; i++) {
  tick(3000);
  ctlF.onPressure('x');
}
tick(10_000);
const antesF = ctlF.currentBitrate;
for (let i = 0; i < 20; i++) {
  tick(1000);
  ctlF.onTick({ encoderQueueSize: 0, bufferedAmount: 0, encodedFps: 30, targetFps: 60 }); // encode FPS baixo
}
check('encode FPS baixo impede recuperação', ctlF.currentBitrate === antesF, String(ctlF.currentBitrate));

const { ctl: ctlB } = fresh();
for (let i = 0; i < 3; i++) {
  tick(3000);
  ctlB.onPressure('x');
}
tick(10_000);
const antesB = ctlB.currentBitrate;
for (let i = 0; i < 20; i++) {
  tick(1000);
  ctlB.onTick({ encoderQueueSize: 0, bufferedAmount: 0, encodedFps: 60, targetFps: 60, feedback: { congestedViewers: 1 } });
}
check('viewer congestionado impede recuperação', ctlB.currentBitrate === antesB, String(ctlB.currentBitrate));

// ---------------------------------------------------------------- reset

const { ctl: ctlZ, applied: appZ } = fresh(10_000_000);
tick(3000);
ctlZ.onPressure('x');
check('antes do reset desceu', ctlZ.currentBitrate < 10_000_000);
ctlZ.reset(15_000_000);
check('reset muda o teto e volta para ele', ctlZ.currentBitrate === 15_000_000, String(ctlZ.currentBitrate));
check('reset aplicou o bitrate', appZ.at(-1) === 15_000_000);

// restaura relógio
Date.now = realNow;

console.log(failures ? `\n${failures} verificacao(oes) falharam` : '\nTudo passou');
process.exit(failures ? 1 : 0);
