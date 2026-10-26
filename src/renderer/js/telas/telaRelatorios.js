import { api, tentar } from '../api.js';
import { $, escapar, aoClicar, mostrarMsg, esconderMsg, toast, confirmar, abrirModal, fecharModal } from '../lib/dom.js';
import { escolherPagamento, escolherForma } from '../lib/pagamento.js';
import { formatarBRL, formatarQtd } from '/compartilhado/formato/moeda.js';
import { formatarDataBR, hojeISO } from '/compartilhado/formato/data.js';
import { calcularTotais } from '/compartilhado/calculos/totais.js';

const NOME_FORMA = {
  dinheiro: 'Dinheiro', pix: 'PIX', debito: 'Débito', credito: 'Crédito', fiado: 'Fiado'
};

// Quantos itens de estoque aparecem no cartão do relatório sem precisar abrir
// o relatório completo — pedido explícito pra não poluir a tela com o
// catálogo inteiro toda vez que alguém olha o período.
const ESTOQUE_RESUMO_LIMITE = 15;

// Guarda o último período carregado, pra exportar em PDF sem precisar buscar
// tudo de novo do banco.
let ultimoRelatorio = null;

export function montar() {
  const secao = $('#tab-relatorios');
  $('#rel-data-inicio').addEventListener('change', renderizar);
  $('#rel-data-fim').addEventListener('change', renderizar);

  aoClicar(secao, '[data-acao]', (el) => {
    if (el.dataset.acao === 'chip') {
      $('#rel-data-inicio').value = el.dataset.data;
      $('#rel-data-fim').value = el.dataset.data;
      renderizar();
    }
    if (el.dataset.acao === 'cancelar-venda') cancelarVenda(Number(el.dataset.id), el.dataset.numero);
    if (el.dataset.acao === 'ver-venda') verVenda(Number(el.dataset.id));
    if (el.dataset.acao === 'exportar-pdf-periodo') exportarPeriodoPdf();
    if (el.dataset.acao === 'ver-estoque-completo') abrirEstoqueCompleto();
  });
}

export function aoEntrar() {
  if (!$('#rel-data-inicio').value) $('#rel-data-inicio').value = hojeISO();
  if (!$('#rel-data-fim').value) $('#rel-data-fim').value = hojeISO();
  renderizar();
}

export async function renderizar() {
  let dataInicio = $('#rel-data-inicio').value || hojeISO();
  let dataFim = $('#rel-data-fim').value || hojeISO();

  // Início depois do fim não é erro do operador digitando fora de ordem —
  // é só o par que faz sentido invertido.
  if (dataInicio > dataFim) [dataInicio, dataFim] = [dataFim, dataInicio];
  esconderMsg('#rel-periodo-msg');

  const [relatorio, vendas, estoque, dias, aVencer] = await Promise.all([
    tentar(() => api.relatorios.doPeriodo(dataInicio, dataFim)),
    tentar(() => api.vendas.listarDoPeriodo(dataInicio, dataFim)),
    tentar(() => api.relatorios.estoqueAtual()),
    tentar(() => api.relatorios.diasComVenda(10)),
    tentar(() => api.relatorios.produtosAVencer(10))
  ]);
  if (!relatorio) return;

  const { resumo, produtos, formas } = relatorio;
  const fiado = relatorio.fiado;
  $('#rel-fiado').innerHTML = `<h3>Fiado e recebimentos</h3>
    <p>Vendido fiado no período: <b>${formatarBRL(fiado.vendidoFiadoCentavos)}</b> (contas a receber).</p>
    <p>Recebido de fiado no período: <b>${formatarBRL(fiado.recebidoCentavos)}</b> (pela data do recebimento).</p>
    <p>Saldo devedor atual, de todos os períodos: <b>${formatarBRL(fiado.saldoAtualCentavos)}</b>.</p>
    ${fiado.formas.map(f => `<span>${escapar(NOME_FORMA[f.forma] || f.forma)}: ${formatarBRL(f.total_centavos)} </span>`).join('')}`;
  $('#rel-total').textContent = formatarBRL(resumo.total_centavos);
  $('#rel-itens').textContent = formatarQtd(resumo.itens_milesimal);
  $('#rel-vendas').textContent = resumo.qtd_vendas;
  $('#rel-lucro').textContent = formatarBRL(resumo.lucro_centavos);
  $('#rel-lucro-msg').textContent = resumo.itens_sem_custo
    ? `Não conta ${resumo.itens_sem_custo} item(ns) vendido(s) sem custo cadastrado no produto.`
    : '';

  ultimoRelatorio = { dataInicio, dataFim, resumo, produtos, formas, vendas: vendas || [] };

  desenharChips(dias || [], dataInicio, dataFim);
  desenharProdutos(produtos, formas, resumo);
  desenharVendas(vendas || [], dataInicio !== dataFim);
  desenharEstoque(estoque || []);
  desenharAVencer(aVencer || []);
}

