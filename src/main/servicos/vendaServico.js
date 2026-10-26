import { randomUUID } from 'node:crypto';
import { obterBanco } from '../db/conexao.js';
import * as vendasRepo from '../repos/vendasRepo.js';
import * as produtosRepo from '../repos/produtosRepo.js';
import * as estoqueRepo from '../repos/estoqueRepo.js';
import * as configRepo from '../repos/configRepo.js';
import { calcularTotais, calcularPagamento } from '../../compartilhado/calculos/totais.js';
import { agoraTimestamp, agoraHora, hojeISO } from '../../compartilhado/formato/data.js';
import { ErroNegocio, CODIGOS } from '../util/erros.js';
import { exigir, validarOperacao, validarVencimento, hashOperacao } from './operacao.js';

/**
 * Finaliza uma venda. Tudo numa única transação: ou a venda inteira existe
 * (cabeçalho, itens, pagamentos, baixa de estoque) ou nada aconteceu.
 *
 * Os totais que chegam do renderer são IGNORADOS para gravação — recalculamos
 * aqui a partir dos itens. Se divergirem, gravamos o nosso e registramos aviso:
 * é sintoma de bug na tela, não motivo para recusar a venda no balcão.
 *
 * @param {{itens:Array, descontoVenda?:object, acrescimoCentavos?:number,
 *          pagamentos:Array, clienteId?:number, operador?:string,
 *          observacoes?:string, totalEsperadoCentavos?:number}} entrada
 */
