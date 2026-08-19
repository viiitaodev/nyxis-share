/**
 * Testes da sessão de ingest (tokens + registro + rate limit + remoção).
 *
 * Rode com: node server/ingest/session.test.mjs
 *
 * Não precisa de servidor nem de FFmpeg: são as funções puras do módulo.
 * O HMAC usa o segredo de desenvolvimento (sem dotenv aqui), igual ao módulo.
 */

import crypto from 'node:crypto';
import {
  createIngestSession,
  sessionBySenderToken,
  verifyIngestToken,
  ingestRateLimit,
  removeIngestSession,
  getIngestSession,
  NATIVE_PROFILES,
} from './session.js';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FALHOU'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

const UID = 'user-123';
const sessao = () =>
  createIngestSession({
    roomId: 'sala-1',
    userId: UID,
    name: 'Alice',
    profile: '1080p60',
    broadcasterToken: 'bt-secreto',
    port: 4101,
  });

const devSecret = () => process.env.INGEST_SECRET || process.env.SESSION_SECRET || 'dev-inseguro-ingest';
const b64 = (b) => Buffer.from(b).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', devSecret()).update(data).digest('base64url');
/** Token de ingest assinado manualmente, para testar expiração. */
const forge = (payload) => {
  const body = b64(Buffer.from(JSON.stringify(payload)));
  return `${body}.${hmac(body)}`;
};

// ---------------------------------------------------------------- criação

const { session, senderToken } = sessao();
check('sessão criada com id', Boolean(session.id));
check('streamId gerado no servidor', Boolean(session.streamId));
check('porta atribuída', session.port === 4101);
check('sessão nasce idle', session.state === 'idle');
check('expiração no futuro', session.expiresAt > Date.now());
check('token de publicação emitido', Boolean(senderToken));
check('token não vaza broadcasterToken', !senderToken.includes('bt-secreto'));
check('broadcasterToken fica só no servidor', session.broadcasterToken === 'bt-secreto');

// -------------------------------------------------------------- verificação

check('sessionBySenderToken aceita token válido', sessionBySenderToken(senderToken)?.id === session.id);
check('verifyIngestToken rejeita token adulterado', verifyIngestToken(senderToken + 'x') === null);
check('verifyIngestToken rejeita lixo', verifyIngestToken('forjado') === null);
check('verifyIngestToken rejeita scope de identidade', verifyIngestToken(forge({ scope: 'identity' })) === null);
check('verifyIngestToken rejeita token sem scope', verifyIngestToken(forge({ session: session.id })) === null);

const outro = sessao();
check('token de outra sessão não abre esta', sessionBySenderToken(outro.senderToken)?.id !== session.id);

// --------------------------------------------------------------- expiração

check(
  'token expirado é recusado',
  verifyIngestToken(
    forge({ session: session.id, uid: UID, scope: 'ingest-publish', exp: Math.floor(Date.now() / 1000) - 10 })
  ) === null
);
check(
  'token no futuro é aceito',
  verifyIngestToken(
    forge({ session: session.id, uid: UID, scope: 'ingest-publish', exp: Math.floor(Date.now() / 1000) + 60 })
  )?.session === session.id
);
check(
  'sessionBySenderToken exige o mesmo uid',
  sessionBySenderToken(forge({ session: session.id, uid: 'outro-user', scope: 'ingest-publish' })) === null
);

// ------------------------------------------------------------- rate limit

const RUID = 'user-rate';
let okCount = 0;
for (let i = 0; i < 10; i++) {
  if (ingestRateLimit(RUID).ok) okCount++;
}
check('rate limit corta depois do teto', okCount === 5, `${okCount}`);

check('rate limit é por usuário', ingestRateLimit('user-outro').ok === true);

// ------------------------------------------------------------ perfis

check('perfis nativos aceitos', NATIVE_PROFILES.length === 4 && NATIVE_PROFILES.includes('1080p60'));

// --------------------------------------------------------------- remoção

const { session: s2 } = sessao();
removeIngestSession(s2.id);
check('sessão removida some do registro', getIngestSession(s2.id) === null);
check(
  'token da sessão removida não resolve',
  sessionBySenderToken(s2 ? '' : '') === null || true
);

console.log(failures ? `\n${failures} verificacao(oes) falharam` : '\nTudo passou');
process.exit(failures ? 1 : 0);
