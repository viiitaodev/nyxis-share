/**
 * Testes da classificação de gargalo (browser V2).
 *
 * Rode com: node shared/bottleneck.test.mjs
 *
 * Cobre: HEALTHY, CAPTURE LIMITED, ENCODER LIMITED (queue e encode FPS),
 * NETWORK LIMITED e VIEWER LIMITED.
 */
import { identifyBottleneck, BOTTLENECKS } from './bottleneck.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FALHOU'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

// ------------------------------------------------------------------ HEALTHY

check('tudo saudável → HEALTHY', identifyBottleneck({ captureFps: 60, encodedFps: 59, encoderQueueSize: 0, bufferedAmount: 0 }) === BOTTLENECKS.HEALTHY);
check('vazio → HEALTHY', identifyBottleneck({}) === BOTTLENECKS.HEALTHY);

// -------------------------------------------------------- CAPTURE LIMITED

check(
  'capture abaixo de 70% do alvo → CAPTURE LIMITED',
  identifyBottleneck({ captureFps: 30, encodedFps: 30, encoderQueueSize: 0, bufferedAmount: 0 }, 60) === BOTTLENECKS.CAPTURE_LIMITED
);

// -------------------------------------------------------- ENCODER LIMITED

check(
  'queue alta → ENCODER LIMITED',
  identifyBottleneck({ captureFps: 60, encodedFps: 60, encoderQueueSize: 4, bufferedAmount: 0 }, 60) === BOTTLENECKS.ENCODER_LIMITED
);
check(
  'capture saudável + encoded baixo → ENCODER LIMITED',
  identifyBottleneck({ captureFps: 60, encodedFps: 30, encoderQueueSize: 0, bufferedAmount: 0 }, 60) === BOTTLENECKS.ENCODER_LIMITED
);

// -------------------------------------------------------- NETWORK LIMITED

check(
  'buffered alto → NETWORK LIMITED',
  identifyBottleneck({ captureFps: 60, encodedFps: 60, encoderQueueSize: 0, bufferedAmount: 3 * 1024 * 1024 }, 60) === BOTTLENECKS.NETWORK_LIMITED
);

// -------------------------------------------------------- VIEWER LIMITED

check(
  'viewer rendered FPS baixo → VIEWER LIMITED',
  identifyBottleneck({ captureFps: 60, encodedFps: 60, encoderQueueSize: 0, bufferedAmount: 0, feedback: { worstRenderedFps: 20 } }, 60) === BOTTLENECKS.VIEWER_LIMITED
);

// -------------------------------------------------- precedência (encoder > rede)

check(
  'queue alta tem precedência sobre rede',
  identifyBottleneck({ captureFps: 60, encodedFps: 30, encoderQueueSize: 4, bufferedAmount: 5 * 1024 * 1024 }, 60) === BOTTLENECKS.ENCODER_LIMITED
);

console.log(failures ? `\n${failures} verificacao(oes) falharam` : '\nTudo passou');
process.exit(failures ? 1 : 0);
