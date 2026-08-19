# Benchmark — Nyxis Share Browser V2 (WebSocket)

> Estado: **primeiro benchmark WebSocket a ser preenchido em campo**. Este
> documento define o procedimento objetivo para medir e comparar o pipeline
> WebSocket (antigo vs otimizado). WebTransport será comparado depois, na
> etapa experimental — nunca afirmar que melhora algo sem medir.

## Cenários

| cenário | uploader → VPS | VPS → viewer |
|---|---|---|
| A · WebSocket antigo | WebSocket | WebSocket |
| B · WebSocket otimizado (V2) | WebSocket (telemetria + adaptive) | WebSocket |
| C · WebTransport (experimental, depois) | WebTransport | WebSocket |

## Procedimento

Para cada cenário, rode **pelo menos 60 segundos** de 1080p60 no mesmo estado
de máquina/rede, com a mesma cena de movimento, e registre a cada 10s:

| métrica | origem |
|---|---|
| capture FPS | telemetria do broadcaster (`captureFps`) |
| encode FPS | telemetria do broadcaster (`encodedFps`) |
| send FPS | broadcaster (submitted/encoded) |
| receive FPS | viewer (`receivedFps`) |
| decode FPS | viewer (`decodedFps`) |
| render FPS | viewer (`renderedFps`) |
| bitrate real | broadcaster (`actualMbps`) |
| dropped frames | broadcaster (`droppedBeforeEncode`) + viewer (`droppedFrames`) |
| encoder queue | broadcaster (`encoderQueueSize`) |
| latência | viewer (`estimatedLatencyMs`) |
| gargalo | broadcaster (`bottleneck`: CAPTURE/ENCODER/NETWORK/VIEWER) |
| CPU | gerenciador de tarefas / docker stats |
| memória | idem |

## Tabela de exemplo (preencher em campo)

| métrica | A (WS antigo) | B (WS V2) | Δ |
|---|---|---|---|
| capture FPS médio | | | |
| encode FPS médio | | | |
| render FPS médio | | | |
| bitrate médio | | | |
| dropped frames | | | |
| encoder queue max | | | |
| latência média | | | |
| gargalo predominante | | | |
| CPU broadcaster | | | |

## Meta (PC/rede saudáveis, 1080p60, 60s)

- capture ≥ 58 FPS
- encode ≥ 55 FPS
- render ≥ 55 FPS

Se não alcançar, o painel "Detalhes" mostra o gargalo real
(`CAPTURE LIMITED | ENCODER LIMITED | NETWORK LIMITED | VIEWER LIMITED`).
Nunca reduzir silenciosamente para 30 FPS enquanto a UI mostra 60.

## Como registrar sem maquiar

- FPS exibido é o FPS **real medido** pelo encoder/decoder, não estimado.
- Use a mesma cena e rede; rode os cenários próximos no tempo.
- Registre pico, média e mínimos — não só a média.

## Estado atual

Telemetria implementada (broadcaster, viewer, servidor). Os números reais
precisam ser coletados em campo — até lá, nenhuma conclusão sobre qual cenário
é melhor.
