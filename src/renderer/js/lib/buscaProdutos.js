import { api, tentar } from '../api.js';
import { escapar } from './dom.js';
import { formatarBRL, formatarQtd, paraMilesimal } from '/compartilhado/formato/moeda.js';

function interpretar(entrada) {
  const mult = entrada.match(/^(\d+(?:[.,]\d+)?)\s*[*x]\s*(.*)$/i);
  return { termo: mult ? mult[2].trim() : entrada.trim(), quantidade: mult ? paraMilesimal(mult[1]) : 1000, explicita: Boolean(mult) };
}

export function instalarBuscaProdutos({ campo, lista, aoEscolher, aoCodigo, bloqueado }) {
  let resultados = [];
  let indice = -1;
  let geracao = 0;
  let timer;
  let selecionando = false;
  function fechar() {
    clearTimeout(timer);
    ++geracao;
    resultados = [];
    indice = -1;
    lista.hidden = true;
    lista.innerHTML = '';
    campo.setAttribute('aria-expanded','false');
    campo.removeAttribute('aria-activedescendant');
  }
  function desenhar() {
    lista.hidden = false;
    campo.setAttribute('aria-expanded','true');
    lista.innerHTML = resultados.length ? resultados.map((p,i) => `<button type="button" role="option"
      id="scan-opcao-${i}" aria-selected="${i === indice}" class="scan-sugestao ${i === indice ? 'ativa' : ''}" data-produto-indice="${i}">
      <span><strong>${escapar(p.nome)}</strong><small>${escapar(p.codigo || p.sku || '')} · Estoque ${formatarQtd(p.estoque_milesimal)} ${escapar(p.unidade)}</small></span>
      <b>${formatarBRL(p.preco_centavos)}</b></button>`).join('') : '<div class="scan-vazio">Nenhum produto encontrado. Tente outro nome ou código.</div>';
    if (indice >= 0) {
      campo.setAttribute('aria-activedescendant',`scan-opcao-${indice}`);
      lista.querySelector(`#scan-opcao-${indice}`)?.scrollIntoView({ block: 'nearest' });
    } else campo.removeAttribute('aria-activedescendant');
  }
  async function buscar() {
    clearTimeout(timer);
    const atual = ++geracao;
    const entrada = campo.value;
    const { termo } = interpretar(entrada);
    if (!termo || bloqueado()) { fechar(); return; }
    const nova = await tentar(() => api.produtos.listar({ termo, limite: 20 }));
    if (atual !== geracao || campo.value !== entrada || document.activeElement !== campo || bloqueado()) return;
    if (!nova) { fechar(); return; }
    resultados = nova; indice = -1; desenhar();
  }
  async function escolher(i) {
    if (selecionando || bloqueado()) return;
    const produto = resultados[i];
    if (!produto) return;
    const { quantidade, explicita } = interpretar(campo.value);
    if (!Number.isSafeInteger(quantidade) || quantidade <= 0) return;
    selecionando = true;
    fechar(); campo.value = '';
    try {
      const completo = await tentar(() => api.produtos.porId(produto.id));
      if (completo?.ativo && !bloqueado()) aoEscolher(completo, produto.codigo || null, quantidade, explicita);
    } finally { selecionando = false; }
  }
  function confirmar() {
    if (bloqueado() || selecionando) return;
    if (indice >= 0 && !lista.hidden) { escolher(indice); return; }
    const entrada = campo.value.trim();
    fechar(); campo.value = '';
    const atual = geracao;
    if (entrada) aoCodigo(entrada, () => geracao === atual && campo.value === '');
  }
  campo.addEventListener('input', () => {
    fechar();
    if (campo.value.trim()) timer = setTimeout(buscar, 120);
  });
  campo.addEventListener('focus', () => { if (campo.value.trim()) buscar(); });
  campo.addEventListener('blur', fechar);
  campo.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirmar(); }
    else if (['ArrowDown','ArrowUp'].includes(e.key) && !lista.hidden && resultados.length) {
      e.preventDefault(); e.stopPropagation();
      indice = e.key === 'ArrowDown' ? Math.min(resultados.length-1,indice+1) : (indice < 0 ? resultados.length-1 : Math.max(0,indice-1));
      desenhar();
    } else if (e.key === 'Escape' && !lista.hidden) { e.preventDefault(); e.stopPropagation(); fechar(); }
  });
  lista.addEventListener('pointerdown', e => e.preventDefault());
  lista.addEventListener('click', e => {
    const opcao = e.target.closest('[data-produto-indice]');
    if (opcao) escolher(Number(opcao.dataset.produtoIndice));
  });
  return { confirmar, fechar, exibir(entrada, produtos) {
    fechar();
    if (bloqueado()) return;
    campo.value = entrada;
    campo.focus();
    // focus pode ter iniciado uma busca; invalida antes de exibir a resposta recebida.
    ++geracao;
    resultados = produtos; indice = -1; desenhar();
  } };
}
