# Nyxis Share Sender — CLI

Transmissão nativa de alta qualidade: captura a tela no Windows, codifica em
H.264 **por hardware** e publica por **SRT** para a VPS. É o caminho "Alta
qualidade" da Activity, feito para jogos e conteúdo com muito movimento.

```
captura nativa → h264_nvenc/amf/qsv → H.264 → SRT → VPS (sem transcode) → Activity
```

## Como funciona

1. Na Activity, escolha **Alta qualidade** e um perfil. Ela cria uma sessão de
   ingest e gera um link.
2. Cole o link no Sender (ou abra pelo deep link).
3. O Sender resolve a sessão, detecta o encoder e publica SRT.
4. O gateway na VPS demuxa sem transcodificar e injeta na Activity.

## Requisitos

- **Windows 10/11** (captura por `ddagrab`/`gdigrab` via FFmpeg).
- **FFmpeg** no PATH (ou `FFMPEG_PATH` apontando para ele).
  - Para NVENC: ffmpeg com `--enable-nvenc` (a maioria das builds para Windows
    inclui).
  - Para AMD/Intel: build com `amf`/`qsv`.
  - Sem hardware: cai no `libx264` (software).
- Node.js 20+ para o CLI.

## Instalar

```bash
npm install
```

## Probe (o que sua máquina tem)

```bash
npm run sender:probe
```

Saída de exemplo:

```
Encoders H.264 disponíveis:
  ✅ NVIDIA NVENC         h264_nvenc
  — AMD AMF              h264_amf (não encontrado)
  — Intel Quick Sync     h264_qsv (não encontrado)
  ✅ libx264 (software)   libx264

Captura: ddagrab (Desktop Duplication)
FFmpeg: ffmpeg version 6.0 ...
```

O probe usa **probing real** — nunca assume que NVIDIA existe.

## Publicar

```bash
# link gerado pela Activity
node apps/sender/src/index.mjs --url "nyxisshare://publish?session=..."
# ou direto (token + servidor)
node apps/sender/src/index.mjs --session <token> --server https://share.nyxis.com.br
```

Opções:

| opção | padrão | descrição |
|---|---|---|
| `--profile` | o da sessão | `720p30` `720p60` `1080p30` `1080p60` |
| `--bitrate` | do perfil | override, ex. `10M` `8.5M` `5000k` |
| `--monitor` | `desktop` | `desktop` ou índice (`0`,`1`,…) — ddagrab |
| `--encoder` | o melhor | força `nvenc` `amf` `qsv` `x264` |
| `--demo` | — | usa `testsrc2` em vez da tela; valida o pipeline sem captura |
| `--probe` | — | mostra encoders/captura e sai |

Enquanto transmite, uma linha de status ao vivo mostra `fps`, `bitrate` e tempo:

```
LIVE 1920x1080 60fps fps=60.0 bitrate=9.4 Mbps drop=0 tempo=01:23
```

Para parar: `Ctrl+C`. O Sender encerra a sessão no servidor (limpa ffmpeg e
porta) e a Activity mostra a transmissão encerrada.

## Como verificar qual encoder está ativo

- `npm run sender:probe` mostra os encoders **disponíveis**.
- Durante a transmissão, a primeira linha do banner mostra o escolhido:
  `GPU encoder: NVIDIA NVENC`.
- Se o hardware estiver com carga (ex. jogo usando a GPU), o ffmpeg pode
  recusar a sessão; o fallback é `libx264`.

## Perfis e bitrates

| perfil | resolução | fps | bitrate sugerido |
|---|---|---|---|
| `720p30` | 1280×720 | 30 | 3–5 Mbps |
| `720p60` | 1280×720 | 60 | 5–7 Mbps |
| `1080p30` | 1920×1080 | 30 | 5–8 Mbps |
| `1080p60` | 1920×1080 | 60 | 8–15 Mbps |

Valores são ponto de partida, nunca limites rígidos — use `--bitrate` para
ajustar. O encode usa baixa latência: B-frames desligados, lookahead mínimo,
GOP curto (2 s) e CBR/VBR limitado.

## Limitações (esta versão)

- CLI (a GUI Tauri vem depois). O deep link `nyxisshare://` é gerado, mas o
  registro do handler de protocolo no Windows é manual até a GUI.
- Só vídeo. Áudio nativo (AAC/Opus) entra depois de o vídeo 1080p60 estar
  validado em campo.
- Um fluxo único por sessão (simulcast vem na Fase 6).
