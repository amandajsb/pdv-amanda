import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { bancoLimpo, criarProduto, verificarInvariantes, log } from './ajuda.js';
import { obterBanco } from '../../src/main/db/conexao.js';
import { migrar } from '../../src/main/db/migrar.js';
import * as clientes from '../../src/main/repos/clientesRepo.js';
import * as vendas from '../../src/main/servicos/vendaServico.js';
import * as fiado from '../../src/main/servicos/fiadoServico.js';
import * as relatorios from '../../src/main/repos/relatoriosRepo.js';

function preparar({ vencimento } = {}) {
  bancoLimpo();
  const clienteId = clientes.salvar(null, { nome: 'Cliente fictício de teste' });
  const produtoId = criarProduto({ precoCentavos: 1000, estoque: 10 });
  const entrada = { operacaoId: randomUUID(), clienteId, vencimento,
    itens: [{ produtoId, qtdMilesimal: 1000 }], pagamentos: [{ forma: 'fiado', valorCentavos: 1000 }] };
  return { clienteId, produtoId, entrada };
}
function vender(entrada) { return vendas.finalizar(entrada, { log }); }
function contaDe(vendaId) { return obterBanco().prepare('SELECT * FROM contas_receber WHERE venda_id=?').get(vendaId); }
function recebido(contaId, valorCentavos, sessaoId, extra = {}) {
  return { operacaoId: randomUUID(), contaId, sessaoId, valorCentavos, forma: 'pix', ...extra };
}
function quantidade(tabela) { return obterBanco().prepare(`SELECT count(*) n FROM ${tabela}`).get().n; }

test('cadastro exige nome, aceita opcionais e preserva dados ao inativar', () => {
  bancoLimpo();
  assert.throws(() => clientes.salvar(null, { nome: ' ' }), /nome/);
  const id = clientes.salvar(null, { nome: ' Fictício ', telefone: '', endereco: '', observacoes: '' });
  clientes.definirAtivo(id, false);
  assert.equal(clientes.porId(id).nome, 'Fictício');
  assert.equal(clientes.listar().length, 0);
  assert.equal(clientes.listar({ apenasAtivos: false }).length, 1);
  clientes.definirAtivo(id, true);
  assert.equal(clientes.listar().length, 1);
});

test('fiado cria conta, baixa estoque uma vez e não gera entrada no caixa', () => {
  const { entrada, clienteId, produtoId } = preparar();
  const r = vender(entrada);
  const conta = contaDe(r.vendaId);
  assert.equal(conta.cliente_id, clienteId);
  assert.equal(conta.valor_centavos, 1000);
  assert.equal(conta.vencimento, null);
  assert.equal(conta.status, 'aberta');
  assert.equal(quantidade('caixa_movimentos'), 0);
  assert.equal(obterBanco().prepare('SELECT estoque_milesimal n FROM produtos WHERE id=?').get(produtoId).n, 9000);
  assert.deepEqual(verificarInvariantes(), []);
});

test('fiado exige cliente ativo e identificador, sem limite de crédito', () => {
  const { entrada, clienteId } = preparar();
  assert.throws(() => vender({ ...entrada, operacaoId: undefined }), /operação/);
  assert.throws(() => vender({ ...entrada, clienteId: null }), /cliente/);
  clientes.definirAtivo(clienteId, false);
  assert.throws(() => vender(entrada), /ativo/);
  clientes.definirAtivo(clienteId, true);
  obterBanco().prepare('UPDATE clientes SET limite_credito_centavos=1 WHERE id=?').run(clienteId);
  assert.ok(vender(entrada).vendaId);
});

test('vencimento é opcional, valida datas e não cria atraso sem data', () => {
  const { entrada, clienteId } = preparar();
  for (const vencimento of ['2026-02-30', '26/10/2026', 'inválida']) assert.throws(() => vender({ ...entrada, vencimento }), /vencimento/);
  vender(entrada);
  vender({ ...entrada, operacaoId: randomUUID(), vencimento: '2000-01-01' });
  const c = clientes.listar().find(c => c.id === clienteId);
  assert.equal(c.saldo_centavos, 2000);
  assert.equal(c.vencido_centavos, 1000);
});

