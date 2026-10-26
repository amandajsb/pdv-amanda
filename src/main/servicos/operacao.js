import { createHash } from 'node:crypto';
import { ErroNegocio, CODIGOS } from '../util/erros.js';

export function exigir(condicao, mensagem, codigo = CODIGOS.DADOS_INVALIDOS) {
  if (!condicao) throw new ErroNegocio(codigo, mensagem);
}

export function validarOperacao(id) {
  exigir(typeof id === 'string' && /^[a-zA-Z0-9-]{16,100}$/.test(id), 'Identificação da operação inválida.');
}

function ordenar(v) {
  if (Array.isArray(v)) return v.map(ordenar);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, ordenar(v[k])]));
  return v;
}

export function hashOperacao(entrada) {
  return createHash('sha256').update(JSON.stringify(ordenar(entrada))).digest('hex');
}

export function validarVencimento(data) {
  if (data == null || data === '') return null;
  exigir(typeof data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data), 'Informe uma data de vencimento válida.');
  const d = new Date(`${data}T12:00:00Z`);
  exigir(!Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === data, 'Informe uma data de vencimento válida.');
  return data;
}
