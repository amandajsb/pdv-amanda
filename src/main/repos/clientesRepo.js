import { obterBanco } from '../db/conexao.js';
import { agoraTimestamp } from '../../compartilhado/formato/data.js';
import { hojeISO } from '../../compartilhado/formato/data.js';
import { exigir } from '../servicos/operacao.js';
import { chaveNomeCliente } from '../../compartilhado/formato/nomeCliente.js';

export function porId(id) {
  return obterBanco().prepare('SELECT * FROM clientes WHERE id = ?').get(id) || null;
}

export function listar({ termo = '', apenasAtivos = true } = {}) {
  const like = `%${chaveNomeCliente(termo).replace(/[!%_]/g,'!$&')}%`;
  return obterBanco().prepare(`SELECT c.id, c.nome, c.telefone, c.ativo,
    coalesce((SELECT SUM(valor_centavos - valor_pago_centavos) FROM contas_receber r
      WHERE r.cliente_id = c.id AND r.status IN ('aberta','parcial')), 0) saldo_centavos
    , coalesce((SELECT SUM(valor_centavos - valor_pago_centavos) FROM contas_receber r
      WHERE r.cliente_id=c.id AND r.status IN ('aberta','parcial') AND r.vencimento < ?),0) vencido_centavos
    FROM clientes c WHERE (? = 0 OR c.ativo = 1)
      AND (texto_busca(c.nome) LIKE ? ESCAPE '!' OR texto_busca(coalesce(c.telefone,'')) LIKE ? ESCAPE '!') ORDER BY c.nome LIMIT 500`)
    .all(hojeISO(), apenasAtivos ? 1 : 0, like, like);
}

function campos(d) {
  exigir(typeof d?.nome === 'string' && d.nome.trim().length > 0 && d.nome.trim().length <= 200, 'Informe o nome do cliente (até 200 caracteres).');
  const saida = { nome: d.nome.trim().replace(/\s+/gu, ' '), ts: agoraTimestamp() };
  for (const campo of ['telefone', 'endereco', 'observacoes']) {
    exigir(d[campo] == null || (typeof d[campo] === 'string' && d[campo].length <= 2000), `Campo ${campo} inválido.`);
    saida[campo] = d[campo]?.trim() || null;
  }
  return saida;
}

export function salvar(id, dados) {
  const d = campos(dados);
  const db = obterBanco();
  return db.transaction(() => {
  const anterior = id == null ? null : porId(id);
  if (!anterior || chaveNomeCliente(anterior.nome) !== chaveNomeCliente(d.nome)) {
    const existente = db.prepare('SELECT id FROM clientes WHERE nome_cliente_chave(nome)=? AND (? IS NULL OR id<>?) LIMIT 1')
      .get(chaveNomeCliente(d.nome), id ?? null, id ?? null);
    exigir(!existente, 'Já existe um cliente com esse nome, inclusive entre os inativos. Se for outra pessoa, acrescente um sobrenome ou outro nome para diferenciar.', 'CLIENTE_NOME_DUPLICADO');
  }
  if (id != null) {
    exigir(porId(id), 'Cliente não encontrado.');
    db.prepare(`UPDATE clientes SET nome=@nome, telefone=@telefone, endereco=@endereco,
      observacoes=@observacoes, atualizado_em=@ts WHERE id=@id`).run({ ...d, id });
    return id;
  }
  return db.prepare(`INSERT INTO clientes (nome, telefone, endereco, observacoes, criado_em, atualizado_em)
    VALUES (@nome,@telefone,@endereco,@observacoes,@ts,@ts)`).run(d).lastInsertRowid;
  }).immediate();
}

export function definirAtivo(id, ativo) {
  exigir(porId(id), 'Cliente não encontrado.');
  exigir(typeof ativo === 'boolean', 'Situação do cliente inválida.');
  obterBanco().prepare('UPDATE clientes SET ativo=?, atualizado_em=? WHERE id=?').run(ativo ? 1 : 0, agoraTimestamp(), id);
  return true;
}