export function finalizar(entrada, { log = console } = {}) {
  const db = obterBanco();
  const hash = entrada?.operacaoId ? hashOperacao(entrada) : null;
  if (entrada?.operacaoId) validarOperacao(entrada.operacaoId);

  if (!entrada?.itens?.length) {
    throw new ErroNegocio(CODIGOS.CARRINHO_VAZIO, 'Não há itens para finalizar a venda.');
  }

  return db.transaction(() => {
    if (entrada.operacaoId) {
      const anterior = db.prepare('SELECT * FROM vendas WHERE uuid=?').get(entrada.operacaoId);
      if (anterior) {
        exigir(anterior.requisicao_hash === hash, 'A operação já foi usada com outros dados.');
        return { vendaId: anterior.id, numero: anterior.numero, totais: { totalCentavos: anterior.total_centavos }, trocoCentavos: anterior.troco_centavos, repetido: true };
      }
    }
    const fiado = entrada.pagamentos?.some(p => p.forma === 'fiado');
    let vencimento = null;
    if (fiado) {
      validarOperacao(entrada.operacaoId);
      exigir(entrada.pagamentos.length === 1, 'Nesta versão, a venda fiada deve ser integral.');
      exigir(Number.isSafeInteger(entrada.clienteId), 'Selecione um cliente para vender fiado.');
      const cliente = db.prepare('SELECT ativo FROM clientes WHERE id=?').get(entrada.clienteId);
      exigir(cliente?.ativo === 1, 'Selecione um cliente ativo para vender fiado.');
      vencimento = validarVencimento(entrada.vencimento);
    }
    for (const it of entrada.itens) {
      exigir(Number.isSafeInteger(it.qtdMilesimal) && it.qtdMilesimal > 0, 'Quantidade inválida.');
      exigir(it.precoUnitCentavos == null || (Number.isSafeInteger(it.precoUnitCentavos) && it.precoUnitCentavos >= 0), 'Preço inválido.');
    }
    for (const p of entrada.pagamentos || []) {
      exigir(['dinheiro','pix','debito','credito','fiado'].includes(p.forma), 'Forma de pagamento inválida.');
      exigir(Number.isSafeInteger(p.valorCentavos) && p.valorCentavos >= 0, 'Valor de pagamento inválido.');
      exigir(p.recebidoCentavos == null || (p.forma === 'dinheiro' && Number.isSafeInteger(p.recebidoCentavos) && p.recebidoCentavos >= p.valorCentavos), 'Valor recebido inválido.');
    }
    // 1. Resolver cada item contra o cadastro atual e montar o snapshot.
    const itens = entrada.itens.map((it, idx) => {
      const p = produtosRepo.porId(it.produtoId);
      if (!p) {
        throw new ErroNegocio(
          CODIGOS.PRODUTO_NAO_ENCONTRADO,
          `O produto da linha ${idx + 1} não existe mais no cadastro.`
        );
      }
      return {
        seq: idx + 1,
        produto: p,
        codigoBarras: it.codigoBarras ?? null,
        // Preço vem da tela porque a linha pode ter sido aberta antes de uma
        // troca de preço no cadastro; o snapshot é o que o cliente viu.
        precoUnitCentavos: Math.trunc(it.precoUnitCentavos ?? p.preco_centavos),
        qtdMilesimal: Math.trunc(it.qtdMilesimal),
        descontoItemCentavos: Math.trunc(it.descontoItemCentavos || 0)
      };
    });

    // 2. Recalcular os totais aqui, no main.
    const totais = calcularTotais(itens, entrada.descontoVenda, entrada.acrescimoCentavos);
    exigir(Number.isSafeInteger(totais.totalCentavos) && (!fiado || totais.totalCentavos > 0), 'Total da venda inválido.');
    if (
      entrada.totalEsperadoCentavos != null &&
      entrada.totalEsperadoCentavos !== totais.totalCentavos
    ) {
      log.warn?.(
        `Total divergente: tela=${entrada.totalEsperadoCentavos} banco=${totais.totalCentavos}. ` +
        'Gravando o valor calculado no main.'
      );
    }

    // 3. Conferir os pagamentos contra o total recalculado.
    const pagamentos = (entrada.pagamentos || []).map((p) => ({
      forma: p.forma,
      valorCentavos: Math.trunc(p.valorCentavos),
      recebidoCentavos: p.recebidoCentavos != null ? Math.trunc(p.recebidoCentavos) : null,
      bandeira: p.bandeira ?? null,
      parcelas: p.parcelas ?? 1,
      autorizacao: p.autorizacao ?? null
    }));
    const situacao = calcularPagamento(totais.totalCentavos, pagamentos);
    if (!situacao.completo) {
      throw new ErroNegocio(
        CODIGOS.PAGAMENTO_INCOMPLETO,
        situacao.faltaCentavos > 0
          ? 'Os pagamentos informados não cobrem o total da venda.'
          : 'Os pagamentos informados passam do total da venda.',
        { faltaCentavos: situacao.faltaCentavos, totalCentavos: totais.totalCentavos }
      );
    }

    // 4. Conferir estoque antes de gravar qualquer coisa.
    const permiteNegativo = configRepo.obterBooleano('estoque_negativo_permitido');
    if (!permiteNegativo) {
      const quantidades = new Map();
      for (const it of itens) {
        const quantidade = (quantidades.get(it.produto.id) || 0) + it.qtdMilesimal;
        quantidades.set(it.produto.id, quantidade);
        if (it.produto.controla_estoque && it.produto.estoque_milesimal < quantidade) {
          throw new ErroNegocio(
            CODIGOS.ESTOQUE_INSUFICIENTE,
            `"${it.produto.nome}" não tem estoque suficiente.`,
            { produtoId: it.produto.id, disponivelMilesimal: it.produto.estoque_milesimal }
          );
        }
      }
    }

    // 5. Gravar cabeçalho.
    const ts = agoraTimestamp();
    const numero = vendasRepo.proximoNumero();
    const vendaId = vendasRepo.inserirVenda({
      numero,
      uuid: entrada.operacaoId || randomUUID(),
      sessao_id: entrada.sessaoId ?? null,
      cliente_id: entrada.clienteId ?? null,
      status: 'finalizada',
      subtotal_centavos: totais.subtotalCentavos,
      desconto_itens_centavos: totais.descontoItensCentavos,
      desconto_venda_centavos: totais.descontoVendaCentavos,
      desconto_venda_tipo: entrada.descontoVenda?.tipo ?? null,
      desconto_venda_percent: entrada.descontoVenda?.percentual ?? null,
      acrescimo_centavos: totais.acrescimoCentavos,
      total_centavos: totais.totalCentavos,
      troco_centavos: situacao.trocoCentavos,
      operador: entrada.operador || configRepo.obter('operador_padrao', 'Operador'),
      observacoes: entrada.observacoes ?? null,
      criado_em: ts,
      data: hojeISO(),
      hora: agoraHora(),
      origem: 'pdv'
    });

    // 6. Itens + baixa no ledger de estoque.
    itens.forEach((it, i) => {
      const calc = totais.itens[i];
      vendasRepo.inserirItem({
        venda_id: vendaId,
        seq: it.seq,
        produto_id: it.produto.id,
        codigo_barras: it.codigoBarras,
        descricao: it.produto.nome,
        unidade: it.produto.unidade,
        preco_unit_centavos: it.precoUnitCentavos,
        qtd_milesimal: it.qtdMilesimal,
        desconto_item_centavos: calc.descontoItemCentavos,
        rateio_desconto_venda_centavos: calc.rateioDescontoVendaCentavos,
        total_item_centavos: calc.totalItemCentavos,
        custo_unit_centavos: it.produto.custo_centavos ?? null
      });

      estoqueRepo.lancar(it.produto.id, 'venda', -it.qtdMilesimal, {
        vendaId,
        custoUnitCentavos: it.produto.custo_centavos ?? null,
        criadoPor: entrada.operador ?? null
      });
    });

    // 7. Pagamentos.
    for (const p of pagamentos) {
      const trocoDaLinha =
        p.forma === 'dinheiro' && p.recebidoCentavos != null
          ? Math.max(0, p.recebidoCentavos - p.valorCentavos)
          : 0;
      vendasRepo.inserirPagamento({
        venda_id: vendaId,
        forma: p.forma,
        valor_centavos: p.valorCentavos,
        valor_recebido_centavos: p.recebidoCentavos,
        troco_centavos: trocoDaLinha,
        bandeira: p.bandeira,
        parcelas: p.parcelas,
        autorizacao: p.autorizacao,
        criado_em: ts
      });
    }

    db.prepare('UPDATE vendas SET requisicao_hash=? WHERE id=?').run(hash, vendaId);
    if (fiado) {
      db.prepare(`INSERT INTO contas_receber (cliente_id,venda_id,valor_centavos,status,vencimento,descricao,criado_em)
        VALUES (?,?,?,'aberta',?,?,?)`).run(entrada.clienteId, vendaId, totais.totalCentavos,
          vencimento, `Venda ${numero}`, ts);
    }

    // 8. A venda foi gravada: o rascunho de recuperação não serve mais.
    vendasRepo.limparRascunho();

    return { vendaId, numero, totais, trocoCentavos: situacao.trocoCentavos };
  })();
}