function desenharChips(dias, dataInicio, dataFim) {
  const el = $('#rel-chips');
  if (!dias.length) { el.innerHTML = ''; return; }
  el.innerHTML = dias.map((d) => `
    <span class="chip ${d.data >= dataInicio && d.data <= dataFim ? 'ativo' : ''}" data-acao="chip" data-data="${escapar(d.data)}">
      ${formatarDataBR(d.data)} · ${formatarBRL(d.total_centavos)}
    </span>
  `).join('');
}

function desenharProdutos(produtos, formas, resumo) {
  const el = $('#rel-produtos');
  if (!produtos.length) {
    el.innerHTML = '<div class="empty-state">Nenhuma venda registrada nesse período.</div>';
    return;
  }

  const porForma = formas.length
    ? `<div class="bloco-secundario">
         ${formas.map((f) => `
           <div class="linha-info">
             <span class="rotulo">${NOME_FORMA[f.forma] ?? escapar(f.forma)}</span>
             <span class="valor">${formatarBRL(f.total_centavos)}</span>
           </div>`).join('')}
       </div>`
    : '';

  const canceladas = resumo.qtd_canceladas
    ? `<div class="aviso-cancelado">
         ${resumo.qtd_canceladas} venda(s) cancelada(s) no período, somando ${formatarBRL(resumo.cancelado_centavos)}.
       </div>`
    : '';

  el.innerHTML = `
    <table>
      <thead><tr><th>Produto</th><th class="num">Qtd. vendida</th><th class="num">Total</th><th class="num">Lucro</th></tr></thead>
      <tbody>
        ${produtos.map((p) => `
          <tr>
            <td>${escapar(p.descricao)}</td>
            <td class="num">${formatarQtd(p.qtd_milesimal)}</td>
            <td class="num">${formatarBRL(p.total_centavos)}</td>
            <td class="num">${p.lucro_centavos != null ? formatarBRL(p.lucro_centavos) : '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    ${porForma}
    ${canceladas}
  `;
}

/** "Balcão" pra venda avulsa, ou "Mesa 4 · João" quando veio do fechamento de uma comanda. */
function origemVenda(v) {
  if (!v.comanda_identificador) return 'Balcão';
  return v.comanda_cliente_nome ? `${v.comanda_identificador} · ${v.comanda_cliente_nome}` : v.comanda_identificador;
}

function desenharVendas(vendas, mostrarData) {
  const el = $('#rel-lista-vendas');
  if (!vendas.length) {
    el.innerHTML = '<div class="empty-state">Nenhuma venda nesse período.</div>';
    return;
  }
  el.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Nº</th>${mostrarData ? '<th>Data</th>' : ''}<th>Hora</th>
          <th>Origem</th><th>Forma</th>
          <th class="num">Itens</th><th class="num">Total</th><th>Situação</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${vendas.map((v) => `
          <tr class="${v.status === 'cancelada' ? 'inativo' : ''}">
            <td class="mono">${String(v.numero).padStart(6, '0')}</td>
            ${mostrarData ? `<td class="mono">${formatarDataBR(v.data)}</td>` : ''}
            <td class="mono">${escapar(v.hora)}</td>
            <td>${escapar(origemVenda(v))}</td>
            <td>${(v.formas || '').split(',').filter(Boolean).map((f) => NOME_FORMA[f] ?? f).join(', ') || '—'}</td>
            <td class="num">${v.qtd_itens}</td>
            <td class="num">${formatarBRL(v.total_centavos)}</td>
            <td>${v.status === 'cancelada'
                  ? '<span class="txt-perigo">Cancelada</span>'
                  : '<span class="txt-ok">Finalizada</span>'}</td>
            <td class="acoes-linha">
              <button class="icon-btn" data-acao="ver-venda" data-id="${v.id}" title="Ver detalhes">👁</button>
              ${v.status === 'finalizada'
                ? `<button class="icon-btn del" data-acao="cancelar-venda" data-id="${v.id}"
                           data-numero="${v.numero}" title="Cancelar venda">✕</button>`
                : ''}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
}

function linhaEstoque(p) {
  return `
    <tr class="${p.estoque_milesimal === 0 ? 'zero' : (p.estoque_milesimal <= p.estoque_minimo_milesimal ? 'low' : '')}">
      <td class="mono">${escapar(p.codigo ?? '—')}</td>
      <td>${escapar(p.nome)}</td>
      <td class="num stockcell">${formatarQtd(p.estoque_milesimal)}</td>
    </tr>`;
}

let ultimoEstoqueCompleto = [];

/** Mostra só os produtos com estoque mais baixo (a repoRepo já traz ordenado
 * assim) — a lista inteira polui a tela toda vez que alguém confere um
 * período; quem quiser o catálogo completo abre o relatório dedicado. */
function desenharEstoque(estoque) {
  ultimoEstoqueCompleto = estoque;
  const el = $('#rel-estoque');
  const nota = $('#rel-estoque-nota');

  if (!estoque.length) {
    el.innerHTML = '<div class="empty-state">Nenhum produto cadastrado.</div>';
    nota.textContent = '';
    return;
  }

  const visiveis = estoque.slice(0, ESTOQUE_RESUMO_LIMITE);
  el.innerHTML = `
    <table>
      <thead><tr><th>Código</th><th>Produto</th><th class="num">Estoque restante</th></tr></thead>
      <tbody>${visiveis.map(linhaEstoque).join('')}</tbody>
    </table>
  `;
  nota.textContent = estoque.length > visiveis.length
    ? `Mostrando os ${visiveis.length} produtos com estoque mais baixo, de ${estoque.length} cadastrados no total.`
    : '';
}

/** Dias entre hoje e a validade (negativo = já venceu). Construção local evita o
 * desvio de fuso de `new Date(iso)` que a formatação de datas do app já evita. */
function diasAteValidade(validadeISO) {
  const [a, m, d] = validadeISO.split('-').map(Number);
  const [ah, mh, dh] = hojeISO().split('-').map(Number);
  const ms = new Date(a, m - 1, d) - new Date(ah, mh - 1, dh);
  return Math.round(ms / 86400000);
}

function desenharAVencer(lista) {
  const el = $('#rel-vencer');
  if (!lista.length) {
    el.innerHTML = '<div class="empty-state">Nenhum produto com estoque vencendo nos próximos 10 dias.</div>';
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>Código</th><th>Produto</th><th>Validade</th><th class="num">Dias</th><th class="num">Estoque</th></tr></thead>
      <tbody>
        ${lista.map((p) => {
          const dias = diasAteValidade(p.validade);
          return `
          <tr class="${dias < 0 ? 'zero' : 'low'}">
            <td class="mono">${escapar(p.codigo ?? '—')}</td>
            <td>${escapar(p.nome)}</td>
            <td>${formatarDataBR(p.validade)}</td>
            <td class="num stockcell">${dias < 0 ? `Vencido há ${-dias}d` : `${dias}d`}</td>
            <td class="num">${formatarQtd(p.estoque_milesimal)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ------------------------------ Exportar PDF ------------------------------

async function exportarPeriodoPdf() {
  if (!ultimoRelatorio) return;
  const { dataInicio, dataFim, resumo, produtos, vendas } = ultimoRelatorio;

  const periodo = dataInicio === dataFim
    ? formatarDataBR(dataInicio)
    : `${formatarDataBR(dataInicio)} até ${formatarDataBR(dataFim)}`;

  const html = `
    <h1>Relatório de vendas</h1>
    <div class="sub">Período: ${periodo}</div>

    <div class="stat-row">
      <div class="stat"><div class="label">Total vendido</div><div class="value">${formatarBRL(resumo.total_centavos)}</div></div>
      <div class="stat"><div class="label">Itens vendidos</div><div class="value">${formatarQtd(resumo.itens_milesimal)}</div></div>
      <div class="stat"><div class="label">Vendas realizadas</div><div class="value">${resumo.qtd_vendas}</div></div>
      <div class="stat"><div class="label">Lucro estimado</div><div class="value">${formatarBRL(resumo.lucro_centavos)}</div></div>
    </div>

    <h2>Produtos vendidos</h2>
    <table>
      <thead><tr><th>Produto</th><th class="num">Qtd.</th><th class="num">Total</th><th class="num">Lucro</th></tr></thead>
      <tbody>
        ${produtos.map((p) => `
          <tr>
            <td>${escapar(p.descricao)}</td>
            <td class="num">${formatarQtd(p.qtd_milesimal)}</td>
            <td class="num">${formatarBRL(p.total_centavos)}</td>
            <td class="num">${p.lucro_centavos != null ? formatarBRL(p.lucro_centavos) : '—'}</td>
          </tr>`).join('') || '<tr><td colspan="4">Nenhuma venda no período.</td></tr>'}
      </tbody>
    </table>

    <h2>Vendas do período</h2>
    <table>
      <thead><tr><th>Nº</th><th>Data</th><th>Hora</th><th>Origem</th><th>Forma</th><th class="num">Total</th><th>Situação</th></tr></thead>
      <tbody>
        ${vendas.map((v) => `
          <tr>
            <td>${String(v.numero).padStart(6, '0')}</td>
            <td>${formatarDataBR(v.data)}</td>
            <td>${escapar(v.hora)}</td>
            <td>${escapar(origemVenda(v))}</td>
            <td>${(v.formas || '').split(',').filter(Boolean).map((f) => NOME_FORMA[f] ?? f).join(', ') || '—'}</td>
            <td class="num">${formatarBRL(v.total_centavos)}</td>
            <td>${v.status === 'cancelada' ? 'Cancelada' : 'Finalizada'}</td>
          </tr>`).join('') || '<tr><td colspan="7">Nenhuma venda no período.</td></tr>'}
      </tbody>
    </table>

    <div class="rodape">Gerado em ${formatarDataBR(hojeISO())} pelo Sistema de Vendas.</div>
  `;

  const nomeArquivo = dataInicio === dataFim
    ? `vendas-${dataInicio}.pdf`
    : `vendas-${dataInicio}_a_${dataFim}.pdf`;

  const caminho = await tentar(
    () => api.sistema.exportarPdf({ titulo: 'Relatório de vendas', html, sugestaoNome: nomeArquivo }),
    { aoFalhar: (e) => toast(e.message, 'err') }
  );
  if (caminho) toast(`PDF salvo em ${caminho}`);
}

function construirHtmlEstoque(lista) {
  return `
    <h1>Relatório de estoque atual</h1>
    <div class="sub">${lista.length} produto(s) cadastrado(s) com controle de estoque.</div>
    <table>
      <thead><tr><th>Código</th><th>Produto</th><th class="num">Estoque</th><th class="num">Estoque mínimo</th></tr></thead>
      <tbody>
        ${lista.map((p) => `
          <tr>
            <td>${escapar(p.codigo ?? '—')}</td>
            <td>${escapar(p.nome)}</td>
            <td class="num">${formatarQtd(p.estoque_milesimal)}</td>
            <td class="num">${formatarQtd(p.estoque_minimo_milesimal)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div class="rodape">Gerado em ${formatarDataBR(hojeISO())} pelo Sistema de Vendas.</div>
  `;
}

async function exportarEstoquePdf() {
  const caminho = await tentar(
    () => api.sistema.exportarPdf({
      titulo: 'Relatório de estoque',
      html: construirHtmlEstoque(ultimoEstoqueCompleto),
      sugestaoNome: `estoque-${hojeISO()}.pdf`
    }),
    { aoFalhar: (e) => toast(e.message, 'err') }
  );
  if (caminho) toast(`PDF salvo em ${caminho}`);
}

function abrirEstoqueCompleto() {
  abrirModal(`
    <h3>Estoque completo</h3>
    <div class="sub">${ultimoEstoqueCompleto.length} produto(s) cadastrado(s) com controle de estoque.</div>
    <div class="tabela-rolagem tabela-rolagem-alta">
      <table>
        <thead><tr><th>Código</th><th>Produto</th><th class="num">Estoque restante</th></tr></thead>
        <tbody>${ultimoEstoqueCompleto.map(linhaEstoque).join('')}</tbody>
      </table>
    </div>
    <div class="btn-row">
      <button class="btn btn-ghost" data-r="0">Fechar</button>
      <button class="btn btn-primary" data-r="pdf">Exportar PDF</button>
    </div>
  `, {
    aoMontar(caixa) {
      caixa.querySelector('[data-r="0"]').addEventListener('click', fecharModal);
      caixa.querySelector('[data-r="pdf"]').addEventListener('click', exportarEstoquePdf);
      caixa.querySelector('[data-r="0"]').focus();
    }
  });
}

// ------------------------------ Ações ------------------------------------

async function verVenda(id) {
  const v = await tentar(() => api.vendas.porId(id));
  if (!v) return;
  const temFiado = v.pagamentos.some(p => p.forma === 'fiado');

  abrirModal(`
    <h3>Venda ${String(v.numero).padStart(6, '0')}</h3>
    <div class="sub">${formatarDataBR(v.data)} às ${escapar(v.hora)}
      ${v.comanda ? ` · Comanda: ${escapar(v.comanda.identificador)}${v.comanda.cliente_nome ? ' · ' + escapar(v.comanda.cliente_nome) : ''}` : ''}
      ${v.status === 'cancelada' ? ' · <span class="txt-perigo">CANCELADA</span>' : ''}</div>
    <div class="receipt sem-moldura">
      ${v.itens.map((i) => `
        <div class="rline">
          <span class="name ${i.total_item_centavos < 0 ? 'txt-perigo' : ''}">${escapar(i.descricao)}</span>
          <span class="leader"></span>
          <span class="mono qty">${formatarQtd(Math.abs(i.qtd_milesimal))}</span>
          <span class="price">${formatarBRL(i.total_item_centavos)}</span>
          ${!temFiado && v.status === 'finalizada' && i.total_item_centavos > 0
            ? `<span class="rm" data-remover-item="${i.id}" data-descricao="${escapar(i.descricao)}" title="Remover item">✕</span>`
            : ''}
        </div>`).join('')}
      <div class="rtotal">
        <span class="label">Total</span>
        <span class="amount total-modal">${formatarBRL(v.total_centavos)}</span>
      </div>
    </div>
    ${v.pagamentos.map((p) => `
      <div class="linha-info">
        <span class="rotulo">${NOME_FORMA[p.forma] ?? escapar(p.forma)}</span>
        <span class="valor">${p.valor_centavos < 0 ? `Devolvido: ${formatarBRL(-p.valor_centavos)}` : formatarBRL(p.valor_centavos)}</span>
      </div>`).join('')}
    ${v.status === 'cancelada' ? `
      <div class="linha-info"><span class="rotulo">Motivo do cancelamento</span>
        <span class="valor">${escapar(v.cancelada_motivo ?? '')}</span></div>` : ''}
    <div class="btn-row">
      <button class="btn btn-ghost" data-r="0">Fechar</button>
      ${!temFiado && v.status === 'finalizada' ? '<button class="btn btn-primary" data-r="add">Adicionar itens</button>' : ''}
    </div>
    ${temFiado ? '<p>Venda fiada: consulte saldo e recebimentos na aba Clientes / Fiado. Alterações de itens estão bloqueadas.</p>' : ''}
  `, {
    aoMontar(caixa) {
      caixa.querySelector('[data-r="0"]').addEventListener('click', fecharModal);
      caixa.querySelector('[data-r="0"]').focus();
      caixa.querySelector('[data-r="add"]')?.addEventListener('click', () => abrirAdicionarItens(v));
      for (const btn of caixa.querySelectorAll('[data-remover-item]')) {
        btn.addEventListener('click', () => removerItemDaVenda(v, Number(btn.dataset.removerItem), btn.dataset.descricao));
      }
    }
  });
}

async function removerItemDaVenda(venda, itemId, descricao) {
  const motivo = await pedirMotivo({
    titulo: `Remover "${descricao}"?`,
    rotuloConfirmar: 'Remover item'
  });
  if (!motivo) return;

  // escolherForma() reaproveita o #modal — ao voltar, reabre a venda em vez
  // de deixar o modal vazio.
  const pagamento = await escolherForma({
    titulo: 'Como o valor foi devolvido?',
    subtitulo: `Removendo "${descricao}" da venda ${String(venda.numero).padStart(6, '0')}.`
  });
  if (!pagamento) { verVenda(venda.id); return; }

  const r = await tentar(
    () => api.vendas.removerItem(venda.id, itemId, { motivo, formaReembolso: pagamento.forma }),
    { aoFalhar: (e) => toast(e.message, 'err') }
  );
  if (r === undefined) return;

  toast(`Item removido — ${formatarBRL(r.reembolsoCentavos)} devolvido(s).`);
  await verVenda(venda.id);
  renderizar();
}

/**
 * Adiciona itens a uma venda já paga — cliente lembrou de mais uma coisa
 * depois de fechar a conta. Os itens ficam só na tela até confirmar com
 * pagamento; nada é gravado até então (sem baixa de estoque de item que a
 * pessoa desistiu de adicionar no meio do caminho).
 */
function abrirAdicionarItens(venda) {
  let itensNovos = [];

  const desenhar = (caixa) => {
    const total = calcularTotais(itensNovos).totalCentavos;
    caixa.querySelector('#ai-itens').innerHTML = itensNovos.length
      ? itensNovos.map((i, idx) => `
          <div class="rline">
            <span class="name">${escapar(i.nome)}</span>
            <span class="leader"></span>
            <span class="mono qty">${formatarQtd(i.qtdMilesimal)}</span>
            <span class="price">${formatarBRL(i.precoUnitCentavos * i.qtdMilesimal / 1000)}</span>
            <span class="rm" data-i="${idx}" title="Remover">✕</span>
          </div>`).join('')
      : '<div class="empty-state">Nenhum item adicionado ainda.</div>';
    caixa.querySelector('#ai-total').textContent = formatarBRL(total);
    caixa.querySelector('[data-r="confirmar"]').disabled = itensNovos.length === 0;
  };

  abrirModal(`
    <h3>Adicionar itens à venda ${String(venda.numero).padStart(6, '0')}</h3>
    <div class="sub">Os itens só entram na venda depois de confirmar o pagamento da diferença.</div>

    <div class="scan-row">
      <input id="ai-termo" type="text" autocomplete="off" placeholder="Digite o nome do produto...">
    </div>
    <div id="ai-lista" class="lista-rolagem"></div>
    <div id="ai-msg" class="msg"></div>

    <div id="ai-itens" class="esp-topo"></div>

    <div class="rtotal">
      <span class="label">Total a adicionar</span>
      <span class="amount" id="ai-total">R$ 0,00</span>
    </div>

    <div class="btn-row">
      <button class="btn btn-ghost" data-r="voltar">Voltar</button>
      <button class="btn btn-primary" data-r="confirmar" disabled>Cobrar e adicionar</button>
    </div>
  `, {
    aoMontar(caixa) {
      const termo = caixa.querySelector('#ai-termo');
      const listaEl = caixa.querySelector('#ai-lista');
      let resultados = [];
      let ativo = 0;

      const desenharBusca = () => {
        if (!termo.value.trim()) { listaEl.innerHTML = ''; return; }
        if (!resultados.length) {
          listaEl.innerHTML = '<div class="empty-state">Nenhum produto encontrado.</div>';
          return;
        }
        listaEl.innerHTML = resultados.map((p, i) => `
          <div class="rline ${i === ativo ? 'selecionada' : ''}" data-i="${i}">
            <span class="name">${escapar(p.nome)}</span>
            <span class="leader"></span>
            <span class="price">${formatarBRL(p.preco_centavos)}</span>
          </div>
        `).join('');
      };

      const buscar = async () => {
        const t = termo.value.trim();
        resultados = t ? (await tentar(() => api.produtos.listar({ termo: t, limite: 20 }))) || [] : [];
        ativo = 0;
        desenharBusca();
      };

      const escolher = (i) => {
        const p = resultados[i];
        if (!p) return;
        const existente = itensNovos.find((it) => it.produtoId === p.id);
        if (existente) existente.qtdMilesimal += 1000;
        else itensNovos.push({ produtoId: p.id, nome: p.nome, precoUnitCentavos: p.preco_centavos, qtdMilesimal: 1000 });
        termo.value = '';
        resultados = [];
        desenharBusca();
        desenhar(caixa);
        termo.focus();
      };

      termo.addEventListener('input', buscar);
      termo.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); ativo = Math.min(resultados.length - 1, ativo + 1); desenharBusca(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); ativo = Math.max(0, ativo - 1); desenharBusca(); }
        if (e.key === 'Enter') { e.preventDefault(); escolher(ativo); }
      });
      listaEl.addEventListener('click', (e) => {
        const linha = e.target.closest('[data-i]');
        if (linha) escolher(Number(linha.dataset.i));
      });

      // Wrapper recriado a cada abertura do modal — nunca delegar em `caixa`
      // direto, que é reaproveitado entre aberturas (ver bug corrigido em
      // telaComandas.js: listener duplicado acumula clique fantasma).
      caixa.querySelector('#ai-itens').addEventListener('click', (e) => {
        const rm = e.target.closest('[data-i]');
        if (!rm) return;
        itensNovos.splice(Number(rm.dataset.i), 1);
        desenhar(caixa);
      });

      caixa.querySelector('[data-r="voltar"]').addEventListener('click', () => verVenda(venda.id));
      caixa.querySelector('[data-r="confirmar"]').addEventListener('click', () => confirmarAdicao(venda, itensNovos));
      caixa._aoEscape = () => verVenda(venda.id);

      desenhar(caixa);
      termo.focus();
    }
  });
}

async function confirmarAdicao(venda, itensNovos) {
  if (!itensNovos.length) return;
  const total = calcularTotais(itensNovos).totalCentavos;

  // escolherPagamento() reaproveita o mesmo #modal — ao voltar sem escolher,
  // reabre esta mesma tela de adicionar itens com o que já tinha sido posto.
  const pagamento = await escolherPagamento(total);
  if (!pagamento) { abrirAdicionarItens(venda); return; }

  const r = await tentar(
    () => api.vendas.adicionarItens(venda.id, {
      itens: itensNovos.map((i) => ({
        produtoId: i.produtoId, precoUnitCentavos: i.precoUnitCentavos, qtdMilesimal: i.qtdMilesimal
      })),
      pagamentos: [{
        forma: pagamento.forma, valorCentavos: pagamento.valorCentavos, recebidoCentavos: pagamento.recebidoCentavos
      }]
    }),
    { aoFalhar: (e) => toast(e.message, 'err') }
  );
  if (r === undefined) return;

  toast(`${itensNovos.length} item(ns) adicionado(s) — ${formatarBRL(total)} a mais.`);
  await verVenda(venda.id);
  renderizar();
}

async function cancelarVenda(id, numero) {
  const ok = await confirmar({
    titulo: `Cancelar a venda ${String(numero).padStart(6, '0')}?`,
    texto: 'O estoque dos itens volta para a prateleira e a venda sai do total do dia. ' +
           'A venda não é apagada: fica registrada como cancelada.',
    confirmar: 'Sim, cancelar',
    perigo: true
  });
  if (!ok) return;

  const motivo = await pedirMotivo({
    titulo: 'Motivo do cancelamento',
    rotuloConfirmar: 'Cancelar a venda'
  });
  if (!motivo) return;

  const r = await tentar(() => api.vendas.cancelar({ vendaId: id, motivo }));
  if (r === undefined) return;

  toast(`Venda ${String(numero).padStart(6, '0')} cancelada. Estoque devolvido.`);
  renderizar();
}

function pedirMotivo({ titulo = 'Motivo', rotuloConfirmar = 'Confirmar' } = {}) {
  return new Promise((resolve) => {
    abrirModal(`
      <h3>${escapar(titulo)}</h3>
      <div class="sub">Fica registrado para consulta depois. É obrigatório.</div>
      <input id="mc-motivo" type="text" placeholder="Ex.: cliente desistiu, item errado">
      <div class="btn-row">
        <button class="btn btn-ghost" data-r="0">Voltar</button>
        <button class="btn btn-perigo" data-r="1">${escapar(rotuloConfirmar)}</button>
      </div>
    `, {
      aoMontar(caixa) {
        const campo = caixa.querySelector('#mc-motivo');
        const confirmarMotivo = () => {
          const v = campo.value.trim();
          if (!v) { toast('Informe o motivo.', 'err'); return; }
          fecharModal();
          resolve(v);
        };
        caixa.querySelector('[data-r="1"]').addEventListener('click', confirmarMotivo);
        caixa.querySelector('[data-r="0"]').addEventListener('click', () => { fecharModal(); resolve(null); });
        campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirmarMotivo(); } });
        campo.focus();
        caixa._aoEscape = () => { fecharModal(); resolve(null); };
      }
    });
  });
}
