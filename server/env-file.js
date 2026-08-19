/**
 * Lê segredos do ambiente, com suporte a arquivos montados (Docker secrets).
 *
 * `FOO=valor` tem prioridade; na falta, lê `FOO_FILE` (o caminho do arquivo
 * montado pelo Swarm). Isso deixa o mesmo binário rodar com env, `.env` ou
 * `docker secret` sem mudar código.
 */
import fs from 'node:fs';

export function secretEnv(name) {
  const direct = process.env[name];
  if (direct) return direct;
  const file = process.env[`${name}_FILE`];
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      return undefined;
    }
  }
  return undefined;
}