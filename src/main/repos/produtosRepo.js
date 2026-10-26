import { obterBanco } from '../db/conexao.js';
import { agoraTimestamp } from '../../compartilhado/formato/data.js';
import { variacoesCodigo, ehEanValido } from '../../compartilhado/calculos/ean.js';
import { normalizarTextoBusca } from '../../compartilhado/formato/busca.js';

const CAMPOS = `p.id, p.sku, p.nome, p.descricao, p.unidade, p.preco_centavos,
                p.custo_centavos, p.estoque_milesimal, p.estoque_minimo_milesimal,
                p.controla_estoque, p.ativo, p.origem, p.validade, p.fornecedor_id`;

export function porId(id) {
  return obterBanco().prepare(`SELECT ${CAMPOS} FROM produtos p WHERE p.id = ?`).get(id) || null;
}

/**
 * Resolve o que o leitor bipou.
 *
 * Tenta o código exato, depois as variações plausíveis (UPC-A ↔ EAN-13, zeros
 * à esquerda, EAN-8 expandido) e por fim o SKU. É essa cadeia que evita o
 * "produto não encontrado" quando o cadastro tem 13 dígitos e o leitor manda 12.
 *
 * @returns {{produto, codigo, fatorMilesimal, avisoEan:boolean} | null}
 */
export function buscarPorCodigo(codigoBipado) {
  const db = obterBanco();
  const stmt = db.prepare(
    `SELECT ${CAMPOS}, c.codigo AS codigo_encontrado, c.fator_milesimal
       FROM produto_codigos c JOIN produtos p ON p.id = c.produto_id
      WHERE c.codigo = ? AND p.ativo = 1`
  );

  for (const variacao of variacoesCodigo(codigoBipado)) {
    const r = stmt.get(variacao);
    if (r) {
      return {
        produto: limpar(r),
        codigo: r.codigo_encontrado,
        fatorMilesimal: r.fator_milesimal,
        // Avisa, mas não bloqueia: código interno da loja não é EAN válido.
        avisoEan: !ehEanValido(r.codigo_encontrado)
      };
    }
  }

  const porSku = db
    .prepare(`SELECT ${CAMPOS} FROM produtos p WHERE p.sku = ? AND p.ativo = 1`)
    .get(String(codigoBipado).trim());
  if (porSku) return { produto: porSku, codigo: porSku.sku, fatorMilesimal: 1000, avisoEan: false };

  return null;
}

/** Busca por nome ou código, para a tela de estoque e o F2 da venda. */
export function listar({ termo = '', apenasAtivos = true, limite = 200 } = {}) {
  const like = `%${normalizarTextoBusca(termo).replace(/[!%_]/g, '!$&')}%`;
  return obterBanco()
    .prepare(
      `SELECT ${CAMPOS},
              (SELECT codigo FROM produto_codigos WHERE produto_id = p.id
                ORDER BY principal DESC, id LIMIT 1) AS codigo,
              f.nome AS fornecedor_nome
         FROM produtos p
         LEFT JOIN fornecedores f ON f.id = p.fornecedor_id
        WHERE (? = 0 OR p.ativo = 1)
          AND (? = ''
               OR texto_busca(p.nome) LIKE ? ESCAPE '!'
               OR texto_busca(coalesce(p.sku,'')) LIKE ? ESCAPE '!'
               OR EXISTS (SELECT 1 FROM produto_codigos c
                           WHERE c.produto_id = p.id AND texto_busca(c.codigo) LIKE ? ESCAPE '!'))
        ORDER BY p.nome
        LIMIT ?`
    )
    .all(apenasAtivos ? 1 : 0, String(termo).trim(), like, like, like, limite);
}

