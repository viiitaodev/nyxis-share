# Benchmark — Nyxis Share Browser V2 (WebSocket)

> Estado: **telemetria corrigida; números reais a preencher em campo**. Este
> documento define o procedimento objetivo de benchmark do pipeline WebSocket.
> WebTransport será comparado depois, na etapa experimental — nunca afirmar que
> melhora algo sem medir.

## Métricas (telemetria corrigida)

O broadcaster mede por segundo, com **delta de tempo real** (`frames / dt`,
não assumindo exatamente 1s):

| métrica | significado |
|---|---|
| `captureFps` | quadros recebidos da captura |
| `submittedFps` | `encoder.encode()` chamado com sucesso |
| `encodedFps` | chunks **produzidos** pelo encoder (callback `onEncoded`) |
| `actualMbps` | bytes enviados por segundo |
| `currentBitrate` | bitrate atual (após adaptive) |
| `targetBitrate` | teto escolhido pelo usuário/perfil |
| `encoderQueueSize` | fila do encoder |
| `droppedBeforeEncode` | quadros descartados por política de fila |
| `bufferedAmount` | backpressure do WebSocket |
| `keyframes` | keyframes na janela |
| `codec` / `resolution` / `contentHint` / `transport` | contexto |
| `bottleneck` | `HEALTHY` \| `CAPTURE/ENCODER/NETWORK/VIEWER LIMITED` |
| `probingSummary` | diagnóstico de por que o codec foi escolhido (debug) |

A diferença **submitted vs encoded** é o sinal real de gargalo de encoder:
`capture 60 / submitted 60 / encoded 43` significa que o encoder não está
produzindo os quadros que recebe.

O viewer mede: `receivedFps`, `decodedFps`, `renderedFps`, `decodeQueueSize`,
`droppedFrames`, `estimatedLatencyMs`.

> **Latência**: `estimatedLatencyMs` é baseada no relógio carimbado no pacote.
> Preciso na mesma máquina; **estimado** entre máquinas (relógios não
> sincronizados). Nunca tratar como latência end-to-end exata.

## Procedimento (60 segundos)

Para cada cenário, rode **60s de 1080p60** no mesmo estado de máquina/rede e
cena de movimento. Registre a cada **5 segundos**:

| t (s) | capture | submitted | encoded | actual Mbps | current Mbps | queue | drop | buffered | render FPS | latency est. | bottleneck |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 5 | | | | | | | | | | | |
| 10 | | | | | | | | | | | |
| … | | | | | | | | | | | |
| 60 | | | | | | | | | | | |

### Resumo (preencher no fim)

| métrica | mínimo | média | máximo |
|---|---|---|---|
| capture FPS | | | |
| submitted FPS | | | |
| encoded FPS | | | |
| render FPS | | | |
| bitrate atual (Mbps) | | | |
| encoder queue | | | |
| dropped frames | | | |
| bufferedAmount max | | | |
| latência est. (ms) | | | |
| bottleneck predominante | — | | — |

## Cenários

| cenário | uploader → VPS | VPS → viewer |
|---|---|---|
| A · WebSocket antigo | WebSocket | WebSocket |
| B · WebSocket otimizado (V2) | WebSocket (telemetria + adaptive) | WebSocket |
| C · WebTransport (experimental, depois) | WebTransport | WebSocket |

## Meta (PC/rede saudáveis, 1080p60, 60s)

- capture ≥ 58 FPS
- encode ≥ 55 FPS
- render ≥ 55 FPS

Se não alcançar, o painel "Detalhes" mostra o gargalo real. Nunca reduzir
silenciosamente para 30 FPS enquanto a UI mostra 60.

## Como registrar sem maquiar

- FPS exibido é o **real medido**, não estimado.
- Use a mesma cena/rede; rode os cenários próximos no tempo.
- Registre mínimo, média e máximo — não só a média.

## Estado atual

Telemetria corrigida (Bug 1–5): renderedFps não é zerado por leitura dupla, o
sample não gera ReferenceError, encodedFps mede produção real, adaptive
recupera, e o status é consistente após resize. Os números reais de 1080p60/60s
precisam ser coletados em campo.
