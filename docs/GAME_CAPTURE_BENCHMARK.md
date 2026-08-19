# Benchmark — Captura de jogos (Nyxis Share Browser)

> Estado: **código pronto para medir; números a preencher com o teste real**. Este
> documento define o procedimento objetivo (60s) para descobrir o que custa no
> caminho de captura de jogos. O objetivo é medir, nunca presumir vencedor.

## Diagnóstico do gargalo (já implementado)

Quando `captureFps == submittedFps == encodedFps`, `encoderQueueSize == 0` e
`droppedBeforeEncode == 0`, o gargalo está **ANTES do encoder** (captura/browser/
GPU scheduling). Nesse caso o pipeline registra **`CAPTURE STARVED`** e o adaptive
**não** reduz bitrate (não resolve o problema). Os números acompanham o alvo
falhado, não escondem nada.

## Métricas disponíveis (telemetria nova)

| campo | significado |
|---|---|
| `captureFps` / `submittedFps` / `encodedFps` | quadros recebidos / pedidos / produzidos |
| `encoderQueueSize` / `droppedBeforeEncode` | saúde do encoder (0/0 = não é encoder) |
| `documentVisibility` | `visible` \| `hidden` (aba em background) |
| `displaySurface` | `monitor` \| `window` \| `browser` (fonte) |
| `trackReportedFps` | `track.getSettings().frameRate` (pedido na API) |
| `captureWidth` / `captureHeight` | resolução da fonte capturada |
| `workerPipeline` | `true` (DedicatedWorker) \| `false` (main thread) |
| `previewActive` | preview local ligado/desligado |
| `captureFrameIntervalMs` | intervalo alvo da captura (1000/fps) |
| `codec` + `hardwareAcceleration` | codec escolhido; `prefer-hardware` = pedido, NUNCA prova de NVENC |
| `probingSummary` | resultado de cada variante testada (por que H264/VP8) |
| `bottleneck` | `CAPTURE STARVED` \| `ENCODER STARVED` \| `NETWORK LIMITED` \| `VIEWER LIMITED` \| `HEALTHY` |

## Cenários (60 segundos cada)

Mesmo jogo, mesma resolução do jogo, mesma cena de movimento constante,
mesma rede/máquina. O que muda é o caminho de captura/transporte:

| # | pipeline | preview | fonte |
|---|---|---|---|
| 1 | inline (main thread) | ON | monitor |
| 2 | inline (main thread) | OFF | monitor |
| 3 | worker | ON | monitor |
| 4 | worker | OFF | monitor |
| 5 | worker | OFF | janela do jogo |

Procedimento: coloque o jogo em primeiro plano (aba de captura vai para
background), rode movimento constante, meça **60s** a 1920×1080 pedindo 60 FPS.
Registre a cada 5s capture/submitted/encoded, queue, drops, codec, bottleneck e o
FPS do jogo (com ferramenta do próprio jogo ou overlay — anote antes/depois).

## Tabela de preenchimento

| t (s) | capture | submitted | encoded | queue | drop | codec | FPS jogo | bottleneck |
|---|---|---|---|---|---|---|---|---|
| 5 | | | | | | | | |
| 10 | | | | | | | | |
| … | | | | | | | | |
| 60 | | | | | | | | |

### Resumo por cenário

| cenário | capture min/avg/max | encoded FPS | queue | drops | FPS jogo (antes→depois) | bottleneck |
|---|---|---|---|---|---|---|
| 1 inline+monitor+preview | | | | | | |
| 2 inline+monitor+sem preview | | | | | | |
| 3 worker+monitor+preview | | | | | | |
| 4 worker+monitor+sem preview | | | | | | |
| 5 worker+janela+sem preview | | | | | | |

## Checklist — resposta esperada

1. **Causa confirmada** — capture==submitted==encoded com queue/drops 0 ⇒
   `CAPTURE STARVED` (captura/browser/GPU scheduling), não rede.
2. **Monitor vs Janela** — qual entrega mais capture FPS? (não presumir)
3. **Preview ON vs OFF** — quanto o preview custa no capture FPS?
4. **Main thread vs Worker** — o DedicatedWorker ajuda quando a aba está em
   background?
5. **H264 probing** — por que H264/VP8 foi escolhido? (`probingSummary` registra
   cada variante: SUPPORTED/UNSUPPORTED/ERROR+reason)
6. **FPS do jogo antes/depois** — quanto o compartilhamento derruba o jogo?
7. **Capture FPS antes/depois** — melhora com worker/janela/sem preview?
8. **Melhor configuração** — combinação de pipeline+fonte+preview vencedora.
9. **Limite do Chromium** — se o navegador for o limitador, documentar aqui.

## Regras de ouro

- Nunca afirmar "NVENC" sem prova: `prefer-hardware` é um pedido, não um fato.
- Nunca reduzir resolução do JOGO — só a resolução de SAÍDA do Nyxis.
- Não culpar rede quando o gargalo é de captura (`CAPTURE STARVED`).
- Zero instalação continua absoluto: sem app nativo, SRT, OBS, FFmpeg ou driver.

## Estado atual

O pipeline com **DedicatedWorker** (feature-detected, com fallback inline), o
**preview fora do caminho crítico** (desliga em background, transmissão segue),
os **presets GAME 1080p60/900p60/720p60**, o **probing completo de H264**, e a
**telemetria nova** estão implementados. Os números reais precisam ser coletados
com este procedimento em campo.
