# Plano técnico — Nyxis Share V2 (Modo Nativo SRT)

> Estado: **Fase 1 implementada (vertical slice)**. Browser Mode permanece intacto e é o
> caminho padrão. Este documento é o contrato da evolução; o protocolo de mídia está
> detalhado em [`NATIVE_MEDIA_PROTOCOL.md`](NATIVE_MEDIA_PROTOCOL.md) e o deploy em
> [`DEPLOY_SRT_SWARM.md`](DEPLOY_SRT_SWARM.md).

## Objetivo

Transformar o Nyxis Share numa solução híbrida:

```
MODO RÁPIDO (inalterado, padrão)
Browser → getDisplayMedia → WebCodecs → WebSocket → VPS → WebSocket → Activity

MODO ALTA QUALIDADE (novo)
Nyxis Share Sender (Windows) → captura nativa → encoder HW → H.264 → SRT → VPS
→ demux SEM transcode → WebSocket → Activity (WebCodecs VideoDecoder)
```

Princípio central: **encode exatamente uma vez**. A VPS recebe, demultiplexa,
identifica keyframes, autentica e encaminha. Nunca decodifica nem recodifica.

## Restrição crítica do Discord

A Activity roda num iframe de `discordsays.com`. Só WebSocket passa por ali —
SRT, WebRTC e UDP estão fora do sandbox. Portanto:

```
SRT          : somente Sender → VPS
WebSocket    : somente VPS → Discord Activity
```

O gateway VPS converte SRT/MPEG-TS em Annex B H.264 e injeta no **protocolo
binário já existente** do relay (mesmo formato, mesmo slot, mesma lógica de
keyframe e opt-in do `rooms.js`). O player WebCodecs da Activity não muda.

## Arquitetura

```
┌─────────────────────────────┐
│ Windows                     │
│ Nyxis Share Sender (CLI)    │
│  CaptureBackend (ddagrab/   │
│    gdigrab via FFmpeg)      │
│  EncoderBackend             │
│    h264_nvenc → h264_amf →  │
│    h264_qsv → libx264       │
│  SrtTransport (publisher)   │
└─────────────┬───────────────┘
              │ SRT / UDP
              ▼
┌─────────────────────────────┐
│ VPS Nyxis                   │
│  SrtTransport (listener,    │
│    porta por sessão)        │
│  Gateway (ffmpeg -c:v copy  │
│    → H.264 Annex B)         │
│  parser H.264 (SPS/PPS/IDR/ │
│    AU)                      │
│  injeção no relay rooms.js  │
│  (conecta como broadcaster) │
└─────────────┬───────────────┘
              │ WSS
              ▼
┌─────────────────────────────┐
│ Discord Activity            │
│  VideoDecoder (WebCodecs)   │
│  canvas                     │
└─────────────────────────────┘
```

## Decisões

### 1. FFmpeg como motor do MVP (Sender e Gateway)

- **Sender**: FFmpeg captura (`ddagrab` preferido, `gdigrab` fallback), codifica
  (`h264_nvenc` → `h264_amf` → `h264_qsv` → `libx264`) e publica SRT (`-f mpegts`).
  O CLI detecta encoders por probing real (`ffmpeg -encoders` + `-h encoder=X`) —
  **não assume NVIDIA**.
- **Gateway**: FFmpeg escuta SRT e demuxa com `-c:v copy` → `-f h264` (Annex B no
  stdout). Zero recodificação — verificado nos args (nunca `-vcodec libx264` etc.).
- A VPS precisa de `ffmpeg` instalado. Sem ele, `POST /api/ingest/session`
  responde 503 com mensagem clara.

### 2. Escolha do segredo dos tokens de ingest

Tokens de ingest são **HMAC-SHA256** próprios (formato idêntico ao `tokens.js`),
assinados com:

```
INGEST_SECRET || SESSION_SECRET   (produção exige pelo menos um dos dois)
```