test('pagamentos parciais e quitação não tocam estoque e respeitam troco', () => {
  const { entrada, clienteId } = preparar();
  const r = vender(entrada);
  const conta = contaDe(r.vendaId);
  const antes = quantidade('estoque_movimentos');
  const sessaoId = fiado.abrirCaixa({ operador: 'Teste fictício' });
  fiado.receber(recebido(conta.id, 300, sessaoId));
  assert.equal(contaDe(r.vendaId).status, 'parcial');
  assert.equal(fiado.extrato(clienteId).saldoCentavos, 700);
  fiado.receber(recebido(conta.id, 700, sessaoId, { forma: 'dinheiro', recebidoCentavos: 1000 }));
  assert.equal(contaDe(r.vendaId).status, 'paga');
  assert.ok(contaDe(r.vendaId).quitado_em);
  assert.equal(fiado.extrato(clienteId).saldoCentavos, 0);
  assert.equal(quantidade('estoque_movimentos'), antes);
  assert.equal(obterBanco().prepare('SELECT SUM(valor_centavos) n FROM caixa_movimentos').get().n, 1000);
  assert.equal(obterBanco().prepare('SELECT SUM(troco_centavos) n FROM contas_receber_pagamentos').get().n, 300);
  assert.equal(quantidade('pagamentos'), 1);
  assert.deepEqual(verificarInvariantes(), []);
});

test('recebimento recusa caixa fechado, valores inválidos e formas indevidas', () => {
  const { entrada } = preparar();
  const conta = contaDe(vender(entrada).vendaId);
  assert.throws(() => fiado.receber(recebido(conta.id, 100, null)), /sessão/);
  const sessaoId = fiado.abrirCaixa();
  for (const valor of [0,-1,1001,1.5,NaN,Infinity]) assert.throws(() => fiado.receber(recebido(conta.id, valor, sessaoId)), /valor/);
  assert.throws(() => fiado.receber(recebido(conta.id, 100, sessaoId, { forma: 'fiado' })), /forma/);
  assert.throws(() => fiado.receber(recebido(conta.id, 100, sessaoId, { forma: 'dinheiro', recebidoCentavos: 99 })), /insuficiente/);
  assert.equal(quantidade('contas_receber_pagamentos'), 0);
});

test('reenvio da venda não duplica conta ou estoque; dados diferentes são recusados', () => {
  const { entrada } = preparar();
  const r = vender(entrada);
  assert.equal(vender(entrada).vendaId, r.vendaId);
  assert.equal(quantidade('vendas'), 1);
  assert.equal(quantidade('contas_receber'), 1);
  assert.equal(quantidade('estoque_movimentos'), 2);
  assert.throws(() => vender({ ...entrada, vencimento: '2030-01-01' }), /outros dados/);
});

test('reenvio do recebimento é seguro até após fechar sessão; iguais legítimos são aceitos', () => {
  const { entrada } = preparar();
  const conta = contaDe(vender(entrada).vendaId);
  const sessaoId = fiado.abrirCaixa();
  const p = recebido(conta.id, 100, sessaoId);
  const r = fiado.receber(p);
  assert.equal(fiado.receber(p).pagamentoId, r.pagamentoId);
  assert.throws(() => fiado.receber({ ...p, valorCentavos: 200 }), /outros dados/);
  fiado.receber(recebido(conta.id, 100, sessaoId));
  assert.equal(quantidade('contas_receber_pagamentos'), 2);
  assert.equal(quantidade('caixa_movimentos'), 2);
  fiado.fecharCaixa({ sessaoId });
  assert.equal(fiado.receber(p).pagamentoId, r.pagamentoId);
  assert.throws(() => fiado.receber(recebido(conta.id, 100, sessaoId)), /sessão/);
});

test('cliente inativo continua podendo quitar dívidas e consultar histórico', () => {
  const { entrada, clienteId } = preparar();
  const conta = contaDe(vender(entrada).vendaId);
  clientes.definirAtivo(clienteId, false);
  fiado.receber(recebido(conta.id, 1000, fiado.abrirCaixa()));
  assert.equal(fiado.extrato(clienteId).compras.length, 1);
  assert.equal(fiado.extrato(clienteId).saldoCentavos, 0);
});

