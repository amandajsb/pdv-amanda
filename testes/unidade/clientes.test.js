import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { bancoLimpo, log } from './ajuda.js';
import { obterBanco } from '../../src/main/db/conexao.js';
import { migrar } from '../../src/main/db/migrar.js';
import * as clientes from '../../src/main/repos/clientesRepo.js';

test('cadastro recusa nome repetido, inclusive variações de espaços, caixa e acentos', () => {
  bancoLimpo();
  const id = clientes.salvar(null,{nome:'Cliente Fictício'});
  for (const nome of ['Cliente Fictício',' CLIENTE  FICTÍCIO ','cliente ficticio','Cliente\tFicti\u0301cio']) {
    assert.throws(() => clientes.salvar(null,{nome}), erro => erro.codigo === 'CLIENTE_NOME_DUPLICADO' && /sobrenome/.test(erro.message));
  }
  assert.equal(clientes.listar().length,1);
  clientes.definirAtivo(id,false);
  assert.throws(() => clientes.salvar(null,{nome:'cliente fictício'}), /inativos/);
});

test('sobrenomes diferenciam clientes e edição do próprio nome é permitida', () => {
  bancoLimpo();
  const a = clientes.salvar(null,{nome:'Cliente Alfa'});
  const b = clientes.salvar(null,{nome:'Cliente Beta'});
  clientes.salvar(a,{nome:'CLIENTE ALFA',telefone:'000'});
  assert.equal(clientes.porId(a).telefone,'000');
  assert.throws(() => clientes.salvar(b,{nome:' cliente alfa '}), /sobrenome/);
  assert.equal(clientes.porId(b).nome,'Cliente Beta');
});

test('SQLite bloqueia duplicidade por inserção e alteração fora do repositório', () => {
  bancoLimpo();
  clientes.salvar(null,{nome:'Cliente Alfa'});
  const b = clientes.salvar(null,{nome:'Cliente Beta'});
  const db = obterBanco();
  assert.throws(() => db.prepare("INSERT INTO clientes (nome,criado_em,atualizado_em) VALUES (?,'2000-01-01','2000-01-01')").run(' CLIENTE  ALFA '), /CLIENTE_NOME_DUPLICADO/);
  assert.throws(() => db.prepare('UPDATE clientes SET nome=? WHERE id=?').run('cliente alfa',b), /CLIENTE_NOME_DUPLICADO/);
});

test('migração preserva duplicidades anteriores e impede novos cadastros iguais', () => {
  const db = new Database(':memory:');
  const dir = new URL('../../src/main/db/migracoes/',import.meta.url);
  for (const nome of fs.readdirSync(dir).filter(n => /^00[1-7]_/.test(n)).sort()) db.exec(fs.readFileSync(new URL(nome,dir),'utf8'));
  db.pragma('user_version=7');
  db.exec(`INSERT INTO clientes (nome,criado_em,atualizado_em) VALUES
    ('Fictício legado','2000-01-01','2000-01-01'),('FICTÍCIO LEGADO','2000-01-01','2000-01-01');`);
  const antes = db.prepare('SELECT * FROM clientes ORDER BY id').all();
  migrar(db,{log});
  assert.deepEqual(db.prepare('SELECT * FROM clientes ORDER BY id').all(),antes);
  // Cadastro antigo pode ter suas observações atualizadas sem exigir exclusão.
  db.prepare('UPDATE clientes SET nome=?,observacoes=? WHERE id=?').run(antes[0].nome,'Observação fictícia',antes[0].id);
  assert.throws(() => db.exec("INSERT INTO clientes (nome,criado_em,atualizado_em) VALUES ('ficticio legado','2000-01-01','2000-01-01')"), /CLIENTE_NOME_DUPLICADO/);
  db.prepare('UPDATE clientes SET nome=? WHERE id=?').run('Fictício legado Silva',antes[1].id);
  // Reabrir a conexão lógica registra a função mesmo sem migrações pendentes.
  migrar(db,{log});
  assert.equal(db.prepare('SELECT count(*) n FROM clientes').get().n,2);
  db.close();
});

test('busca de clientes encontra iniciais sem acento, telefone e exclui inativos',()=>{
  bancoLimpo();
  const id=clientes.salvar(null,{nome:'Márcia fictícia de teste',telefone:'11987650000'});
  const inativo=clientes.salvar(null,{nome:'Marcia fictícia inativa'});
  clientes.definirAtivo(inativo,false);
  for(const termo of ['mar','MARCIA','  márcia  ficticia ','8765'])assert.deepEqual(clientes.listar({termo}).map(c=>c.id),[id]);
  assert.deepEqual(clientes.listar({termo:'não existe'}),[]);
  assert.deepEqual(clientes.listar({termo:'%_'}),[]);
});
