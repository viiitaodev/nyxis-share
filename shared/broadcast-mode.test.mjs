/**
 * Testes dos modos de conteúdo e perfis (browser V2).
 *
 * Rode com: node shared/broadcast-mode.test.mjs
 *
 * Cobre: contentHint por modo, perfis por modo, resolução de perfil e o
 * contrato "nunca maquiar" (cada perfil expõe fps/bitrate reais como alvo).
 */
import { contentHintFor, resolveProfile, PROFILES, MODES } from './broadcast-mode.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FALHOU'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

// ------------------------------------------------------------- contentHint

check('motion → contentHint motion', contentHintFor('motion') === 'motion');
check('text → contentHint text', contentHintFor('text') === 'text');
check('auto → contentHint null (navegador decide)', contentHintFor('auto') === null);
check('modo desconhecido → null', contentHintFor('qualquer') === null);
check('modos suportados', JSON.stringify(MODES) === JSON.stringify(['auto', 'motion', 'text']));

// ---------------------------------------------------------------- perfis

check('cada modo tem 4 opções', Object.values(PROFILES).every((m) => m.options.length === 4));
check('motion prioriza bitrate alto', PROFILES.motion.options[0].bitrate >= PROFILES.text.options[0].bitrate);
check('motion tem contentHint motion', PROFILES.motion.contentHint === 'motion');
check('text tem contentHint text', PROFILES.text.contentHint === 'text');
check('auto não força contentHint', PROFILES.auto.contentHint === null);

const p60 = resolveProfile('motion', 0);
check('resolveProfile 1080p60 motion', p60.fps === 60 && p60.width === 1920 && p60.height === 1080);
check('resolveProfile carrega contentHint', p60.contentHint === 'motion');
check('resolveProfile fora do range cai na primeira', resolveProfile('auto', 99).fps === 60);
check('resolveProfile modo inválido cai em auto', resolveProfile('nope', 0).mode === 'auto');

// perfil 720p30 de texto tem o menor bitrate da família
const p720 = resolveProfile('text', 3);
check('text 720p30 é o mais leve', p720.bitrate === 3_000_000 && p720.fps === 30);

console.log(failures ? `\n${failures} verificacao(oes) falharam` : '\nTudo passou');
process.exit(failures ? 1 : 0);
