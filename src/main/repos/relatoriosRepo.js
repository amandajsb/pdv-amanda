import { obterBanco } from '../db/conexao.js';

export function fiadoDoPeriodo(dataInicio, dataFim) {
  const db = obterBanco();
  const vendido = db.prepare(`SELECT coalesce(SUM(p.valor_centavos),0) valor FROM pagamentos p
    JOIN vendas v ON v.id=p.venda_id WHERE p.forma='fiado' AND v.status='finalizada' AND v.data BETWEEN ? AND ?`).get(dataInicio,dataFim).valor;
  const formas = db.prepare(`SELECT forma, SUM(valor_centavos) total_centavos FROM contas_receber_pagamentos
    WHERE substr(criado_em,1,10) BETWEEN ? AND ? GROUP BY forma`).all(dataInicio,dataFim);
  const saldo = db.prepare(`SELECT coalesce(SUM(valor_centavos-valor_pago_centavos),0) valor FROM contas_receber WHERE status IN ('aberta','parcial')`).get().valor;
  return { vendidoFiadoCentavos: vendido, recebidoCentavos: formas.reduce((s,f) => s+f.total_centavos,0), saldoAtualCentavos: saldo, formas };
}

// Toda agregação é GROUP BY no SQLite. O protótipo fazia reduce sobre um array
// de todas as vendas já feitas; com dois anos de histórico isso trava a UI a
// cada troca de data.

/**
 * Todo relatório aceita um período (dataInicio..dataFim). Comparação de data
 * ISO "AAAA-MM-DD" funciona por ordem alfabética, então BETWEEN basta — sem
 * precisar de Date. Um único dia é só dataInicio === dataFim.
 */
export function resumoDoPeriodo(dataInicio, dataFim) {
  return obterBanco()
    .prepare(
      `SELECT coalesce(SUM(total_centavos), 0) AS total_centavos,
              count(*)                         AS qtd_vendas,
              coalesce((SELECT SUM(i.qtd_milesimal)
                          FROM venda_itens i JOIN vendas v2 ON v2.id = i.venda_id
                         WHERE v2.data BETWEEN ? AND ? AND v2.status = 'finalizada'), 0) AS itens_milesimal,
              coalesce((SELECT SUM(total_centavos) FROM vendas
                         WHERE data BETWEEN ? AND ? AND status = 'cancelada'), 0) AS cancelado_centavos,
              coalesce((SELECT count(*) FROM vendas
                         WHERE data BETWEEN ? AND ? AND status = 'cancelada'), 0) AS qtd_canceladas,
              -- Lucro só soma o que tem custo cadastrado no item (snapshot do
              -- cadastro no momento da venda) — item sem custo não entra na
              -- conta, pra não fingir que o lucro é maior do que se sabe.
              coalesce((SELECT SUM(i.total_item_centavos - (i.custo_unit_centavos * i.qtd_milesimal) / 1000)
                          FROM venda_itens i JOIN vendas v3 ON v3.id = i.venda_id
                         WHERE v3.data BETWEEN ? AND ? AND v3.status = 'finalizada'
                           AND i.custo_unit_centavos IS NOT NULL), 0) AS lucro_centavos,
              coalesce((SELECT count(*)
                          FROM venda_itens i JOIN vendas v4 ON v4.id = i.venda_id
                         WHERE v4.data BETWEEN ? AND ? AND v4.status = 'finalizada'
                           AND i.custo_unit_centavos IS NULL), 0) AS itens_sem_custo
         FROM vendas
        WHERE data BETWEEN ? AND ? AND status = 'finalizada'`
    )
    .get(
      dataInicio, dataFim, dataInicio, dataFim, dataInicio, dataFim,
      dataInicio, dataFim, dataInicio, dataFim, dataInicio, dataFim
    );
}

export function produtosDoPeriodo(dataInicio, dataFim) {
  return obterBanco()
    .prepare(
      `SELECT i.descricao, i.codigo_barras,
              SUM(i.qtd_milesimal)        AS qtd_milesimal,
              SUM(i.total_item_centavos)  AS total_centavos,
              -- NULL quando algum lançamento do grupo não tem custo — melhor
              -- mostrar "sem info" do que um lucro por produto incompleto.
              CASE WHEN SUM(CASE WHEN i.custo_unit_centavos IS NULL THEN 1 ELSE 0 END) = 0
                   THEN SUM(i.total_item_centavos - (i.custo_unit_centavos * i.qtd_milesimal) / 1000)
                   ELSE NULL END AS lucro_centavos
         FROM venda_itens i JOIN vendas v ON v.id = i.venda_id
        WHERE v.data BETWEEN ? AND ? AND v.status = 'finalizada'
        GROUP BY coalesce(i.produto_id, i.descricao), i.descricao, i.codigo_barras
        ORDER BY total_centavos DESC`
    )
    .all(dataInicio, dataFim);
}

export function porFormaPagamento(dataInicio, dataFim) {
  return obterBanco()
    .prepare(
      `SELECT p.forma, SUM(p.valor_centavos) AS total_centavos, count(*) AS qtd
         FROM pagamentos p JOIN vendas v ON v.id = p.venda_id
        WHERE v.data BETWEEN ? AND ? AND v.status = 'finalizada'
        GROUP BY p.forma
        ORDER BY total_centavos DESC`
    )
    .all(dataInicio, dataFim);
}

/** Últimos dias que tiveram venda — alimenta os chips de atalho do relatório. */
export function diasComVenda(limite = 10) {
  return obterBanco()
    .prepare(
      `SELECT data, SUM(total_centavos) AS total_centavos
         FROM vendas WHERE status = 'finalizada'
        GROUP BY data ORDER BY data DESC LIMIT ?`
    )
    .all(limite);
}

export function estoqueAtual() {
  return obterBanco()
    .prepare(
      `SELECT p.id, p.nome, p.unidade, p.estoque_milesimal, p.estoque_minimo_milesimal,
              (SELECT codigo FROM produto_codigos WHERE produto_id = p.id
                ORDER BY principal DESC, id LIMIT 1) AS codigo
         FROM produtos p
        WHERE p.ativo = 1 AND p.controla_estoque = 1
        ORDER BY p.estoque_milesimal, p.nome`
    )
    .all();
}

/**
 * Produtos com estoque > 0 e validade até dataLimite (ISO), do mais urgente
 * pro menos. Inclui os já vencidos (validade < hoje) — não faz sentido
 * esconder da loja o que já estragou e ainda está na prateleira.
 */
export function produtosAVencer(dataLimite) {
  return obterBanco()
    .prepare(
      `SELECT p.id, p.nome, p.unidade, p.validade, p.estoque_milesimal,
              (SELECT codigo FROM produto_codigos WHERE produto_id = p.id
                ORDER BY principal DESC, id LIMIT 1) AS codigo
         FROM produtos p
        WHERE p.ativo = 1 AND p.controla_estoque = 1 AND p.estoque_milesimal > 0
          AND p.validade IS NOT NULL AND p.validade <= ?
        ORDER BY p.validade`
    )
    .all(dataLimite);
}
