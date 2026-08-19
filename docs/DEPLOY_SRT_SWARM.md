# Deploy do Nyxis Share com SRT no Docker Swarm

> Infraestrutura atual: Docker Swarm · Portainer · Traefik v3 · GHCR.
> Domínio: `share.nyxis.com.br` · rede overlay: `nyxis_net`.

## O que muda com o modo nativo

O container da app continua sendo o mesmo serviço HTTP/WSS. O caminho SRT
adiciona **UDP** ao host e exige **ffmpeg dentro do container** (já incluído no
`Dockerfile` — o gateway demuxa com `-c:v copy`, sem transcodificar).

### Serviços

| serviço | papel | observação |
|---|---|---|
| `nyxis-share-app` | Activity + API + WebSocket + gateway nativo (in-process) | 1 réplica no MVP |
| `srt-router` (futuro) | router SRT dedicado (`srt-live-server`) | pós-MVP; hoje o listener SRT é por sessão dentro da app |
| `native-media-gateway` (futuro) | gateway de mídia em processo próprio | a interface `MediaGateway` já isola essa extração |

No vertical slice o gateway roda **dentro** do processo da app: cada sessão
aloca uma porta UDP do pool (`NYXIS_SRT_PORT_RANGE`) e o ffmpeg escuta nela.
Quando houver volume, `srt-router` + `native-media-gateway` saem do processo e
o protocolo não muda.

## Portas

| porta | proto | quem chega | uso |
|---|---|---|---|
| 443 | tcp | Traefik | Activity / API / WebSocket (existente) |
| 4001–4016 | udp | público | SRT ingest (1 porta por sessão) |

Só o range UDP precisa ser publicado no host onde a app roda. O Traefik não
faz balanceamento de UDP para SRT — para o MVP a app roda em 1 réplica fixa
num nó, e o range é publicado como `ports: [ target, published ]` no stack.

## Stack (docker-stack.yml)

```yaml
version: "3.8"

networks:
  nyxis_net:
    external: true

secrets:
  session_secret:
    external: true
  discord_client_secret:
    external: true
  discord_bot_token:
    external: true
  ingest_secret:
    external: true

services:
  nyxis-share-app:
    image: ghcr.io/viiitaodev/nyxis-share:latest
    networks: [nyxis_net]
    environment:
      NODE_ENV: production
      PUBLIC_ORIGIN: https://share.nyxis.com.br
      PORT: "3001"
      DISCORD_CLIENT_ID: "<client id público>"
      NYXIS_SRT_HOST: share.nyxis.com.br
      NYXIS_SRT_PORT_RANGE: "4001-4016"
      SESSION_SECRET_FILE: /run/secrets/session_secret
      DISCORD_CLIENT_SECRET_FILE: /run/secrets/discord_client_secret
      DISCORD_BOT_TOKEN_FILE: /run/secrets/discord_bot_token
      INGEST_SECRET_FILE: /run/secrets/ingest_secret
    ports:
      - target: 4001
        published: 4001
        protocol: udp
        mode: host
      # ... repita para 4002–4016 (ou publique o range no nó via firewall)
    deploy:
      replicas: 1
      restart_policy:
        condition: any
        delay: 5s
      update_config:
        order: start-first
        failure_action: rollback
        delay: 10s
      healthcheck:
        test: ["CMD", "node", "-e",
          "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
        interval: 30s
        timeout: 5s
        retries: 3
        start_period: 15s
    labels:
      - traefik.enable=true
      - traefik.http.routers.nyxis.rule=Host(`share.nyxis.com.br`)
      - traefik.http.routers.nyxis.entrypoints=websecure
      - traefik.http.services.nyxis.loadbalancer.server.port=3001
```

> Nota: o servidor lê `SESSION_SECRET` diretamente do ambiente hoje. Para usar
> segredos do Swarm sem mudar código, rode os segredos por arquivo e aponte as
> variáveis `*_FILE` (o servidor já suporta `*_FILE` quando existir) — ou use
> `docker secret` + `env` no deploy. Os placeholders acima são os contratos;
> **nunca** commitar valores reais de `SESSION_SECRET`, `DISCORD_CLIENT_SECRET`,
> `DISCORD_BOT_TOKEN` ou `INGEST_SECRET`.

## Criar os secrets no Swarm

```bash
echo -n "$(openssl rand -hex 32)" | docker secret create ingest_secret -
echo -n "$(openssl rand -hex 32)" | docker secret create session_secret -
docker secret create discord_client_secret <(echo -n "<...>")
docker secret create discord_bot_token <(echo -n "<...>")
```

## Deploy

```bash
docker stack deploy -c docker-stack.yml nyxis
```

## Update

```bash
docker build -t ghcr.io/viiitaodev/nyxis-share:latest .
docker push ghcr.io/viiitaodev/nyxis-share:latest
docker service update --image ghcr.io/viiitaodev/nyxis-share:latest nyxis_nyxis-share-app
```

## Rollback

```bash
docker service rollback nyxis_nyxis-share-app
```

O `update_config.failure_action: rollback` já devolve ao estado anterior quando
a healthcheck reprova no `start-first`.

## Logs

```bash
docker service logs -f nyxis_nyxis-share-app | grep native-ingest
```

A busca mais útil em produção:

```bash
docker service logs nyxis_nyxis-share-app | grep -E "native-ingest|listener-falhou|broadcaster-rejeitado"
```

## Verificações

- **Healthcheck da app**: `GET /api/health` responde `{ ok, rooms, ingest: { ffmpeg, ports } }`.
- **ffmpeg presente**: `docker exec $(docker ps -q) ffmpeg -version`.
- **Não está transcodificando**: `docker exec $(docker ps -q) ps aux | grep ffmpeg`
  deve mostrar `-c:v copy` e nenhum encoder de saída.
- **UDP aberto**: `nc -u share.nyxis.com.br 4001` (o listener SRT responde).

## Firewall do host

```bash
ufw allow 4001:4016/udp
ufw allow 80,443/tcp
```

## Sessões órfãs

O próprio servidor varre e encerra sessões vencidas (`INGEST_SESSION_TTL`) ou
inativas (`INGEST_IDLE_TTL`), matando o ffmpeg e liberando a porta. Em caso de
crash do container, os processos filhos morrem junto com o PID namespace do
Docker — não sobram zombies.

## Variáveis de ambiente

| variável | padrão | papel |
|---|---|---|
| `NYXIS_SRT_PORT_RANGE` | `4001-4016` | pool de portas UDP por sessão |
| `NYXIS_SRT_HOST` | `localhost` | host anunciado no `publish` (o domínio público) |
| `INGEST_SECRET` | `SESSION_SECRET` | segredo HMAC dos tokens de ingest |
| `INGEST_SESSION_TTL` | `21600` (6h) | vida máxima de uma sessão (s) |
| `INGEST_SENDER_TTL` | `600` (10 min) | validade do token de publicação (s) |
| `INGEST_IDLE_TTL` | `600` (10 min) | fecha sessão sem dados SRT |
| `INGEST_RATE_MAX` | `5` | criações de sessão por minuto por usuário |
| `FFMPEG_PATH` | `ffmpeg` | binário do ffmpeg (pode incluir args; útil em teste) |