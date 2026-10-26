import { randomUUID } from 'node:crypto';
import { obterBanco } from '../db/conexao.js';
import * as clientes from '../repos/clientesRepo.js';
import * as produtos from '../repos/produtosRepo.js';
import * as estoque from '../repos/estoqueRepo.js';
import * as vendas from './vendaServico.js';
import * as fiado from './fiadoServico.js';

// Chamado exclusivamente depois de redirecionar userData para a pasta temporária.
export function prepararDemonstracao() {
  if (!process.argv.includes('--fiado-demo')) throw new Error('Demonstração não habilitada.');
  const db = obterBanco();
  if (db.prepare('SELECT count(*) n FROM produtos').get().n || db.prepare('SELECT count(*) n FROM clientes').get().n) return;
  db.transaction(() => {
    const clienteId = clientes.salvar(null, { nome: 'Cliente fictício — demonstração', observacoes: 'Cadastro artificial para testar o controle de fiado.' });
    const produtoId = produtos.criar({ nome: 'Produto de demonstração', precoCentavos: 1000, codigos: ['DEMO01'] });
    estoque.lancar(produtoId, 'inventario', 100000, { motivo: 'Dados fictícios de demonstração' });
    const r = vendas.finalizar({ operacaoId: randomUUID(), clienteId,
      itens: [{ produtoId, qtdMilesimal: 3000 }], pagamentos: [{ forma: 'fiado', valorCentavos: 3000 }] });
    const conta = db.prepare('SELECT id FROM contas_receber WHERE venda_id=?').get(r.vendaId);
    const sessaoId = fiado.abrirCaixa({ operador: 'Demonstração' });
    fiado.receber({ operacaoId: randomUUID(), contaId: conta.id, sessaoId, forma: 'dinheiro', valorCentavos: 1000, recebidoCentavos: 1000 });
  })();
}
