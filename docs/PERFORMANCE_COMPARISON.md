# Comparação de performance — Browser vs Native/SRT

> Este documento **não afirma** que o modo nativo é melhor: só registra o
> procedimento para medir e comparar de forma objetiva. Preencha com números
> reais de uma sessão de teste.

## O que comparar

Rode **pelo menos 60 segundos** em cada modo, no mesmo cenário (mesmo jogo/
cena, mesma rede, mesmo perfil 1080p60) e registre:

| métrica | de onde vem |
|---|---|
| capture FPS | Sender (status ao vivo) / browser (painel) |
| encode FPS | Sender (ffmpeg stats) / browser (painel) |
| viewer rendered FPS | Activity → painel de detalhes (pFps) |
| bitrate | Sender (ffmpeg stats) / browser |
| dropped frames | Sender (`drop=`) / relay (`droppedChunks` em /api/health) |
| latência | Activity (pLag) |
| CPU sender | gerenciador de tarefas do Windows |
| CPU VPS | `docker stats` / `top` |

## Procedimento

1. **Browser**: na Activity, Compartilhamento rápido → 8 Mbps, 60 fps.
2. **Native**: Alta qualidade → 1080p60 → Sender.
3. Para cada um, capture os números a cada 10 s durante 60 s e registre média,
   pico e mínimos.
4. Registre também as quedas: quantas vezes o FPS caiu abaixo de 55 e quanto
   tempo sustentou.

## Tabela de exemplo (preencher)

| métrica | Browser | Native/SRT | Δ |
|---|---|---|---|
| encode FPS médio | | | |
| encode FPS mínimo | | | |
| viewer FPS médio | | | |
| bitrate médio | | | |
| dropped frames | | | |
| latência (ms) | | | |
| CPU sender | | | |
| CPU VPS | | | |

## Critério de aprovação da meta inicial

Em máquina Windows com GPU moderna e rede saudável, 1080p60 nativo deve:

- manter **encode FPS ≥ 55** durante 60 segundos;
- evitar quedas constantes para 30/40 FPS.

FPS exibido deve ser FPS **real medido**, nunca estimado ou maquiado.

## Como registrar sem enviesar

- Use a mesma cena de movimento (o objetivo é jogo/movimento).
- Deixe a rede em condições similares (mesma hora, mesmo caminho).
- Rode os dois modos logo um do outro, no mesmo estado de máquina.

## Estado atual

O pipeline nativo está implementado (vertical slice). Os números reais ainda
precisam ser coletados em campo — até lá, nenhuma conclusão sobre qual é
"melhor".