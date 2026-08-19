/**
 * SrtTransport: monta o endereço de publicação SRT.
 *
 * O Sender publica com `-f mpegts` numa URL SRT. O `streamid` carrega o
 * streamId da sessão (identificador estável); a porta é o capability de acesso
 * (ver docs/NATIVE_SRT_PLAN.md).
 */
export function buildSrtUrl({ host, port, streamId, latencyMs = 150 }) {
  const latencyUs = Math.round(latencyMs * 1_000_000);
  const params = [`pkt_size=1316`, `latency=${latencyUs}`];
  if (streamId) params.push(`streamid=${encodeURIComponent(streamId)}`);
  return `srt://${host}:${port}?${params.join('&')}`;
}

/** Transport de publicação: hoje SRT; amanhã SRTLA/WebTransport. */
export function publisherArgs({ url, profile }) {
  return [
    '-f', 'mpegts',
    '-muxdelay', '0.1',
    url,
  ];
}