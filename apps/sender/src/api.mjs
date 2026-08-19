/**
 * Cliente HTTP do Sender para o servidor Nyxis.
 *
 * Só dois usos: trocar o senderToken pelo alvo de publicação e encerrar a
 * sessão. Nada de credencial permanente vive aqui — o token é efêmero e vem do
 * deep link `nyxisshare://publish?session=...`.
 */
export function normalizeServer(server) {
  return String(server ?? '').replace(/\/+$/, '');
}

async function post(server, path, body, timeoutMs = 10_000) {
  const r = await fetch(`${normalizeServer(server)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error ?? `Servidor respondeu ${r.status}.`);
    err.status = r.status;
    throw err;
  }
  return data;
}

export async function resolveSession({ server, token }) {
  return post(server, '/api/ingest/session/resolve', { token });
}

export async function stopSession({ server, token, sessionId }) {
  return post(server, '/api/ingest/session/stop', { token, sessionId });
}

/** Extrai `session` e `host` de um deep link `nyxisshare://publish?session=...`. */
export function parseDeepLink(url) {
  if (!url || !url.startsWith('nyxisshare://')) return null;
  const u = new URL(url.replace('nyxisshare://', 'https://nyxisshare/'));
  if (u.pathname !== '/publish') return null;
  const session = u.searchParams.get('session');
  const host = u.searchParams.get('host');
  if (!session) return null;
  return { session, host };
}