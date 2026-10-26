import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { migrar } from '../../src/main/db/migrar.js';
import { chaveNomeCliente } from '../../src/compartilhado/formato/nomeCliente.js';
import { bancoLimpo, criarProduto, verificarInvariantes, log } from './ajuda.js';
import { obterBanco } from '../../src/main/db/conexao.js';
import * as clientes from '../../src/main/repos/clientesRepo.js';
import * as vendas from '../../src/main/servicos/vendaServico.js';
import * as fiado from '../../src/main/servicos/fiadoServico.js';
import * as relatorios from '../../src/main/repos/relatoriosRepo.js';

function preparar(){
  const db=bancoLimpo();
  const clienteId=clientes.salvar(null,{nome:'Cliente fictício do recebimento conjunto'});
  const produtos=[criarProduto({nome:'Produto fictício A',precoCentavos:2000}),criarProduto({nome:'Produto fictício B',precoCentavos:1000})];
  const vs=produtos.map((produtoId,i)=>vendas.finalizar({operacaoId:randomUUID(),clienteId,itens:[{produtoId,qtdMilesimal:1000}],pagamentos:[{forma:'fiado',valorCentavos:i===0?2000:1000}]},{log}));
  const contas=db.prepare('SELECT * FROM contas_receber ORDER BY id').all();
  const sessaoId=fiado.abrirCaixa({operador:'Operador fictício'});
  const entrada={operacaoId:randomUUID(),clienteId,sessaoId,valorCentavos:2500,forma:'pix',recebidoCentavos:null};
  return {db,clienteId,produtos,vs,contas,sessaoId,entrada};
}
test('um recebimento de 25 quita compra antiga de 20 e abate 5 na compra de 10',()=>{
  const {db,clienteId,contas,entrada}=preparar();
  const estoqueAntes=db.prepare('SELECT * FROM estoque_movimentos').all();
  const r=fiado.receberCliente(entrada);
  assert.equal(r.saldoCentavos,500);
  assert.deepEqual(r.rateio.map(p=>[p.contaId,p.valorCentavos]),[[contas[0].id,2000],[contas[1].id,500]]);
  assert.deepEqual(db.prepare('SELECT status,valor_pago_centavos FROM contas_receber ORDER BY id').all(),[
    {status:'paga',valor_pago_centavos:2000},{status:'parcial',valor_pago_centavos:500}]);
  const extrato=fiado.extrato(clienteId);
  assert.equal(extrato.recebimentos.length,1);
  assert.equal(extrato.recebimentos[0].valor_centavos,2500);
  assert.equal(extrato.recebimentos[0].distribuicao.length,2);
  assert.equal(extrato.pagamentos.length,2);
  assert.equal(db.prepare('SELECT SUM(valor_centavos) n FROM caixa_movimentos').get().n,2500);
  assert.equal(relatorios.fiadoDoPeriodo('2000-01-01','2099-12-31').recebidoCentavos,2500);
  assert.deepEqual(db.prepare('SELECT * FROM estoque_movimentos').all(),estoqueAntes);
  assert.deepEqual(verificarInvariantes(),[]);
});
test('troco e valor entregue são registrados uma única vez na soma das distribuições',()=>{
  const {db,entrada}=preparar();
  const r=fiado.receberCliente({...entrada,forma:'dinheiro',recebidoCentavos:3000});
  assert.equal(r.trocoCentavos,500);
  assert.deepEqual(db.prepare('SELECT SUM(valor_centavos) aplicado,SUM(valor_recebido_centavos) entregue,SUM(troco_centavos) troco FROM contas_receber_pagamentos').get(),{aplicado:2500,entregue:3000,troco:500});
  assert.deepEqual(verificarInvariantes(),[]);
});
test('reenvio do conjunto é idempotente mesmo após fechamento do caixa',()=>{
  const {db,entrada,sessaoId}=preparar();
  const r=fiado.receberCliente(entrada);
  fiado.fecharCaixa({sessaoId});
  assert.deepEqual(fiado.receberCliente(entrada),{...r,repetido:true});
  assert.equal(db.prepare('SELECT count(*) n FROM recebimentos_fiado').get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM contas_receber_pagamentos').get().n,2);
  assert.throws(()=>fiado.receberCliente({...entrada,valorCentavos:2400}),/outros dados/);
});
test('falha na segunda distribuição desfaz o recebimento inteiro',()=>{
  const {db,entrada,contas}=preparar();
  db.exec(`CREATE TRIGGER falhar_segunda BEFORE INSERT ON contas_receber_pagamentos WHEN NEW.conta_id=${contas[1].id} BEGIN SELECT RAISE(ABORT,'falha simulada'); END`);
  const antes=db.serialize();
  assert.throws(()=>fiado.receberCliente(entrada),/falha simulada/);
  assert.deepEqual(db.serialize(),antes);
});
test('saldo alterado após prévia exige nova conferência sem receber de novo',()=>{
  const {db,entrada,contas,sessaoId}=preparar();
  fiado.receber({operacaoId:randomUUID(),contaId:contas[0].id,sessaoId,valorCentavos:500,forma:'pix'});
  const antes=db.serialize();
  assert.throws(()=>fiado.receberCliente({...entrada,rateioEsperado:[{contaId:contas[0].id,valorCentavos:2000},{contaId:contas[1].id,valorCentavos:500}]}),/saldos mudaram/);
  assert.deepEqual(db.serialize(),antes);
});
test('quita todo saldo de cliente inativo e preserva bloqueio de cancelamento',()=>{
  const {clienteId,entrada,vs}=preparar();
  clientes.definirAtivo(clienteId,false);
  assert.equal(fiado.receberCliente({...entrada,valorCentavos:3000}).saldoCentavos,0);
  assert.equal(fiado.extrato(clienteId).contas.every(c=>c.status==='paga'),true);
  for(const v of vs) assert.throws(()=>vendas.cancelar({vendaId:v.vendaId,motivo:'Teste fictício'},{log}),/já recebeu/);
});
test('recusa valor inválido, caixa fechado e não inclui dívidas de outro cliente',()=>{
  const {db,entrada,sessaoId}=preparar();
  for(const valorCentavos of [0,-1,3001,2.5,NaN]) assert.throws(()=>fiado.receberCliente({...entrada,valorCentavos}),/valor positivo/);
  const outro=clientes.salvar(null,{nome:'Outro cliente fictício'});
  assert.throws(()=>fiado.receberCliente({...entrada,clienteId:outro}),/saldo total/);
  fiado.fecharCaixa({sessaoId});
  assert.throws(()=>fiado.receberCliente(entrada),/sessão/);
  assert.equal(db.prepare('SELECT count(*) n FROM recebimentos_fiado').get().n,0);
});
test('histórico de produtos usa snapshots e inclui compras canceladas sem somar sua dívida',()=>{
  const {db,clienteId,produtos,vs}=preparar();
  db.prepare('UPDATE produtos SET nome=?,preco_centavos=? WHERE id=?').run('Nome novo fictício',9999,produtos[0]);
  vendas.cancelar({vendaId:vs[1].vendaId,motivo:'Teste fictício'},{log});
  const e=fiado.extrato(clienteId);
  const compra=e.compras.find(c=>c.id===vs[0].vendaId);
  assert.equal(compra.itens[0].descricao,'Produto fictício A');
  assert.equal(compra.itens[0].preco_unit_centavos,2000);
  assert.equal(compra.itens[0].qtd_milesimal,1000);
  assert.equal(e.compras.find(c=>c.id===vs[1].vendaId).status,'cancelada');
  assert.equal(e.saldoCentavos,2000);
});

test('migração 009 preserva recebimentos anteriores sem transformá-los em grupos',()=>{
  const db=new Database(':memory:');
  db.function('nome_cliente_chave',{deterministic:true},chaveNomeCliente);
  const dir=new URL('../../src/main/db/migracoes/',import.meta.url);
  for(const nome of fs.readdirSync(dir).filter(n=>/^00[1-8]_/.test(n)).sort())db.exec(fs.readFileSync(new URL(nome,dir),'utf8'));
  db.pragma('user_version=8');
  db.exec(`INSERT INTO clientes (id,nome,criado_em,atualizado_em) VALUES(1,'Fictício legado de recebimento','2000-01-01','2000-01-01');
    INSERT INTO caixa_sessoes(id,status,data,aberta_em,aberta_por) VALUES(1,'aberta','2000-01-01','2000-01-01','Operador fictício');
    INSERT INTO contas_receber(id,cliente_id,valor_centavos,status,criado_em) VALUES(1,1,500,'aberta','2000-01-01');
    INSERT INTO contas_receber_pagamentos(conta_id,sessao_id,forma,valor_centavos,criado_em) VALUES(1,1,'pix',100,'2000-01-01');
    UPDATE contas_receber SET valor_pago_centavos=100,status='parcial' WHERE id=1;`);
  const antes=db.prepare('SELECT * FROM contas_receber_pagamentos').get();
  const contaAntes=db.prepare('SELECT * FROM contas_receber').get();
  migrar(db,{log});
  assert.deepEqual(db.prepare('SELECT * FROM contas_receber_pagamentos').get(),{...antes,recebimento_grupo_id:null});
  assert.deepEqual(db.prepare('SELECT * FROM contas_receber').get(),contaAntes);
  assert.equal(db.prepare('SELECT count(*) n FROM recebimentos_fiado').get().n,0);
  db.close();
});