Decisão documentada: o secret dedicado `INGEST_SECRET` existe para permitir
rotacionar ingest sem invalidar as identidades/room tokens, mas o fallback para
`SESSION_SECRET` mantém o deploy simples numa instância só. O payload carrega
`scope: 'ingest-*'`, então tokens de ingest nunca são aceitos como identidade ou
room token e vice-versa.

### 3. Porta SRT por sessão (pool), não um router global

Para o vertical slice, cada sessão aloca uma porta UDP/SRT dentro de um range
(configurável, `NYXIS_SRT_PORT_RANGE`, ex. `4001-4016`). A porta **é** o
capability: só quem criou a sessão (autenticado) recebe o número, e os números
são aleatórios dentro do range. `streamid` carrega o senderToken para o caminho
futuro via `srtla-receiver`.

Trade-off aceito e registrado como limitação: quando houver volume, migrar para
um SRT router dedicado (`srt-live-server`) atrás do gateway, com `srtla-receiver`
opcional na frente. A interface `SrtTransport` isola essa troca.

### 4. Gateway conecta ao próprio relay como broadcaster

O gateway abre um WebSocket **real** para `ws://127.0.0.1:PORT/ws?t=<broadcasterToken>`
do próprio servidor, usando um broadcasterToken emitido server-side na criação da
sessão. Vantagens:

- `rooms.js` fica 100% intocado: keyframe sob demanda, opt-in, backpressure e
  "não abrir quadro" continuam como estão.
- O player WebCodecs da Activity não muda: o stream nativo é idêntico ao do
  browser para o espectador.
- Nenhuma nova porta interna: tudo trafega no WebSocket já existente.

Isso é a forma atual do `MediaGateway`; a interface permite extraí-lo para um
processo/container próprio (`native-media-gateway`) no futuro sem alterar o
protocolo.

### 5. Anexo B + avcC description (formato da mídia)

Documentado em [`NATIVE_MEDIA_PROTOCOL.md`](NATIVE_MEDIA_PROTOCOL.md). Resumo:

- Gateway envia `config` com `codec: avc1.…` (derivado do SPS), `codedWidth/Height`
  (parsed do SPS) e `description` (base64 de `avcC`), além de `source: 'native'`.
- Chunks binários em **Annex B** (start codes), mesmo formato do broadcaster
  atual — o caminho já provado no Chromium/WebCodecs desta base.
- AUs delimitados por AUD quando o encoder emite (habilitamos `-aud` no Sender),
  com fallback SPS/PPS/IDR.

### 6. Autenticação da sessão de ingest

Fluxo:

1. Activity (identidade assinada) chama `POST /api/ingest/session`
   com `{ identity, roomId, roomToken, profile }`. `roomToken` é o **viewerToken**
   da sala (já nas mãos da Activity), usado como prova de pertencimento à sala:
   o servidor verifica assinatura, `room === roomId`, `role === 'viewer'` e
   `uid` igual ao da identidade.
2. O servidor valida que o usuário ainda não transmite na sala (`rooms.broadcasterOf`),
   aplica rate limit (5 criações/min por usuário), aloca porta SRT, cria a sessão
   e devolve `publish` + `senderToken` (TTL curto, assinado, `scope: ingest-publish`).
3. A Activity monta o deep link `nyxisshare://publish?session=<senderToken>&host=<origin>`.
4. O Sender resolve o token em `POST /api/ingest/session/resolve` (TTL curto,
   anti-replay por expiração) e publica SRT na porta recebida.
5. Parada: o Sender chama `POST /api/ingest/session/stop` com o `senderToken`, ou a
   Activity envia `stop-broadcast` (fluxo já existente) — o gateway recebe
   `stop-request` no WS e encerra ffmpeg + sessão.

Requisitos de segurança atendidos: tokens curtos, expiração, assinatura,
sanitização (streamId gerado no servidor, nunca input do usuário), rate limit,
sem SSRF (a porta vem do pool do servidor, nunca de URL escolhida pelo usuário),
ffmpeg via `spawn(bin, args[])` (nunca shell string com input).

### 7. Ciclo de vida e limpeza

