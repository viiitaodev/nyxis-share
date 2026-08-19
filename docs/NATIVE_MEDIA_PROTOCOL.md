# Protocolo de mídia nativa (SRT → WebSocket)

Este documento descreve o formato exato dos bytes e mensagens que o gateway
nativo envia à Activity — e por que ele é idêntico ao caminho do navegador.

## Princípio

O relay (`server/rooms.js`) e o player WebCodecs (`client/src/player.js`) **não
mudaram**. O stream nativo é injetado com o mesmo formato binário do browser,
então todo o resto funciona igual: keyframe sob demanda, "assistir é opt-in",
backpressure e o painel de detalhes.

## Pacote binário (vídeo e áudio)

```
[1B slot][1B tipo][8B timestamp][8B relógio de envio][payload]
```

- **slot**: número do transmissor, atribuído pelo servidor (`{type:'slot'}`).
- **tipo**: `1` = keyframe, `2` = delta, `3` = áudio (idêntico ao broadcaster).
- **timestamp**: µs, ordem de decodificação do quadro (relógio do gateway).
- **relógio de envio**: `Date.now()` de quem envia — usado para estimar atraso.
- **payload**: H.264 em **Annex B** (start codes), sem o AUD.

Esse é o mesmo layout de `shared/broadcaster.js`; o gateway usa
`shared/protocol/packet.mjs` para montá-lo.

## Mensagens de controle

Do gateway (broadcaster) para o servidor:

| tipo | quando |
|---|---|
| `{type:'start'}` | primeiro quadro (keyframe) do fluxo |
| `{type:'config', config}` | ao iniciar ou quando SPS/PPS mudam |
| `{type:'stop'}` | fim do fluxo (desconexão) |

O `config` carrega o que o player precisa para montar o decodificador:

```json
{
  "codec": "avc1.64002A",
  "codedWidth": 1920,
  "codedHeight": 1080,
  "description": "<base64 do box avcC>",
  "source": "native"
}
```

`source` é a única marcação nova: `"native"` para o caminho SRT. O broadcaster
do navegador não envia `source` (fica implícito). O player ignora campos
extras — o campo serve à interface (selo "Sender" no tile) e à telemetria.

Do servidor para o gateway (iguais às do browser):

- `{type:'slot', slot}` — antes de qualquer quadro.
- `{type:'need-keyframe'}` — alguém começou a assistir; o relay usa o próximo
  keyframe como ponto de partida (GOP curto garante recuperação em ~1–2s).
- `{type:'stop-request'}` — a Activity pediu para parar a transmissão.

## Anexo B + avcC: por que essa combinação

Duas opções eram possíveis para o WebCodecs:

1. **Anexo B + description avcC** — o que o browser já faz hoje e o Chromium
   aceita: a `description` traz SPS/PPS como `avcC`, e o chunk carrega NALs com
   start codes. É o caminho já provado nesta base.
2. **AVCC (length-prefixed) + description avcC** — o formato "canônico" do
   spec; exige converter cada AU (re-escrever cada NAL com prefixo de 4 bytes).

Decisão: **Anexo B + avcC**, espelhando o broadcaster existente. Zero mudança
no player e comportamento idêntico ao modo atual. A conversão para AVCC fica
documentada como alternativa se um navegador exigir no futuro (a função
`buildAvcC` já existe em `shared/protocol/h264.mjs`).

O gateway monta `avcC` e a string do codec (`avc1.PPCCLL`) a partir do SPS que
chega no primeiro keyframe — nunca por heurística: o parser lê a NAL de verdade
(`parseSps`, com exp-golomb e remoção de emulation prevention).

## Detecção de keyframe

Um quadro é keyframe **se e somente se** a AU contém uma NAL de tipo `5`
(IDR). O parser agrupa NAL units em AUs por AUD (quando o encoder emite) ou por
SPS/PPS/IDR (fallback). AUs sem NAL de vídeo (só SEI/config) não são emitidas.
Isso está testado em `shared/protocol/h264.test.mjs`.

## Timestamps

O fluxo H.264 cru não carrega PTS. O gateway carimba `timestamp = (agora -
início do fluxo) * 1000` em microssegundos. Suficiente para vídeo vivo, onde o
player desenha assim que decodifica. Revisitar na Fase 4 se o áudio nativo
exigir sincronização por amostra.

## Sequência típica (1080p60)

```
Sender ── SRT ──► VPS (gateway) ── WS ──► relay ── WS ──► espectadores

1. Activity: POST /api/ingest/session → { publish, senderToken }
2. Sender:   POST /api/ingest/session/resolve { token } → publish
3. Sender:   ffmpeg -c:v h264_nvenc … -f mpegts srt://vps:port?streamid=…
4. Gateway:  ffmpeg -i srt://0.0.0.0:port -c:v copy -f h264 pipe:1
5. Gateway:  conecta ws://127.0.0.1/ws?t=<broadcasterToken>
6. Gateway:  primeiro keyframe → {type:'start'} → {type:'config'} → frames
7. Viewer:   {type:'watch'} → {type:'need-keyframe'} → próximo keyframe chega
8. Parar:    Activity envia stop-broadcast → gateway recebe stop-request →
             mata ffmpeg, fecha WS → sessão encerrada (senderToken expira)
```

## Verificação de que a VPS não transcodifica

- Comando do gateway logado: `… -map 0:v:0 -c:v copy -f h264 pipe:1`.
- `ps aux | grep ffmpeg` mostra `-c:v copy` e **nenhum** encoder de saída.
- A Activity recebe exatamente o mesmo `codec`/`description` que o Sender
  codificou — se a VPS recodificasse, o codec mudaria.