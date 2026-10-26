import { obterBanco } from '../db/conexao.js';
import * as clientes from '../repos/clientesRepo.js';
import { agoraTimestamp, hojeISO } from '../../compartilhado/formato/data.js';
import { exigir, validarOperacao, hashOperacao } from './operacao.js';
import { CODIGOS } from '../util/erros.js';

export function extrato(clienteId) {
  const db = obterBanco();
  const cliente = clientes.porId(clienteId);
  exigir(cliente, 'Cliente não encontrado.');
  const contas = db.prepare(`SELECT r.*, v.numero venda_numero,
    CASE WHEN r.status IN ('aberta','parcial') THEN r.valor_centavos-r.valor_pago_centavos ELSE 0 END saldo_centavos
    FROM contas_receber r LEFT JOIN vendas v ON v.id=r.venda_id WHERE r.cliente_id=? ORDER BY r.id DESC`).all(clienteId);
  const pagamentos = db.prepare(`SELECT p.*, v.numero venda_numero FROM contas_receber_pagamentos p
    JOIN contas_receber r ON r.id=p.conta_id LEFT JOIN vendas v ON v.id=r.venda_id
    WHERE r.cliente_id=? ORDER BY p.id DESC`).all(clienteId);
  const compras = db.prepare(`SELECT id, numero, total_centavos, status, criado_em FROM vendas WHERE cliente_id=? ORDER BY id DESC`).all(clienteId);
  const itens = db.prepare(`SELECT i.* FROM venda_itens i JOIN vendas v ON v.id=i.venda_id
    WHERE v.cliente_id=? ORDER BY i.venda_id,i.seq,i.id`).all(clienteId);
  const itensPorVenda = new Map();
  for (const item of itens) {
    if (!itensPorVenda.has(item.venda_id)) itensPorVenda.set(item.venda_id,[]);
    itensPorVenda.get(item.venda_id).push(item);
  }
  for (const compra of compras) compra.itens = itensPorVenda.get(compra.id) || [];
  const grupos = db.prepare('SELECT * FROM recebimentos_fiado WHERE cliente_id=?').all(clienteId);
  const recebimentos = grupos.map(g => ({ ...g, distribuicao: pagamentos.filter(p => p.recebimento_grupo_id === g.id) }));
  for (const p of pagamentos.filter(p => p.recebimento_grupo_id == null)) recebimentos.push({ ...p, distribuicao: [p] });
  recebimentos.sort((a,b) => b.criado_em.localeCompare(a.criado_em) || b.id-a.id);
  return { cliente, contas, pagamentos, compras, recebimentos, saldoCentavos: contas.reduce((s,c) => s+c.saldo_centavos, 0) };
}

export function caixaAtual() {
  const db = obterBanco();
  const sessao = db.prepare("SELECT * FROM caixa_sessoes WHERE status='aberta'").get() || null;
  const formas = sessao ? db.prepare(`SELECT forma_pagamento forma, SUM(valor_centavos) total_centavos
    FROM caixa_movimentos WHERE sessao_id=? GROUP BY forma_pagamento`).all(sessao.id) : [];
  return { sessao, formas };
}

export function abrirCaixa({ operador = 'Operador' } = {}) {
  const db = obterBanco();
  return db.transaction(() => {
    exigir(!caixaAtual().sessao, 'Já existe uma sessão de caixa aberta.');
    exigir(typeof operador === 'string' && operador.trim(), 'Informe o operador.');
    return db.prepare(`INSERT INTO caixa_sessoes (status,data,aberta_em,aberta_por)
      VALUES ('aberta',?,?,?)`).run(hojeISO(), agoraTimestamp(), operador.trim()).lastInsertRowid;
  }).immediate();
}

export function fecharCaixa({ sessaoId, operador = 'Operador' }) {
  const db = obterBanco();
  return db.transaction(() => {
    const { sessao, formas } = caixaAtual();
    exigir(sessao?.id === sessaoId, 'Essa sessão de caixa não está aberta.');
    exigir(typeof operador === 'string' && operador.trim(), 'Informe o operador.');
    db.prepare(`UPDATE caixa_sessoes SET status='fechada', fechada_em=?, fechada_por=?, esperado_json=? WHERE id=?`)
      .run(agoraTimestamp(), operador.trim(), JSON.stringify(Object.fromEntries(formas.map(f => [f.forma,f.total_centavos]))), sessaoId);
    return true;
  }).immediate();
}