/**
 * Anexa itens a uma venda já finalizada — o cliente lembrou de mais uma coisa
 * depois de já ter pago. Não mexe nos itens/pagamentos que já existiam (são
 * histórico), só soma: novas linhas em venda_itens (seq continua de onde
 * parou), baixa de estoque dos itens novos, novo(s) pagamento(s) cobrindo
 * exatamente a diferença, e os totais da venda incrementados (não
 * recalculados do zero — desconto/acréscimo original continuam intocados).
 */
export function adicionarItens(vendaId, { itens, pagamentos, operador }, { log = console } = {}) {
  const db = obterBanco();

  if (!itens?.length) {
    throw new ErroNegocio(CODIGOS.CARRINHO_VAZIO, 'Não há itens para adicionar.');
  }

  return db.transaction(() => {
    const venda = vendasRepo.porId(vendaId);
    if (!venda) throw new ErroNegocio(CODIGOS.VENDA_NAO_ENCONTRADA, 'Venda não encontrada.');
    protegerAlteracaoFiado(db, vendaId);
    exigir(!(pagamentos || []).some(p => p.forma === 'fiado'), 'Registre uma nova venda para adicionar fiado.');
    if (venda.status === 'cancelada') {
      throw new ErroNegocio(CODIGOS.VENDA_JA_CANCELADA, 'Não é possível adicionar itens a uma venda cancelada.');
    }

    const itensResolvidos = itens.map((it, idx) => {
      const p = produtosRepo.porId(it.produtoId);
      if (!p) {
        throw new ErroNegocio(
          CODIGOS.PRODUTO_NAO_ENCONTRADO,
          `O produto da linha ${idx + 1} não existe mais no cadastro.`
        );
      }
      return {
        produto: p,
        codigoBarras: it.codigoBarras ?? null,
        precoUnitCentavos: Math.trunc(it.precoUnitCentavos ?? p.preco_centavos),
        qtdMilesimal: Math.trunc(it.qtdMilesimal)
      };
    });

    const totaisNovos = calcularTotais(itensResolvidos);

    const pagamentosNovos = (pagamentos || []).map((p) => ({
      forma: p.forma,
      valorCentavos: Math.trunc(p.valorCentavos),
      recebidoCentavos: p.recebidoCentavos != null ? Math.trunc(p.recebidoCentavos) : null,
      bandeira: p.bandeira ?? null,
      parcelas: p.parcelas ?? 1,
      autorizacao: p.autorizacao ?? null
    }));
    const situacao = calcularPagamento(totaisNovos.totalCentavos, pagamentosNovos);
    if (!situacao.completo) {
      throw new ErroNegocio(
        CODIGOS.PAGAMENTO_INCOMPLETO,
        situacao.faltaCentavos > 0
          ? 'Os pagamentos informados não cobrem o valor dos itens adicionados.'
          : 'Os pagamentos informados passam do valor dos itens adicionados.',
        { faltaCentavos: situacao.faltaCentavos, totalCentavos: totaisNovos.totalCentavos }
      );
    }

    const permiteNegativo = configRepo.obterBooleano('estoque_negativo_permitido');
    if (!permiteNegativo) {
      for (const it of itensResolvidos) {
        if (it.produto.controla_estoque && it.produto.estoque_milesimal < it.qtdMilesimal) {
          throw new ErroNegocio(
            CODIGOS.ESTOQUE_INSUFICIENTE,
            `"${it.produto.nome}" não tem estoque suficiente.`,
            { produtoId: it.produto.id, disponivelMilesimal: it.produto.estoque_milesimal }
          );
        }
      }
    }

    let seq = vendasRepo.proximoSeq(vendaId);
    const ts = agoraTimestamp();

    itensResolvidos.forEach((it, i) => {
      const calc = totaisNovos.itens[i];
      vendasRepo.inserirItem({
        venda_id: vendaId,
        seq: seq++,
        produto_id: it.produto.id,
        codigo_barras: it.codigoBarras,
        descricao: it.produto.nome,
        unidade: it.produto.unidade,
        preco_unit_centavos: it.precoUnitCentavos,
        qtd_milesimal: it.qtdMilesimal,
        desconto_item_centavos: calc.descontoItemCentavos,
        rateio_desconto_venda_centavos: calc.rateioDescontoVendaCentavos,
        total_item_centavos: calc.totalItemCentavos,
        custo_unit_centavos: it.produto.custo_centavos ?? null
      });

      estoqueRepo.lancar(it.produto.id, 'venda', -it.qtdMilesimal, {
        vendaId,
        custoUnitCentavos: it.produto.custo_centavos ?? null,
        criadoPor: operador ?? null
      });
    });

    for (const p of pagamentosNovos) {
      const trocoDaLinha =
        p.forma === 'dinheiro' && p.recebidoCentavos != null
          ? Math.max(0, p.recebidoCentavos - p.valorCentavos)
          : 0;
      vendasRepo.inserirPagamento({
        venda_id: vendaId,
        forma: p.forma,
        valor_centavos: p.valorCentavos,
        valor_recebido_centavos: p.recebidoCentavos,
        troco_centavos: trocoDaLinha,
        bandeira: p.bandeira,
        parcelas: p.parcelas,
        autorizacao: p.autorizacao,
        criado_em: ts
      });
    }

    vendasRepo.incrementarTotais(vendaId, {
      subtotalCentavos: totaisNovos.subtotalCentavos,
      totalCentavos: totaisNovos.totalCentavos
    });

    log.info?.(`${itensResolvidos.length} item(ns) adicionado(s) à venda ${venda.numero}.`);
    return { vendaId, totaisNovos, trocoCentavos: situacao.trocoCentavos };
  })();
}

