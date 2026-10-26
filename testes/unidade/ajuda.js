import { abrirBanco, fecharBanco, obterBanco } from '../../src/main/db/conexao.js';
import * as produtosRepo from '../../src/main/repos/produtosRepo.js';

const silencioso = { info() {}, warn() {}, error() {} };

/** Banco em memória com as migrações reais aplicadas. */
export function bancoLimpo() {
  fecharBanco();
  return abrirBanco(':memory:', { log: silencioso });
}

export const log = silencioso;

export function criarProduto({ nome = 'Produto', precoCentavos = 1000, estoque = 10, codigo = null } = {}) {
  const id = produtosRepo.criar({
    nome,
    precoCentavos,
    codigos: codigo ? [codigo] : []
  });
  if (estoque) {
    const db = obterBanco();
    db.prepare(
      `INSERT INTO estoque_movimentos (produto_id, tipo, qtd_milesimal, saldo_apos_milesimal, criado_em, data)
       VALUES (?, 'inventario', ?, ?, '2026-01-01 00:00:00', '2026-01-01')`
    ).run(id, estoque * 1000, estoque * 1000);
    db.prepare('UPDATE produtos SET estoque_milesimal = ? WHERE id = ?').run(estoque * 1000, id);
  }
  return id;
}

/** Checa as invariantes do sistema. Devolve a lista de violações. */
export function verificarInvariantes() {
  const db = obterBanco();
  const violacoes = [];

  const estoque = db
    .prepare(
      `SELECT p.id, p.nome, p.estoque_milesimal AS cache,
              coalesce((SELECT SUM(qtd_milesimal) FROM estoque_movimentos m WHERE m.produto_id = p.id), 0) AS ledger
         FROM produtos p WHERE p.controla_estoque = 1 AND cache <> ledger`
    )
    .all();
  for (const e of estoque) {
    violacoes.push(`[1] Produto ${e.id} "${e.nome}": cache=${e.cache} ledger=${e.ledger}`);
  }

  const totais = db
    .prepare(
      `SELECT v.id, v.numero, v.total_centavos,
              (SELECT coalesce(SUM(total_item_centavos), 0) FROM venda_itens WHERE venda_id = v.id) AS soma_itens,
              v.acrescimo_centavos
         FROM vendas v WHERE v.status = 'finalizada'`
    )
    .all();
  for (const t of totais) {
    // total_item_centavos já vem com o rateio do desconto de venda descontado.
    if (t.total_centavos !== t.soma_itens + t.acrescimo_centavos) {
      violacoes.push(
        `[2] Venda ${t.numero}: total=${t.total_centavos} soma_itens=${t.soma_itens} acrescimo=${t.acrescimo_centavos}`
      );
    }
  }

  const pagos = db
    .prepare(
      `SELECT v.id, v.numero, v.total_centavos,
              (SELECT coalesce(SUM(valor_centavos), 0) FROM pagamentos WHERE venda_id = v.id) AS soma_pag
         FROM vendas v WHERE v.status = 'finalizada'`
    )
    .all();
  for (const p of pagos) {
    if (p.total_centavos !== p.soma_pag) {
      violacoes.push(`[3] Venda ${p.numero}: total=${p.total_centavos} pagamentos=${p.soma_pag}`);
    }
  }

  const contas = db
    .prepare('SELECT id, valor_centavos, valor_pago_centavos, status FROM contas_receber')
    .all();
  for (const c of contas) {
    const soma = db.prepare('SELECT coalesce(SUM(valor_centavos),0) valor FROM contas_receber_pagamentos WHERE conta_id=?').get(c.id).valor;
    if (c.valor_pago_centavos !== soma) violacoes.push(`[5] Conta ${c.id}: acumulado=${c.valor_pago_centavos} recebimentos=${soma}`);
    if (c.valor_pago_centavos > c.valor_centavos) {
      violacoes.push(`[5] Conta ${c.id}: pago=${c.valor_pago_centavos} > valor=${c.valor_centavos}`);
    }
    if ((c.status === 'paga') !== (c.valor_pago_centavos === c.valor_centavos) && c.status !== 'cancelada') {
      violacoes.push(`[5] Conta ${c.id}: status=${c.status} mas pago=${c.valor_pago_centavos}/${c.valor_centavos}`);
    }
  }

  const recebimentosSemCaixa = db.prepare(`SELECT p.id FROM contas_receber_pagamentos p
    LEFT JOIN caixa_movimentos m ON m.recebimento_id=p.id
    WHERE p.operacao_id IS NOT NULL GROUP BY p.id
    HAVING count(m.id) <> 1 OR SUM(m.valor_centavos) <> p.valor_centavos`).all();
  for (const p of recebimentosSemCaixa) violacoes.push(`[6] Recebimento ${p.id}: movimento de caixa inconsistente`);
  const grupos = db.prepare(`SELECT g.id,g.valor_centavos,g.troco_centavos,
    coalesce(SUM(p.valor_centavos),0) aplicado,coalesce(SUM(p.troco_centavos),0) troco
    FROM recebimentos_fiado g LEFT JOIN contas_receber_pagamentos p ON p.recebimento_grupo_id=g.id GROUP BY g.id`).all();
  for(const g of grupos) if(g.aplicado!==g.valor_centavos || g.troco!==g.troco_centavos)
    violacoes.push(`[7] Recebimento do cliente ${g.id}: rateio ou troco inconsistente`);

  return violacoes;
}