export function receber(entrada) {
  validarOperacao(entrada?.operacaoId);
  const hash = hashOperacao(entrada);
  const db = obterBanco();
  return db.transaction(() => {
    exigir(!db.prepare('SELECT id FROM recebimentos_fiado WHERE operacao_id=?').get(entrada.operacaoId), 'A operação já foi usada em um recebimento do cliente.');
    const anterior = db.prepare('SELECT * FROM contas_receber_pagamentos WHERE operacao_id=?').get(entrada.operacaoId);
    if (anterior) {
      exigir(anterior.requisicao_hash === hash, 'A operação já foi usada com outros dados.');
      return { pagamentoId: anterior.id, contaId: anterior.conta_id, repetido: true };
    }
    const conta = db.prepare('SELECT * FROM contas_receber WHERE id=?').get(entrada.contaId);
    exigir(conta && ['aberta','parcial'].includes(conta.status), 'Conta não encontrada, quitada ou cancelada.');
    exigir(Number.isSafeInteger(conta.valor_centavos) && conta.valor_centavos > 0
      && Number.isSafeInteger(conta.valor_pago_centavos) && conta.valor_pago_centavos >= 0
      && conta.valor_pago_centavos < conta.valor_centavos, 'Saldo inconsistente. Solicite conferência antes de receber.');
    if (conta.venda_id != null) {
      const venda = db.prepare('SELECT status, cliente_id FROM vendas WHERE id=?').get(conta.venda_id);
      exigir(venda?.status === 'finalizada' && venda.cliente_id === conta.cliente_id,
        'Conta e venda inconsistentes. Solicite conferência antes de receber.');
    }
    const soma = db.prepare('SELECT coalesce(SUM(valor_centavos),0) valor FROM contas_receber_pagamentos WHERE conta_id=?').get(conta.id).valor;
    exigir(soma === conta.valor_pago_centavos, 'Saldo inconsistente. Solicite conferência antes de receber.');
    const valor = entrada.valorCentavos;
    exigir(Number.isSafeInteger(valor) && valor > 0 && valor <= conta.valor_centavos - soma, 'Informe um valor positivo até o saldo da conta.');
    exigir(['dinheiro','pix','debito','credito'].includes(entrada.forma), 'Escolha uma forma de recebimento válida.');
    const recebido = entrada.forma === 'dinheiro' ? entrada.recebidoCentavos ?? valor : null;
    exigir(recebido == null || (Number.isSafeInteger(recebido) && recebido >= valor), 'Valor em dinheiro insuficiente.');
    const sessao = caixaAtual().sessao;
    exigir(sessao && sessao.id === entrada.sessaoId, 'Abra uma sessão de caixa antes de receber.', CODIGOS.CAIXA_FECHADO);
    const ts = agoraTimestamp();
    const pago = soma + valor;
    const pagamentoId = db.prepare(`INSERT INTO contas_receber_pagamentos
      (conta_id,sessao_id,forma,valor_centavos,valor_recebido_centavos,troco_centavos,criado_em,criado_por,operacao_id,requisicao_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(conta.id, sessao.id, entrada.forma, valor, recebido,
        recebido == null ? 0 : recebido-valor, ts, sessao.aberta_por, entrada.operacaoId, hash).lastInsertRowid;
    db.prepare(`UPDATE contas_receber SET valor_pago_centavos=?, status=?, quitado_em=? WHERE id=?`)
      .run(pago, pago === conta.valor_centavos ? 'paga' : 'parcial', pago === conta.valor_centavos ? ts : null, conta.id);
    db.prepare(`INSERT INTO caixa_movimentos (sessao_id,tipo,forma_pagamento,valor_centavos,venda_id,conta_receber_id,recebimento_id,criado_em,criado_por)
      VALUES (?,'recebimento_fiado',?,?,?,?,?,?,?)`).run(sessao.id, entrada.forma, valor, conta.venda_id, conta.id, pagamentoId, ts, sessao.aberta_por);
    return { pagamentoId, contaId: conta.id, saldoCentavos: conta.valor_centavos-pago };
  }).immediate();
}

/** Um comando, um cabeçalho e uma transação; o caixa recebe apenas a soma aplicada. */
export function receberCliente(entrada) {
  validarOperacao(entrada?.operacaoId);
  const hash = hashOperacao(entrada);
  const db = obterBanco();
  const resultado = grupo => ({ recebimentoId: grupo.id, saldoCentavos: grupo.saldo_apos_centavos,
    trocoCentavos: grupo.troco_centavos,
    rateio: db.prepare(`SELECT p.conta_id contaId,p.valor_centavos valorCentavos,v.numero vendaNumero
      FROM contas_receber_pagamentos p JOIN contas_receber r ON r.id=p.conta_id
      LEFT JOIN vendas v ON v.id=r.venda_id WHERE p.recebimento_grupo_id=? ORDER BY p.id`).all(grupo.id) });
  return db.transaction(() => {
    const anterior = db.prepare('SELECT * FROM recebimentos_fiado WHERE operacao_id=?').get(entrada.operacaoId);
    if (anterior) {
      exigir(anterior.requisicao_hash === hash,'A operação já foi usada com outros dados.');
      return { ...resultado(anterior), repetido: true };
    }
    exigir(!db.prepare('SELECT id FROM contas_receber_pagamentos WHERE operacao_id=?').get(entrada.operacaoId), 'A operação já foi usada em outro recebimento.');
    exigir(Number.isSafeInteger(entrada.clienteId) && clientes.porId(entrada.clienteId), 'Cliente não encontrado.');
    const contas = db.prepare(`SELECT * FROM contas_receber WHERE cliente_id=? AND status IN ('aberta','parcial')
      ORDER BY criado_em,id`).all(entrada.clienteId);
    const saldo = contas.reduce((s,c) => s+c.valor_centavos-c.valor_pago_centavos,0);
    const valor = entrada.valorCentavos;
    exigir(Number.isSafeInteger(saldo) && Number.isSafeInteger(valor) && valor > 0 && valor <= saldo,
      'Informe um valor positivo até o saldo total do cliente.');
    exigir(['dinheiro','pix','debito','credito'].includes(entrada.forma),'Escolha uma forma de recebimento válida.');
    const recebido = entrada.forma === 'dinheiro' ? entrada.recebidoCentavos ?? valor : null;
    exigir(recebido == null || (Number.isSafeInteger(recebido) && recebido >= valor),'Valor em dinheiro insuficiente.');
    const sessao = caixaAtual().sessao;
    exigir(sessao && sessao.id === entrada.sessaoId,'Abra uma sessão de caixa antes de receber.',CODIGOS.CAIXA_FECHADO);
    let restante = valor;
    const rateio = [];
    for (const conta of contas) {
      exigir(conta.valor_centavos > 0 && conta.valor_pago_centavos >= 0 && conta.valor_pago_centavos < conta.valor_centavos,
        'Saldo inconsistente. Solicite conferência antes de receber.');
      const soma = db.prepare('SELECT coalesce(SUM(valor_centavos),0) n FROM contas_receber_pagamentos WHERE conta_id=?').get(conta.id).n;
      exigir(soma === conta.valor_pago_centavos,'Saldo inconsistente. Solicite conferência antes de receber.');
      if (restante > 0) {
        const aplicado = Math.min(restante,conta.valor_centavos-conta.valor_pago_centavos);
        rateio.push({contaId:conta.id,valorCentavos:aplicado});
        restante -= aplicado;
      }
    }
    if (entrada.rateioEsperado != null) exigir(hashOperacao(entrada.rateioEsperado) === hashOperacao(rateio),
      'Os saldos mudaram. Reabra o recebimento para conferir a distribuição.');
    const troco = recebido == null ? 0 : recebido-valor;
    const ts = agoraTimestamp();
    const id = db.prepare(`INSERT INTO recebimentos_fiado
      (operacao_id,requisicao_hash,cliente_id,sessao_id,forma,valor_centavos,valor_recebido_centavos,troco_centavos,saldo_apos_centavos,criado_em,criado_por)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(entrada.operacaoId,hash,entrada.clienteId,sessao.id,entrada.forma,valor,recebido,troco,saldo-valor,ts,sessao.aberta_por).lastInsertRowid;
    rateio.forEach((r,i) => {
      const operacaoFilha = hashOperacao({recebimentoCliente:entrada.operacaoId,contaId:r.contaId});
      exigir(!db.prepare('SELECT id FROM contas_receber_pagamentos WHERE operacao_id=?').get(operacaoFilha), 'Identificação de distribuição já utilizada.');
      const p = receber({ operacaoId:operacaoFilha,contaId:r.contaId,sessaoId:sessao.id,
        forma:entrada.forma,valorCentavos:r.valorCentavos,
        recebidoCentavos:recebido == null ? null : r.valorCentavos+(i===0?troco:0) });
      db.prepare('UPDATE contas_receber_pagamentos SET recebimento_grupo_id=? WHERE id=?').run(id,p.pagamentoId);
    });
    return resultado(db.prepare('SELECT * FROM recebimentos_fiado WHERE id=?').get(id));
  }).immediate();
}