/**
 * Remove um item de uma venda já finalizada — devolução parcial, sem cancelar
 * a venda inteira. Nunca apaga nem edita a linha original (é histórico): entra
 * uma linha nova compensatória, negativa, com "(removido)" na descrição. O
 * estoque volta (estorno_venda) e um pagamento negativo registra por onde o
 * dinheiro saiu de volta, mantendo SUM(pagamentos) == vendas.total_centavos.
 */
export function removerItem(vendaId, itemId, { motivo, operador, formaReembolso }, { log = console } = {}) {
  const db = obterBanco();

  if (!motivo || !String(motivo).trim()) {
    throw new ErroNegocio(CODIGOS.DADOS_INVALIDOS, 'Informe o motivo da remoção.');
  }
  if (!formaReembolso) {
    throw new ErroNegocio(CODIGOS.DADOS_INVALIDOS, 'Informe como o valor foi devolvido.');
  }

  return db.transaction(() => {
    const venda = vendasRepo.porId(vendaId);
    if (!venda) throw new ErroNegocio(CODIGOS.VENDA_NAO_ENCONTRADA, 'Venda não encontrada.');
    protegerAlteracaoFiado(db, vendaId);
    exigir(formaReembolso !== 'fiado', 'Fiado não é forma de reembolso.');
    if (venda.status === 'cancelada') {
      throw new ErroNegocio(CODIGOS.VENDA_JA_CANCELADA, 'Não é possível remover itens de uma venda cancelada.');
    }

    const item = vendasRepo.itemPorId(vendaId, itemId);
    if (!item) throw new ErroNegocio(CODIGOS.ITEM_NAO_ENCONTRADO, 'Item não encontrado nessa venda.');
    if (item.total_item_centavos < 0) {
      throw new ErroNegocio(CODIGOS.ITEM_NAO_ENCONTRADO, 'Esse item já é uma remoção — não dá pra remover de novo.');
    }

    if (item.produto_id) {
      estoqueRepo.lancar(item.produto_id, 'estorno_venda', item.qtd_milesimal, {
        vendaId,
        motivo: `Remoção de item da venda ${venda.numero}: ${String(motivo).trim()}`,
        criadoPor: operador ?? null
      });
    }

    // Linha compensatória: mesmo produto, tudo negativo, pra bater a soma de
    // venda_itens.total_item_centavos sem tocar na linha original.
    vendasRepo.inserirItem({
      venda_id: vendaId,
      seq: vendasRepo.proximoSeq(vendaId),
      produto_id: item.produto_id,
      codigo_barras: item.codigo_barras,
      descricao: `${item.descricao} (removido)`,
      unidade: item.unidade,
      preco_unit_centavos: item.preco_unit_centavos,
      qtd_milesimal: -item.qtd_milesimal,
      desconto_item_centavos: -item.desconto_item_centavos,
      rateio_desconto_venda_centavos: -item.rateio_desconto_venda_centavos,
      total_item_centavos: -item.total_item_centavos,
      custo_unit_centavos: item.custo_unit_centavos
    });

    const bruto = item.total_item_centavos + item.desconto_item_centavos + item.rateio_desconto_venda_centavos;
    vendasRepo.incrementarTotais(vendaId, {
      subtotalCentavos: -bruto,
      totalCentavos: -item.total_item_centavos
    });

    vendasRepo.inserirPagamento({
      venda_id: vendaId,
      forma: formaReembolso,
      valor_centavos: -item.total_item_centavos,
      valor_recebido_centavos: null,
      troco_centavos: 0,
      bandeira: null,
      parcelas: 1,
      autorizacao: null,
      criado_em: agoraTimestamp()
    });

    log.info?.(`Item "${item.descricao}" removido da venda ${venda.numero}: ${motivo}`);
    return { vendaId, itemId, reembolsoCentavos: item.total_item_centavos };
  })();
}

