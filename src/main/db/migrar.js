import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chaveNomeCliente } from '../../compartilhado/formato/nomeCliente.js';

const DIR_MIGRACOES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migracoes');

/**
 * Runner de migrações baseado em PRAGMA user_version.
 *
 * Aplica na ordem os arquivos `NNN_*.sql` cujo número é maior que a versão
 * atual do banco, cada um em sua própria transação. Se um arquivo falhar, o
 * banco fica exatamente na versão anterior — nunca meio migrado.
 */
export function migrar(db, { dir = DIR_MIGRACOES, log = console } = {}) {
  // Registrar também quando não há migrações pendentes: índices e triggers usam a função.
  db.function('nome_cliente_chave', { deterministic: true }, chaveNomeCliente);
  db.function('texto_busca', { deterministic: true }, chaveNomeCliente);
  const versaoAtual = db.pragma('user_version', { simple: true });
  const pendentes = listarMigracoes(dir).filter((m) => m.versao > versaoAtual);

  if (pendentes.length === 0) return { de: versaoAtual, para: versaoAtual, aplicadas: [] };

  const aplicadas = [];
  for (const m of pendentes) {
    const sql = fs.readFileSync(m.caminho, 'utf8');
    // better-sqlite3 não deixa rodar `exec` dentro de uma transação sua, então
    // o BEGIN/COMMIT é explícito aqui.
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${m.versao}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Falha na migração ${m.arquivo}: ${e.message}`, { cause: e });
    }
    aplicadas.push(m.arquivo);
    log.info?.(`Migração aplicada: ${m.arquivo}`);
  }

  return { de: versaoAtual, para: pendentes[pendentes.length - 1].versao, aplicadas };
}

function listarMigracoes(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .map((f) => ({ arquivo: f, versao: Number(f.slice(0, 3)), caminho: path.join(dir, f) }))
    .sort((a, b) => a.versao - b.versao);
}
