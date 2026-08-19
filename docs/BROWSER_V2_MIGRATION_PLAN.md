# Plano de Migração — Nyxis Share Browser V2

> Estado: **Native/SRT cancelado e revertido (PR #3)**. Este documento registra
> a auditoria da arquitetura abandonada, o plano de evolução 100% browser e a
> decisão de não exigir instalação nenhuma no computador de quem transmite.

## Regra fundamental do produto

> **ZERO INSTALAÇÃO.**
>
> Quem compartilha a tela **não** pode precisar instalar nada:
> Sender.exe, Tauri, Electron, FFmpeg, OBS, driver, serviço Windows,
> protocol handler `nyxisshare://` ou qualquer aplicativo complementar.
>
> O produto é: *entrou na call → abriu a Activity → clicou em compartilhar →
> pronto.*

O Nyxis Share funciona com:
- Discord Activity;
- navegador Chrome/Edge/Chromium;
- uma aba externa de captura quando necessário;
- VPS Nyxis.

## Arquitetura suportada (única)

```
QUEM COMPARTILHA
  Discord Activity → botão Compartilhar → aba normal do Chrome/Edge
    → getDisplayMedia() → WebCodecs VideoEncoder
    → Transport abstraction (WebTransport quando disponível | WebSocket fallback)
    → VPS Nyxis

VPS NYXIS
  relay de mídia → WebSocket → QUEM ASSISTE

QUEM ASSISTE
  Discord Activity → WebCodecs VideoDecoder → canvas/rendering
```

Nenhum programa instalado. A VPS nunca decodifica/recodifica — só repassa
(pipeline WebSocket atual, com melhoria de telemetria e adaptive bitrate).

---

## Auditoria — o que foi implementado como Native/SRT (Fase 1)

A implementação Native/SRT (commits `9b9456c` e `f09b107`, revertidos em
`d0abe0e`) tentou adicionar um "modo alta qualidade" com Sender Windows, SRT e
FFmpeg. A auditoria classifica cada parte:

### REMOVE — só existe por causa do Sender/SRT (já revertido)

| componente | motivo |
|---|---|
| `apps/sender/` (CLI nativo) | exige FFmpeg no PC — quebra zero-instalação |
| protocol handler `nyxisshare://` | exige instalação/registro no Windows |
| código Tauri futuro | exige app instalado |
| SRT ingress (porta por sessão, UDP 4001–4016) | transporte externo, fora do browser |
| SRT session creation (`server/ingest/session.js`) | só faz sentido com Sender |
| `server/media/gateway.js` (demux H.264, `-c:v copy`) | só recebe SRT |
| `server/transport/srt.mjs` (pool de portas UDP) | só serve SRT |
| `shared/protocol/h264.mjs` (parser Annex B) | só para demux de SRT/ffmpeg |
| `shared/protocol/packet.mjs` | específico do gateway nativo |
| deep link `nyxisshare://publish` | exige handler instalado |
| token de ingest `INGEST_SECRET` | só para o Sender resolver a sessão |
| `scripts/ffmpeg-shim.mjs` | teste do pipeline com FFmpeg |
| FFmpeg no Dockerfile | dependência de infra para transcode/demux |
| `docker-stack.yml` (portas UDP SRT) | publicação UDP só para SRT |
| docs `NATIVE_SRT_PLAN.md`, `NATIVE_MEDIA_PROTOCOL.md`, `DEPLOY_SRT_SWARM.md` | instruções de produção para arquitetura abandonada |
| env vars `NYXIS_SRT_HOST`, `NYXIS_SRT_PORT_RANGE`, `INGEST_*` | só para SRT |
| endpoints `/api/ingest/session` (+resolve/stop) | só para o Sender |
| UI "Alta qualidade / Abrir no Sender / Baixar Sender" | promete instalação externa |
| selo "Sender" no tile | só para streams nativos |

### REFACTOR — útil, mas acoplada ao Native/SRT

| componente | reaproveitamento na V2 |
|---|---|
| `MediaGateway` (conceito) | vira a camada de **telemetria/agregação de feedback** do relay, não um processo de mídia separado |
| session lifecycle (criar/expirar/limpar) | reaproveitado no ciclo de vida da transmissão do browser (start/stop/reconnect) |
| pool de recursos com limite (portas) | inspira o controle de recursos do relay/backpressure |
| abstração de transporte | vira `BroadcasterTransport` (WebSocket agora, WebTransport depois) |

### KEEP — útil para a nova arquitetura (não nativo)

| componente | motivo |
|---|---|
| `shared/broadcaster.js` (browser) | já é o pipeline certo — será estendido |
| `client/src/player.js` (WebCodecs VideoDecoder) | decodificador da Activity — mantido |
| `client/src/audio.js` (Opus) | áudio do browser — mantido |
| `server/rooms.js` (relay + keyframe + opt-in) | núcleo do relay — mantido e melhorado |
| `server/index.js` (WebSocket + auth + salas) | mantido |
| `scripts/smoke.mjs` | teste e2e — mantido e estendido |
| keyframe sob demanda / periódico | mantido e refinado |
| backpressure por viewer | mantido e melhorado |
| CSP + proxy do Discord (`/.proxy/`) | mantido |

---

## Plano da V2 Browser (por fases, ordem obrigatória)

Cada fase termina com `npm run build` + `npm test` + `npm run smoke` (ou
equivalentes). Não avançar com testes quebrados.

### Fase 1 — Telemetria real (MEDIR antes de otimizar)
Adicionar telemetria em broadcaster, viewer e servidor. Nada de FPS maquiado —
medir e mostrar o número real. Tela "Detalhes da transmissão" com capture FPS,
encode FPS, render FPS, bitrate real, encoder queue, transport, latência.

### Fase 2 — Content hint por modo (Game/Text)
Criar modos **Automático / Jogos·Movimento / Texto·Trabalho**:
- `Jogos/Movimento`: `contentHint = 'motion'`, prioriza FPS/estabilidade.
- `Texto/Trabalho`: `contentHint = 'text'`, prioriza nitidez/resolução.
- `Automático`: estratégia segura/equilibrada.
A mudança de modo também ajusta o encoder.

### Fase 3 — Probing real de codec
Testar `VideoEncoder.isConfigSupported` para H.264 → VP9 → VP8 (ordem a
validar). Considerar `hardwareAcceleration: 'prefer-hardware'` quando suportado.
UI diz **"Hardware acceleration: requested"**, nunca "NVENC ativo" sem prova.

### Fase 4 — Game mode
Configuração de gameplay, meta 1080p60 real. Avaliar `latencyMode: 'realtime'`
como experimento (não dogma). Prioridade: estabilidade > FPS > qualidade >
latência (sub-1s aceitável).

### Fase 5 — Não acumular atraso
Política de fila configurável (0–1 normal, 2 atenção, ≥3 drop seletivo).
Descartar frame antigo em vez de acumular segundos de atraso.

### Fase 6 — Adaptive bitrate
`AdaptiveQualityController` com degradação rápida / recuperação lenta e
hysteresis. Entradas: encoder queue, encode FPS, capture FPS, buffered amount,
feedback do viewer, latência, throughput.

### Fase 7 — Feedback do viewer
Viewer envia (500–1000ms) `renderedFps`, `decodedFps`, `decodeQueue`,
`estimatedLatency`, `bufferState`, `droppedFrames`. Servidor agrega e manda
resumo ao broadcaster.

### Fase 8 — Viewer lento não prejudica sala
Backpressure individual: descartar frames de viewer lento, nunca acumular
buffer sem limite. Métricas por viewer.

### Fase 9 — WebSocket melhorado
Avaliar separação de canais (mídia vs controle) ou multiplexação priorizada.
Só se benchmark mostrar ganho real; documentar decisão.

### Fase 10 — WebTransport (uploader, experimental — NÃO nesta rodada)
Somente no trecho **aba externa → VPS**. `BroadcasterTransport` com
`WebSocketBroadcasterTransport` e `WebTransportBroadcasterTransport`.
Fallback transparente para WebSocket. Primeiro validar HTTP/3/QUIC na infra
(Traefik v3 / serviço dedicado) e documentar decisão (possível endpoint
`transport.share.nyxis.com.br`). Classificar mídia: confiável (config, keyframe
critical, controle) vs datagram (delta frames, com GOP curto + recovery).

### Fases 11–16 — Keyframes, resolução dinâmica, captura eficiente, áudio,
perfis de qualidade, UI browser-only
Refinar keyframe policy, scaler reutilizável (1080p/900p/720p) com
OffscreenCanvas, priorizar MediaStreamTrackProcessor, manter áudio Opus (no
WebTransport, áudio fica no WebSocket na primeira implementação), perfis
Auto/Game/Texto, e UI simples sem qualquer menção a instalação.

### Fases 17–20 — Limpeza, infra, testes, benchmark
Busca global por `srt|srtla|sender|nyxisshare|ffmpeg|4001|INGEST_SECRET` —
cada ocorrência justificada. Infra continua Docker Swarm/Traefik/Portainer/GHCR
sem FFmpeg e sem portas UDP SRT. Testes de transport fallback, adaptive bitrate,
quality state machine, feedback aggregation, backpressure, keyframe, resolution
switching, mode switching, contentHint, telemetry, reconnect. Benchmark real
(60s, 1080p60) em `docs/PERFORMANCE_BROWSER_V2.md`.

---

## Critérios de aceite da V2 Browser

1. Não exige instalação. ✅
2. Não existe Sender obrigatório. ✅
3. Não existe SRT obrigatório. ✅
4. Compartilhar continua funcionando pela Activity. ✅
5. Aba externa abre automaticamente quando necessária. ✅
6. Browser mode antigo disponível como fallback. ✅
7. Jogos usam contentHint motion.
8. Texto usa contentHint text.
9. Adaptive bitrate funciona.
10. Viewer lento não prejudica outro.
11. FPS exibido é real.
12. 1080p60 sustentável quando hardware/rede suportam.
13. WebTransport falhando cai para WebSocket.
14. Nenhuma conexão acumula segundos de atraso.
15. Novo viewer começa rapidamente.
16. Reconnect funciona.
17. Áudio atual continua funcionando.
18. Sem processos/clientes externos.
19. Deploy simples no Docker Swarm.
20. Docs atualizadas.

## Meta de performance (PC/rede saudáveis, 1080p60, 60s)
- capture ≥ 58 FPS
- encode ≥ 55 FPS
- render ≥ 55 FPS

Se não alcançar, mostrar claramente o gargalo:
`CAPTURE LIMITED | ENCODER LIMITED | NETWORK LIMITED | VIEWER LIMITED`.
Nunca reduzir silenciosamente para 30 FPS enquanto a UI continua mostrando 60.

## Documento histórico

O Native/SRT foi **descartado** por exigir instalação de software no PC do
transmissor (Sender/FFmpeg/protocol handler), violando a regra de zero
instalação. Nenhuma instrução de produção deve referenciar essa arquitetura.