/**
 * Cancela uma venda finalizada, revertendo o estoque. Nada é apagado: a venda
 * fica com status 'cancelada' e o estorno entra como movimento novo no ledger.
 */
export function cancelar({ vendaId, motivo, por, sessaoAtualId = null }, { log = console } = {}) {
  const db = obterBanco();

  if (!motivo || !String(motivo).trim()) {
    throw new ErroNegocio(CODIGOS.DADOS_INVALIDOS, 'Informe o motivo do cancelamento.');
  }

  return db.transaction(() => {
    const venda = vendasRepo.porId(vendaId);
    if (!venda) throw new ErroNegocio(CODIGOS.VENDA_NAO_ENCONTRADA, 'Venda não encontrada.');
    if (venda.status === 'cancelada') {
      throw new ErroNegocio(CODIGOS.VENDA_JA_CANCELADA, `A venda ${venda.numero} já está cancelada.`);
    }

    const conta = db.prepare('SELECT * FROM contas_receber WHERE venda_id=?').get(vendaId);
    const temFiado = venda.pagamentos.some(p => p.forma === 'fiado');
    exigir(!temFiado || conta, 'A venda fiada não tem conta vinculada. Solicite conferência.');
    exigir(!conta || (temFiado && conta.cliente_id === venda.cliente_id), 'Conta e venda inconsistentes. Solicite conferência.');
    if (conta) {
      const recebido = db.prepare('SELECT count(*) n FROM contas_receber_pagamentos WHERE conta_id=?').get(conta.id).n;
      exigir(!recebido && conta.valor_pago_centavos === 0 && !venda.pagamentos.some(p => p.forma !== 'fiado' && p.valor_centavos > 0),
        'Esta venda já recebeu pagamentos. O cancelamento exige devolução auditada e está bloqueado nesta versão.', CODIGOS.CONTA_COM_PAGAMENTO);
      exigir(conta.status === 'aberta', 'Situação da conta incompatível com o cancelamento.');
      db.prepare(`UPDATE contas_receber SET status='cancelada',cancelada_em=?,cancelada_por=?,cancelada_motivo=? WHERE id=?`)
        .run(agoraTimestamp(), por ?? venda.operador, String(motivo).trim(), conta.id);
    }

    for (const item of venda.itens) {
      if (item.produto_id) {
        estoqueRepo.lancar(item.produto_id, 'estorno_venda', item.qtd_milesimal, {
          vendaId,
          motivo: `Cancelamento da venda ${venda.numero}`,
          criadoPor: por ?? null
        });
      }
    }

    vendasRepo.marcarCancelada({
      vendaId,
      motivo: String(motivo).trim(),
      por: por ?? null,
      sessaoAtualId,
      em: agoraTimestamp()
    });

    log.info?.(`Venda ${venda.numero} cancelada por ${por ?? 'desconhecido'}: ${motivo}`);
    return { vendaId, numero: venda.numero, totalCentavos: venda.total_centavos };
  })();
}

function protegerAlteracaoFiado(db, vendaId) {
  exigir(!db.prepare('SELECT id FROM contas_receber WHERE venda_id=?').get(vendaId)
    && !db.prepare("SELECT id FROM pagamentos WHERE venda_id=? AND forma='fiado'").get(vendaId),
    'Não é possível alterar itens de venda fiada. Registre uma nova venda ou cancele a venda sem recebimentos.');
}