export function criar(dados) {
  const db = obterBanco();
  const ts = agoraTimestamp();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO produtos (sku, nome, descricao, unidade, preco_centavos, custo_centavos,
                               estoque_milesimal, estoque_minimo_milesimal, controla_estoque,
                               ativo, origem, validade, fornecedor_id, criado_em, atualizado_em)
         VALUES (@sku, @nome, @descricao, @unidade, @preco_centavos, @custo_centavos,
                 0, @estoque_minimo_milesimal, @controla_estoque, 1, @origem,
                 @validade, @fornecedor_id, @ts, @ts)`
      )
      .run({
        sku: dados.sku || null,
        nome: dados.nome,
        descricao: dados.descricao || null,
        unidade: dados.unidade || 'UN',
        preco_centavos: dados.precoCentavos,
        custo_centavos: dados.custoCentavos ?? null,
        estoque_minimo_milesimal: dados.estoqueMinimoMilesimal ?? 5000,
        controla_estoque: dados.controlaEstoque === false ? 0 : 1,
        origem: dados.origem || 'manual',
        validade: dados.validade || null,
        fornecedor_id: dados.fornecedorId || null,
        ts
      });

    const produtoId = info.lastInsertRowid;
    for (const [i, codigo] of (dados.codigos || []).entries()) {
      adicionarCodigo(produtoId, codigo, { principal: i === 0 });
    }
    return produtoId;
  })();
}

/**
 * Atualiza o cadastro. Não mexe em estoque (isso é lançamento no ledger) nem
 * em códigos de barras (isso é adicionarCodigo/removerCodigo) — separar essas
 * três coisas é o que impede o histórico de ficar órfão.
 */
export function atualizar(id, dados) {
  obterBanco()
    .prepare(
      `UPDATE produtos
          SET sku = @sku, nome = @nome, descricao = @descricao, unidade = @unidade,
              preco_centavos = @preco_centavos, custo_centavos = @custo_centavos,
              estoque_minimo_milesimal = @estoque_minimo_milesimal,
              controla_estoque = @controla_estoque, validade = @validade,
              fornecedor_id = @fornecedor_id, atualizado_em = @ts
        WHERE id = @id`
    )
    .run({
      id,
      sku: dados.sku || null,
      nome: dados.nome,
      descricao: dados.descricao || null,
      unidade: dados.unidade || 'UN',
      preco_centavos: dados.precoCentavos,
      custo_centavos: dados.custoCentavos ?? null,
      estoque_minimo_milesimal: dados.estoqueMinimoMilesimal ?? 5000,
      controla_estoque: dados.controlaEstoque === false ? 0 : 1,
      validade: dados.validade || null,
      fornecedor_id: dados.fornecedorId || null,
      ts: agoraTimestamp()
    });
}

/**
 * Produto nunca é apagado: virou histórico de venda, então só é inativado.
 * Os códigos de barras SÃO removidos (produto_codigos não é histórico — venda
 * já guarda o próprio snapshot do código em venda_itens.codigo_barras) pra
 * liberar o código na hora: excluir e cadastrar um produto novo com o mesmo
 * código de barras tem que funcionar, não ficar preso ao índice único do
 * produto antigo.
 */
export function inativar(id) {
  const db = obterBanco();
  db.transaction(() => {
    db.prepare('UPDATE produtos SET ativo = 0, atualizado_em = ? WHERE id = ?').run(agoraTimestamp(), id);
    db.prepare('DELETE FROM produto_codigos WHERE produto_id = ?').run(id);
  })();
}

export function reativar(id) {
  obterBanco()
    .prepare('UPDATE produtos SET ativo = 1, atualizado_em = ? WHERE id = ?')
    .run(agoraTimestamp(), id);
}

export function codigosDe(produtoId) {
  return obterBanco()
    .prepare('SELECT id, codigo, tipo, fator_milesimal, principal FROM produto_codigos WHERE produto_id = ? ORDER BY principal DESC, id')
    .all(produtoId);
}

export function adicionarCodigo(produtoId, codigo, { tipo = 'EAN', fatorMilesimal = 1000, principal = false } = {}) {
  obterBanco()
    .prepare(
      `INSERT INTO produto_codigos (produto_id, codigo, tipo, fator_milesimal, principal, criado_em)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(produtoId, String(codigo).trim(), tipo, fatorMilesimal, principal ? 1 : 0, agoraTimestamp());
}

export function removerCodigo(codigoId) {
  obterBanco().prepare('DELETE FROM produto_codigos WHERE id = ?').run(codigoId);
}

/** Só considera "dono" um produto ATIVO — excluir libera o código pra reuso
 * num cadastro novo, em vez de prender o código a um produto que já sumiu
 * da loja. */
export function donoDoCodigo(codigo) {
  return obterBanco()
    .prepare(
      `SELECT c.produto_id FROM produto_codigos c
         JOIN produtos p ON p.id = c.produto_id
        WHERE c.codigo = ? AND p.ativo = 1`
    )
    .get(String(codigo).trim());
}

function limpar(linha) {
  const { codigo_encontrado, fator_milesimal, ...produto } = linha;
  return produto;
}