- Sessão expira em `INGEST_SESSION_TTL` (padrão 6h).
- Sessão **inativa** (sem dados SRT) fecha após `INGEST_IDLE_TTL` (padrão 10 min).
- Sweeper roda periodicamente e fecha sessões vencidas/órfãs, sempre passando
  pelo mesmo funil de `stop()` (mata ffmpeg, fecha WS, libera porta).
- SRT se auto-recupera: perda breve é retransmissão do protocolo; queda longa faz
  o ffmpeg sair e o gateway **ressobe** o listener na mesma porta enquanto a
  sessão estiver ativa — reconnect real, não só de nome.
- ffmpeg nunca vira zombie: `child.kill()` no teardown, handlers de `exit` em
  todos os caminhos, e o processo filho não tem herança de stdin.

## Fases

| Fase | Escopo | Estado |
|---|---|---|
| 0 | Auditoria do repositório | ✅ |
| 1 | Vertical slice SRT (este plano) | ✅ |
| 2 | Integração Activity (chooser de modo, deep link, fallback) | ✅ (funcional, UI enxuta) |
| 3 | Sender GUI (Tauri) | ⏳ depois do slice validado |
| 4 | Telemetria completa (SRT RTT/loss/retrans, decode queue, WS backpressure) | ⏳ |
| 5 | Qualidade automática (Auto) | ⏳ depende de 4 |
| 6 | Simulcast HIGH/LOW | ⏳ |
| 7 | SRTLA (OpenIRL/srtla) | ⏳ |

Não começar 3–7 antes de 1 estar validado em campo (critérios de aceite abaixo).

## Critérios de aceite do MVP

1. Sender Windows publica SRT para a VPS. ✅ (código; validação em campo)
2. H.264 na GPU quando houver hardware compatível (probe NVENC→AMF→QSV). ✅
3. VPS não transcodifica (só `-c:v copy`). ✅
4. Activity decodifica com WebCodecs. ✅ (player existente)
5. Discord continua via WebSocket. ✅
6. 1080p60 selecionável. ✅
7. Métricas mostram FPS real (ffmpeg stats). ✅ (básico; detalhamento na Fase 4)
8. Browser Mode continua funcionando. ✅ (nada do caminho antigo foi tocado)
9. Reconnect funciona (SRT auto + respawn do listener). ✅
10. Novo espectador recebe keyframe rapidamente (GOP curto + relay existente). ✅
11. Parar transmissão limpa tudo (ffmpeg + WS + porta + sessão). ✅
12. Sessões órfãs removidas (sweeper). ✅
13. ffmpeg morto/crashado não deixa zombies. ✅
14. Gateway tem healthcheck. ✅ (`/api/health` + probe de ffmpeg; container na
    Fase de deploy)
15. Containers com restart policy (no Swarm deploy file). ✅ (documentado)

## Como verificar que a VPS NÃO transcodifica

- Os logs do gateway registram o comando completo com `-c:v copy`.
- `ps aux | grep ffmpeg` na VPS deve mostrar `-c:v copy` e **nunca** um segundo
  encoder (`libx264`, `nvenc`, etc.).
- O consumo de CPU da VPS fica próximo de zero para o relay de vídeo (demux +
  rede), enquanto um transcode a 1080p60 consumiria dezenas de % de CPU.
- O Sender loga `encoder=…` e a VPS não precisa de GPU nenhuma.

## Limitações reais desta entrega

- Porta por sessão (limite = tamanho do range), não router SRT global.
- Sender é CLI (GUI na Fase 3); deep link `nyxisshare://` é parseável, mas o
  registro do handler de protocolo no Windows é manual até a GUI.
- Áudio nativo ainda não: a slice entrega vídeo 1080p60. Áudio (AAC/Opus) vem
  depois, já validado o vídeo.
- Timestamps dos AUs usam o relógio do gateway (o fluxo h264 cru não carrega
  PTS); suficiente para vídeo vivo, revisitar na Fase 4.
- `streamid` SRT não é validado no listener ffmpeg (a porta é o capability);
  migração para `srt-live-server`/`srtla-receiver` valida o streamid de verdade.
- `source: 'native'` é marcado no `config`; sem novos bytes no protocolo.