test('cancelamento sem recebimento preserva conta e reverte estoque apenas uma vez', () => {
  const { entrada, clienteId, produtoId } = preparar();
  const r = vender(entrada);
  vendas.cancelar({ vendaId: r.vendaId, motivo: 'Erro fictício', por: 'Teste' }, { log });
  const conta = contaDe(r.vendaId);
  assert.equal(conta.status, 'cancelada');
  assert.equal(conta.cancelada_motivo, 'Erro fictício');
  assert.ok(conta.cancelada_em);
  assert.equal(fiado.extrato(clienteId).saldoCentavos, 0);
  assert.equal(obterBanco().prepare('SELECT estoque_milesimal n FROM produtos WHERE id=?').get(produtoId).n, 10000);
  assert.throws(() => vendas.cancelar({ vendaId: r.vendaId, motivo: 'Repetição' }, { log }), /já está cancelada/);
  assert.equal(quantidade('estoque_movimentos'), 3);
  assert.throws(() => fiado.receber(recebido(conta.id,100,fiado.abrirCaixa())), /cancelada/);
});

test('cancelamento com recebimento parcial ou total não altera nenhuma tabela', () => {
  for (const valor of [100,1000]) {
    const { entrada } = preparar();
    const r = vender(entrada);
    const conta = contaDe(r.vendaId);
    fiado.receber(recebido(conta.id,valor,fiado.abrirCaixa()));
    const antes = obterBanco().serialize();
    assert.throws(() => vendas.cancelar({ vendaId: r.vendaId, motivo: 'Teste' }, { log }), /já recebeu/);
    assert.deepEqual(obterBanco().serialize(), antes);
  }
});

test('adição e remoção de itens em venda fiada são bloqueadas no serviço', () => {
  const { entrada, produtoId } = preparar();
  const r = vender(entrada);
  const item = obterBanco().prepare('SELECT id FROM venda_itens WHERE venda_id=?').get(r.vendaId);
  assert.throws(() => vendas.adicionarItens(r.vendaId, { itens: [{ produtoId, qtdMilesimal: 1000 }], pagamentos: [{ forma:'pix',valorCentavos:1000 }] }, { log }), /alterar itens/);
  assert.throws(() => vendas.removerItem(r.vendaId,item.id,{ motivo:'Teste',formaReembolso:'pix' }, { log }), /alterar itens/);
});

test('falha ao criar conta desfaz venda, numeração e estoque', () => {
  const { entrada } = preparar();
  const db = obterBanco();
  db.exec("CREATE TRIGGER falhar_conta BEFORE INSERT ON contas_receber BEGIN SELECT RAISE(ABORT,'falha simulada'); END");
  const antes = db.serialize();
  assert.throws(() => vender(entrada), /falha simulada/);
  assert.deepEqual(db.serialize(), antes);
});

test('falha no caixa desfaz recebimento e atualização de saldo', () => {
  const { entrada } = preparar();
  const conta = contaDe(vender(entrada).vendaId);
  const sessaoId = fiado.abrirCaixa();
  const db = obterBanco();
  db.exec("CREATE TRIGGER falhar_caixa BEFORE INSERT ON caixa_movimentos BEGIN SELECT RAISE(ABORT,'falha simulada'); END");
  const antes = db.serialize();
  assert.throws(() => fiado.receber(recebido(conta.id,100,sessaoId)), /falha simulada/);
  assert.deepEqual(db.serialize(), antes);
});

test('saldo divergente é detectado antes de receber', () => {
  const { entrada } = preparar();
  const conta = contaDe(vender(entrada).vendaId);
  obterBanco().prepare('UPDATE contas_receber SET valor_pago_centavos=10 WHERE id=?').run(conta.id);
  assert.throws(() => fiado.receber(recebido(conta.id,100,fiado.abrirCaixa())), /inconsistente/);
});

