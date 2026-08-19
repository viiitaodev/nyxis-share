/**
 * Sessões de ingest do caminho nativo (SRT).
 *
 * Uma sessão nasce quando a Activity pede um compartilhamento de alta qualidade
 * (`POST /api/ingest/session`), amarra a sala e o usuário, e devolve um token
 * curto de publicação (`scope: ingest-publish`) que o Sender troca pelo alvo
 * SRT. Nada aqui é persistido: sessões vivem em memória e expiram sozinhas.
 *
 * Segurança (decisões documentadas em docs/NATIVE_SRT_PLAN.md):
 *  - token assinado (HMAC-SHA256) com INGEST_SECRET || SESSION_SECRET;
 *  - TTL curto de publicação (INGEST_SENDER_TTL, padrão 10 min);
 *  - expiração e varredura de órfãs (INGEST_IDLE_TTL);
 *  - rate limit de criação por usuário;
 *  - nunca loga o token completo.
 */

import crypto from 'node:crypto';
import { secretEnv } from '../env-file.js';

export const NATIVE_PROFILES = ['720p30', '720p60', '1080p30', '1080p60'];
export const SESSION_TTL_MS = Number(process.env.INGEST_SESSION_TTL ?? 6 * 60 * 60) * 1000;
export const SENDER_TOKEN_TTL_S = Number(process.env.INGEST_SENDER_TTL ?? 10 * 60);
const IDLE_TTL_MS = Number(process.env.INGEST_IDLE_TTL ?? 10 * 60) * 1000;
const SWEEP_EVERY_MS = 30 * 1000;
const RATE_MAX = Number(process.env.INGEST_RATE_MAX ?? 5);
const RATE_WINDOW_MS = 60 * 1000;

let cachedSecret = null;
function secret() {
  if (cachedSecret) return cachedSecret;
  cachedSecret = secretEnv('INGEST_SECRET') || secretEnv('SESSION_SECRET');
  if (!cachedSecret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('INGEST_SECRET ou SESSION_SECRET obrigatorio em producao.');
    }
    console.warn('aviso: sem INGEST_SECRET/SESSION_SECRET — assinando ingest com segredo de desenvolvimento.');
    cachedSecret = 'dev-inseguro-ingest';
  }
  return cachedSecret;
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

/**
 * Token curto e assinado, mesmo formato do tokens.js: <payload>.<hmac>.
 * Carrega `scope` — tokens de ingest nunca valem como identidade/room token.
 */
export function signIngestToken(payload, ttlSeconds) {
  const claims = { ...payload, scope: 'ingest-publish' };
  if (ttlSeconds) claims.exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = b64(Buffer.from(JSON.stringify(claims)));
  return `${body}.${hmac(body)}`;
}

export function verifyIngestToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = hmac(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
  if (payload.scope !== 'ingest-publish') return null;
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ------------------------------------------------------------------- registro

const sessions = new Map(); // id -> session
const byStreamId = new Map(); // streamId -> id
const attempts = new Map(); // userId -> [timestamps]

export function getIngestSession(id) {
  return sessions.get(id) ?? null;
}

export function findIngestByStreamId(streamId) {
  const id = byStreamId.get(streamId);
  return id ? sessions.get(id) ?? null : null;
}

/** Sessão dona deste senderToken, ou null se inválido/expirado. */
export function sessionBySenderToken(token) {
  const payload = verifyIngestToken(token);
  if (!payload?.session) return null;
  const session = sessions.get(payload.session);
  if (!session) return null;
  if (session.userId !== payload.uid) return null;
  return session;
}

export function createIngestSession({ roomId, userId, name, profile, broadcasterToken, port }) {
  const id = crypto.randomBytes(8).toString('base64url');
  const streamId = crypto.randomBytes(12).toString('base64url');
  const now = Date.now();
  const session = {
    id,
    streamId,
    roomId,
    userId,
    name,
    profile,
    broadcasterToken,
    port,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    lastActivityAt: now,
    state: 'idle', // idle | live | stopped
  };
  sessions.set(id, session);
  byStreamId.set(streamId, id);
  const senderToken = signIngestToken({ session: id, uid: userId }, SENDER_TOKEN_TTL_S);
  return { session, senderToken };
}

export function touchIngestSession(id) {
  const s = sessions.get(id);
  if (s) s.lastActivityAt = Date.now();
}

export function removeIngestSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  sessions.delete(id);
  byStreamId.delete(s.streamId);
  return s;
}

export function listIngestSessions() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    roomId: s.roomId,
    userId: s.userId,
    profile: s.profile,
    port: s.port,
    state: s.state,
  }));
}

// ------------------------------------------------------------------ rate limit

export function ingestRateLimit(userId) {
  const now = Date.now();
  const list = (attempts.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) {
    return { ok: false, seconds: Math.ceil((list[0] + RATE_WINDOW_MS - now) / 1000) };
  }
  list.push(now);
  attempts.set(userId, list);
  return { ok: true };
}

// ------------------------------------------------------------------ varredura

/**
 * Fecha sessões que venceram ou ficaram inativas. O `onClose` é injetado pelo
 * index.js e passa pelo mesmo funil do stop manual (mata ffmpeg, fecha WS,
 * libera porta) — nunca por um caminho paralelo.
 */
export function startIngestSweeper(onClose) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      const expired = now > session.expiresAt;
      const idle = now - session.lastActivityAt > IDLE_TTL_MS;
      if (expired || idle) {
        onClose?.(session, expired ? 'expirou' : 'inativa');
      }
    }
  }, SWEEP_EVERY_MS);
  timer.unref?.();
  return timer;
}