test('relatório separa venda de recebimento e usa a data efetiva do recebimento', () => {
  const { entrada } = preparar();
  const r = vender(entrada);
  const conta = contaDe(r.vendaId);
  obterBanco().prepare("UPDATE vendas SET data='2000-01-01' WHERE id=?").run(r.vendaId);
  fiado.receber(recebido(conta.id,300,fiado.abrirCaixa()));
  const antigo = relatorios.fiadoDoPeriodo('2000-01-01','2000-01-01');
  assert.equal(antigo.vendidoFiadoCentavos,1000);
  assert.equal(antigo.recebidoCentavos,0);
  const atual = relatorios.fiadoDoPeriodo('2001-01-01','2099-12-31');
  assert.equal(atual.vendidoFiadoCentavos,0);
  assert.equal(atual.recebidoCentavos,300);
  assert.equal(atual.saldoAtualCentavos,700);
});

test('migração 007 preserva cadastro anterior e mantém colunas sem uso', () => {
  const db = new Database(':memory:');
  const dir = new URL('../../src/main/db/migracoes/',import.meta.url);
  for (const nome of fs.readdirSync(dir).filter(n => /^00[1-6]_/.test(n)).sort()) db.exec(fs.readFileSync(new URL(nome,dir),'utf8'));
  db.pragma('user_version=6');
  db.exec("INSERT INTO clientes (nome,telefone,limite_credito_centavos,criado_em,atualizado_em) VALUES ('Fictício legado','000',123,'2000-01-01','2000-01-01')");
  const antes = db.prepare('SELECT * FROM clientes').all();
  migrar(db,{log});
  assert.equal(db.pragma('user_version',{simple:true}),9);
  assert.deepEqual(db.prepare('SELECT * FROM clientes').all(),antes);
  db.close();
});

test('produto repetido no carrinho não contorna validação de estoque', () => {
  const { entrada, produtoId } = preparar();
  assert.throws(() => vender({ ...entrada, itens: [{produtoId,qtdMilesimal:6000},{produtoId,qtdMilesimal:6000}], pagamentos:[{forma:'fiado',valorCentavos:12000}] }), /estoque suficiente/);
  assert.equal(quantidade('vendas'),0);
});

test('falha no estorno de estoque desfaz também o cancelamento da conta', () => {
  const { entrada } = preparar();
  const r = vender(entrada);
  const db = obterBanco();
  db.exec("CREATE TRIGGER falhar_estorno BEFORE INSERT ON estoque_movimentos WHEN NEW.tipo='estorno_venda' BEGIN SELECT RAISE(ABORT,'falha simulada'); END");
  const antes = db.serialize();
  assert.throws(() => vendas.cancelar({vendaId:r.vendaId,motivo:'Teste fictício'},{log}), /falha simulada/);
  assert.deepEqual(db.serialize(),antes);
});

test('migração com contas duplicadas falha sem apagar ou modificar dados anteriores', () => {
  const db = new Database(':memory:');
  const dir = new URL('../../src/main/db/migracoes/',import.meta.url);
  for (const nome of fs.readdirSync(dir).filter(n => /^00[1-6]_/.test(n)).sort()) db.exec(fs.readFileSync(new URL(nome,dir),'utf8'));
  db.pragma('user_version=6');
  db.exec(`INSERT INTO clientes (id,nome,criado_em,atualizado_em) VALUES (1,'Fictício legado','2000-01-01','2000-01-01');
    INSERT INTO vendas (id,numero,uuid,status,subtotal_centavos,total_centavos,criado_em,data,hora)
      VALUES (1,1,'legado-ficticio','finalizada',100,100,'2000-01-01','2000-01-01','00:00:00');
    INSERT INTO contas_receber (cliente_id,venda_id,valor_centavos,status,criado_em)
      VALUES (1,1,50,'aberta','2000-01-01'),(1,1,50,'aberta','2000-01-01');`);
  const antes = db.serialize();
  assert.throws(() => migrar(db,{log}), /Falha na migração/);
  assert.equal(db.pragma('user_version',{simple:true}),6);
  assert.deepEqual(db.serialize(),antes);
  db.close();
});
