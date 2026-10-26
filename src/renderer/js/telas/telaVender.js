import { api, tentar, ErroApi } from '../api.js';
import { $, escapar, aoClicar, mostrarMsg, toast, abrirModal, fecharModal, modalAberto, confirmar } from '../lib/dom.js';
import { escolherPagamento } from '../lib/pagamento.js';
import { escolherClienteFiado } from '../lib/fiado.js';
import { instalarBuscaProdutos } from '../lib/buscaProdutos.js';
import { formatarBRL, formatarQtd, paraMilesimal, paraCentavos } from '/compartilhado/formato/moeda.js';
import { calcularTotais } from '/compartilhado/calculos/totais.js';
import { formatarDataBR, hojeISO, agoraHora } from '/compartilhado/formato/data.js';

// Carrinho: único estado de tela que sobrevive entre renders. É efêmero por
// natureza, mas tem snapshot no banco para não sumir numa queda de energia.
let carrinho = [];
let selecionado = 0;
let aoFinalizarCallback = null;
let finalizando = false;
let vendaPendente = null;
let buscaProdutos = null;

// Ajuste sobre o TOTAL da venda (não item a item): positivo é desconto,
// negativo é acréscimo. Não toca no preço de nenhum produto — é uma linha à
// parte entre o subtotal e o total, igual desconto de cupom em qualquer
// mercado.
let ajusteVendaCentavos = 0;

/** Converte o ajuste único (com sinal) para o formato que calcularTotais e a
 * API do backend esperam: descontoVenda OU acrescimoCentavos, nunca os dois. */
function paramsAjusteVenda() {
  if (ajusteVendaCentavos > 0) return { descontoVenda: { tipo: 'valor', valorCentavos: ajusteVendaCentavos }, acrescimoCentavos: 0 };
  if (ajusteVendaCentavos < 0) return { descontoVenda: undefined, acrescimoCentavos: -ajusteVendaCentavos };
  return { descontoVenda: undefined, acrescimoCentavos: 0 };
}

const scanInput = () => $('#scan-input');

/** Passo do +/-: 1 unidade inteira pra UN, 0,1 (100g/100mL) pra quem vende por peso/volume. */
function passoQtd(item) {
  return !item || item.unidade === 'UN' ? 1000 : 100;
}

export function montar({ aoFinalizar } = {}) {
  aoFinalizarCallback = aoFinalizar;
  const secao = $('#tab-vender');

  buscaProdutos = instalarBuscaProdutos({
    campo: scanInput(), lista: $('#scan-sugestoes'), aoEscolher: adicionarAoCarrinho,
    aoCodigo: bipar, bloqueado: () => Boolean(vendaPendente || finalizando || modalAberto())
  });

  aoClicar(secao, '[data-acao]', (el) => {
    const acao = el.dataset.acao;
    if (vendaPendente && acao !== 'finalizar') { toast('Confirme novamente a venda pendente antes de alterar o carrinho.', 'err'); return; }
    if (acao === 'adicionar') {
      buscaProdutos.confirmar();
      focarScan();
    }
    if (acao === 'cancelar-venda') cancelarVenda();
    if (acao === 'finalizar') finalizar();
    if (acao === 'mais') { const i = Number(el.dataset.i); alterarQtd(i, passoQtd(carrinho[i])); }
    if (acao === 'menos') { const i = Number(el.dataset.i); alterarQtd(i, -passoQtd(carrinho[i])); }
    if (acao === 'remover') removerItem(Number(el.dataset.i));
    if (acao === 'editar-preco') { selecionado = Number(el.dataset.i); pedirPreco(); }
    if (acao === 'editar-total-venda') pedirTotalVenda();
  });

  instalarAtalhos();
  instalarArmadilhaDeFoco();
  renderizar();
}

export function aoEntrar() {
  focarScan();
  renderizar();
}

export function focarScan() {
  const el = scanInput();
  if (el && !modalAberto()) el.focus();
}

/**
 * Armadilha de foco: se o operador clicou em qualquer lugar da tela e depois
 * bipou, o código se perderia. Aqui a primeira tecla imprimível devolve o foco
 * ao campo de bipagem sem engolir o caractere — é a falha operacional mais
 * comum num PDV.
 */
function instalarArmadilhaDeFoco() {
  document.addEventListener('keydown', (e) => {
    if (modalAberto()) return;
    if (!$('#tab-vender').classList.contains('active')) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key.length !== 1) return;

    const alvo = e.target;
    const ehCampo = alvo.matches('input, textarea, select');
    if (!ehCampo) focarScan();
  }, true);
}

function instalarAtalhos() {
  document.addEventListener('keydown', (e) => {
    if (!$('#tab-vender').classList.contains('active')) return;
    if (modalAberto()) return;

    if (vendaPendente && e.key !== 'F8') return;
    switch (e.key) {
      case 'F2': e.preventDefault(); abrirBuscaPorNome(); break;
      case 'F3': e.preventDefault(); pedirQuantidade(); break;
      case 'F4': e.preventDefault(); pedirPreco(); break;
      case 'F5': e.preventDefault(); pedirTotalVenda(); break;
      case 'F7': e.preventDefault(); removerItem(selecionado); break;
      case 'F8': e.preventDefault(); finalizar(); break;
      case 'F12': e.preventDefault(); cancelarVenda(); break;
      case 'ArrowUp':
        if (carrinho.length) { e.preventDefault(); selecionado = Math.max(0, selecionado - 1); renderizar(); }
        break;
      case 'ArrowDown':
        if (carrinho.length) { e.preventDefault(); selecionado = Math.min(carrinho.length - 1, selecionado + 1); renderizar(); }
        break;
      case '+': case '=':
        if (carrinho.length && scanInput().value === '') { e.preventDefault(); alterarQtd(selecionado, passoQtd(carrinho[selecionado])); }
        break;
      case '-':
        if (carrinho.length && scanInput().value === '') { e.preventDefault(); alterarQtd(selecionado, -passoQtd(carrinho[selecionado])); }
        break;
      case 'Escape':
        if (scanInput().value) { scanInput().value = ''; }
        break;
    }
  });
}

// ------------------------------- Bipagem --------------------------------

/**
 * Aceita "7891000100103" e também "3*7891000100103" — o multiplicador de
 * quantidade é memória muscular de quem opera caixa.
 */
async function bipar(entrada, aindaAtual = () => true) {
  if (vendaPendente || finalizando) { toast('Conclua a confirmação da venda pendente.', 'err'); return; }
  let quantidade = 1000;
  let codigo = entrada;
  let pesoExplicito = false;

  const mult = entrada.match(/^(\d+(?:[.,]\d+)?)\s*[*x]\s*(.+)$/i);
  if (mult) {
    quantidade = paraMilesimal(mult[1]) ?? 1000;
    codigo = mult[2].trim();
    pesoExplicito = true;
  }

  const achado = await tentar(() => api.produtos.buscarPorCodigo(codigo));
  if (achado === undefined) return;

  if (!achado) {
    const sugestoes = await tentar(() => api.produtos.listar({ termo: codigo, limite: 20 }));
    if (!aindaAtual()) return;
    if (sugestoes?.length) { buscaProdutos.exibir(entrada, sugestoes); return; }
    mostrarMsg('#scan-msg', `Produto com código "${codigo}" não está cadastrado.`, 'err');
    oferecerCadastroRapido(codigo);
    return;
  }

  const { produto, codigo: codigoEncontrado, fatorMilesimal } = achado;
  adicionarAoCarrinho(produto, codigoEncontrado, (quantidade * fatorMilesimal) / 1000, pesoExplicito);
}

/**
 * pesoExplicito=true quando a quantidade já veio digitada (ex.: "0,350*código"
 * ou editada na busca por nome) — nesse caso não reabre o pedido de peso.
 * Produto vendido por peso/volume (unidade != UN) sem peso explícito sempre
 * para e pergunta, em vez de assumir "1" (1kg por engano é prejuízo real).
 */
function adicionarAoCarrinho(produto, codigoBarras, qtdMilesimal, pesoExplicito = false) {
  const existente = carrinho.find((i) => i.produtoId === produto.id);
  const jaNoCarrinho = existente?.qtdMilesimal ?? 0;

  if (produto.controla_estoque && produto.estoque_milesimal < jaNoCarrinho + qtdMilesimal) {
    mostrarMsg(
      '#scan-msg',
      `"${produto.nome}" não tem estoque suficiente (restam ${formatarQtd(produto.estoque_milesimal)}).`,
      'warn'
    );
    return;
  }

  let itemNovo = false;
  if (existente) {
    existente.qtdMilesimal += qtdMilesimal;
    selecionado = carrinho.indexOf(existente);
  } else {
    carrinho.push({
      produtoId: produto.id,
      nome: produto.nome,
      unidade: produto.unidade,
      codigoBarras,
      precoUnitCentavos: produto.preco_centavos,
      qtdMilesimal,
      descontoItemCentavos: 0,
      estoqueMilesimal: produto.estoque_milesimal,
      controlaEstoque: !!produto.controla_estoque
    });
    selecionado = carrinho.length - 1;
    itemNovo = true;
  }

  mostrarMsg('#scan-msg', `${produto.nome} — ${formatarBRL(produto.preco_centavos)}`, 'ok', 3);
  renderizar();

  if (itemNovo && !pesoExplicito && produto.unidade !== 'UN') {
    pedirQuantidade(); // produto vendido por peso: confirma o valor pesado em vez de assumir "1".
  } else {
    focarScan();
  }
}

function oferecerCadastroRapido(codigo) {
  abrirModal(`
    <h3>Cadastrar este produto?</h3>
    <div class="sub">O código <span class="mono">${escapar(codigo)}</span> não existe no cadastro.</div>
    <div class="grid-campos">
      <div><label for="qr-nome">Nome</label><input id="qr-nome" type="text" autocomplete="off"></div>
      <div class="grid-2">
        <div><label for="qr-preco">Preço (R$)</label><input id="qr-preco" type="text" inputmode="decimal" placeholder="0,00"></div>
        <div><label for="qr-estoque">Estoque</label><input id="qr-estoque" type="text" inputmode="decimal" placeholder="0"></div>
      </div>
    </div>
    <div id="qr-msg" class="msg"></div>
    <div class="btn-row">
      <button class="btn btn-ghost" data-r="cancelar">Agora não</button>
      <button class="btn btn-primary" data-r="salvar">Cadastrar e adicionar</button>
    </div>
  `, {
    aoMontar(caixa) {
      caixa.querySelector('#qr-nome').focus();
      caixa.querySelector('[data-r="cancelar"]').addEventListener('click', () => { fecharModal(); focarScan(); });
      caixa.querySelector('[data-r="salvar"]').addEventListener('click', () => salvarCadastroRapido(codigo, caixa));
      caixa.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); salvarCadastroRapido(codigo, caixa); }
      });
      caixa._aoEscape = () => { fecharModal(); focarScan(); };
    }
  });
}

async function salvarCadastroRapido(codigo, caixa) {
  const nome = caixa.querySelector('#qr-nome').value.trim();
  const precoCentavos = paraCentavos(caixa.querySelector('#qr-preco').value);
  const estoqueMilesimal = paraMilesimal(caixa.querySelector('#qr-estoque').value) ?? 0;

  if (!nome || precoCentavos === null) {
    mostrarMsg(caixa.querySelector('#qr-msg'), 'Informe pelo menos o nome e o preço.', 'err');
    return;
  }

  const id = await tentar(
    () => api.produtos.criar({ nome, precoCentavos, codigos: [codigo] }),
    { aoFalhar: (e) => mostrarMsg(caixa.querySelector('#qr-msg'), e.message, 'err') }
  );
  if (id === undefined) return;

  if (estoqueMilesimal > 0) {
    await tentar(() => api.estoque.entrada({
      produtoId: id, qtdMilesimal: estoqueMilesimal, motivo: 'Cadastro rápido no caixa'
    }));
  }

  fecharModal();
  const produto = await tentar(() => api.produtos.porId(id));
  if (produto) adicionarAoCarrinho(produto, codigo, 1000);
}

async function abrirBuscaPorNome() {
  abrirModal(`
    <h3>Buscar produto</h3>
    <div class="sub">Digite parte do nome. Use ↑ ↓ e Enter para adicionar.</div>
    <input id="bp-termo" type="text" autocomplete="off" placeholder="Ex.: leite">
    <div id="bp-lista" class="lista-rolagem"></div>
  `, {
    aoMontar(caixa) {
      const termo = caixa.querySelector('#bp-termo');
      const lista = caixa.querySelector('#bp-lista');
      let resultados = [];
      let ativo = 0;

      const desenhar = () => {
        if (!resultados.length) {
          lista.innerHTML = '<div class="empty-state">Nenhum produto encontrado.</div>';
          return;
        }
        lista.innerHTML = resultados.map((p, i) => `
          <div class="rline ${i === ativo ? 'selecionada' : ''}" data-i="${i}">
            <span class="name">${escapar(p.nome)}</span>
            <span class="leader"></span>
            <span class="mono txt-mini">${formatarQtd(p.estoque_milesimal)}</span>
            <span class="price">${formatarBRL(p.preco_centavos)}</span>
          </div>
        `).join('');
      };

      const buscar = async () => {
        resultados = (await tentar(() => api.produtos.listar({ termo: termo.value, limite: 30 }))) || [];
        ativo = 0;
        desenhar();
      };

      const escolher = async (i) => {
        const p = resultados[i];
        if (!p) return;
        fecharModal();
        const completo = await tentar(() => api.produtos.porId(p.id));
        if (completo) adicionarAoCarrinho(completo, p.codigo ?? null, 1000);
      };

      termo.addEventListener('input', buscar);
      termo.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); ativo = Math.min(resultados.length - 1, ativo + 1); desenhar(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); ativo = Math.max(0, ativo - 1); desenhar(); }
        if (e.key === 'Enter') { e.preventDefault(); escolher(ativo); }
      });
      lista.addEventListener('click', (e) => {
        const linha = e.target.closest('[data-i]');
        if (linha) escolher(Number(linha.dataset.i));
      });

      termo.focus();
      caixa._aoEscape = () => { fecharModal(); focarScan(); };
      buscar();
    }
  });
}

// ------------------------------ Carrinho --------------------------------

function alterarQtd(indice, delta) {
  const item = carrinho[indice];
  if (!item) return;
  const nova = item.qtdMilesimal + delta;

  if (nova <= 0) { removerItem(indice); return; }
  if (item.controlaEstoque && nova > item.estoqueMilesimal) {
    mostrarMsg('#scan-msg', `Estoque máximo de "${item.nome}" é ${formatarQtd(item.estoqueMilesimal)}.`, 'warn');
    return;
  }
  item.qtdMilesimal = nova;
  selecionado = indice;
  renderizar();
}

const TITULO_QTD_POR_UNIDADE = { UN: 'Quantidade', KG: 'Peso (kg)', G: 'Peso (g)', L: 'Volume (L)' };

function pedirQuantidade() {
  const item = carrinho[selecionado];
  if (!item) return;
  const titulo = TITULO_QTD_POR_UNIDADE[item.unidade] || 'Quantidade';
  abrirModal(`
    <h3>${titulo}</h3>
    <div class="sub">${escapar(item.nome)}${item.unidade !== 'UN' ? ' — digite o valor da balança' : ''}</div>
    <input id="q-valor" type="text" inputmode="decimal" class="mono" value="${formatarQtd(item.qtdMilesimal)}">
    <div class="btn-row">
      <button class="btn btn-ghost" data-r="0">Voltar</button>
      <button class="btn btn-primary" data-r="1">Aplicar</button>
    </div>
  `, {
    aoMontar(caixa) {
      const campo = caixa.querySelector('#q-valor');
      const aplicar = () => {
        const nova = paraMilesimal(campo.value);
        if (nova === null || nova <= 0) { toast('Quantidade inválida.', 'err'); return; }
        if (item.controlaEstoque && nova > item.estoqueMilesimal) {
          toast(`Estoque máximo é ${formatarQtd(item.estoqueMilesimal)}.`, 'err');
          return;
        }
        item.qtdMilesimal = nova;
        fecharModal();
        renderizar();
        focarScan();
      };
      caixa.querySelector('[data-r="1"]').addEventListener('click', aplicar);
      caixa.querySelector('[data-r="0"]').addEventListener('click', () => { fecharModal(); focarScan(); });
      campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); aplicar(); } });
      campo.focus(); campo.select();
      caixa._aoEscape = () => { fecharModal(); focarScan(); };
    }
  });
}

/**
 * Muda o preço só nessa venda — não mexe no cadastro do produto.
 *
 * Os dois campos NÃO são espelho um do outro (isso que causava o erro de
 * 1 centavo: total = unitário×qtd arredondado, e daí recalcular o unitário a
 * partir desse total já arredondado ia e voltava perdendo centavo). Agora:
 *   - Editar "Preço unitário" recalcula o total (bruto = unit×qtd) e ZERA
 *     qualquer desconto/acréscimo anterior — é uma nova base.
 *   - Editar "Total da linha" NÃO mexe no preço unitário: guarda a diferença
 *     pro bruto atual como desconto_item_centavos (negativo = acréscimo),
 *     um inteiro exato, sem dividir nada. O total final bate exatamente com
 *     o que foi digitado.
 */
function pedirPreco() {
  const item = carrinho[selecionado];
  if (!item) return;
  const multiplas = item.qtdMilesimal !== 1000;
  const bruto = Math.round((item.precoUnitCentavos * item.qtdMilesimal) / 1000);
  const totalAtual = bruto - (item.descontoItemCentavos || 0);

  abrirModal(`
    <h3>Preço</h3>
    <div class="sub">${escapar(item.nome)} — vale só para esta venda, o cadastro do produto não muda.</div>
    <div class="${multiplas ? 'grid-2' : ''}">
      <div>
        <label for="pu-unitario">Preço unitário (R$)</label>
        <input id="pu-unitario" type="text" inputmode="decimal" class="mono"
               value="${(item.precoUnitCentavos / 100).toFixed(2).replace('.', ',')}">
      </div>
      ${multiplas ? `
      <div>
        <label for="pu-total">Total da linha (${formatarQtd(item.qtdMilesimal)} un.) (R$)</label>
        <input id="pu-total" type="text" inputmode="decimal" class="mono"
               value="${(totalAtual / 100).toFixed(2).replace('.', ',')}">
      </div>` : ''}
    </div>
    <div id="pu-ajuste-msg" class="txt-suave esp-topo-p"></div>
    <div class="btn-row">
      <button class="btn btn-ghost" data-r="0">Voltar</button>
      <button class="btn btn-primary" data-r="1">Aplicar</button>
    </div>
  `, {
    aoMontar(caixa) {
      const unitario = caixa.querySelector('#pu-unitario');
      const total = caixa.querySelector('#pu-total');
      const ajusteMsg = caixa.querySelector('#pu-ajuste-msg');

      // O que de fato vai ser aplicado, escolhido pelo último campo editado —
      // nunca os dois ao mesmo tempo, pra não reintroduzir o vai-e-volta.
      let modo = 'unitario'; // 'unitario' | 'total'

      const mostrarAjuste = () => {
        if (modo !== 'total') { ajusteMsg.textContent = ''; return; }
        const t = paraCentavos(total.value);
        if (t === null) { ajusteMsg.textContent = ''; return; }
        const ajuste = bruto - t;
        if (ajuste > 0) ajusteMsg.textContent = `Desconto nesta linha: ${formatarBRL(ajuste)}`;
        else if (ajuste < 0) ajusteMsg.textContent = `Acréscimo nesta linha: ${formatarBRL(-ajuste)}`;
        else ajusteMsg.textContent = '';
      };

      unitario.addEventListener('input', () => { modo = 'unitario'; mostrarAjuste(); });
      total?.addEventListener('input', () => { modo = 'total'; mostrarAjuste(); });
      mostrarAjuste();

      const aplicar = () => {
        if (modo === 'total') {
          const t = paraCentavos(total.value);
          if (t === null || t < 0) { toast('Informe um total válido.', 'err'); return; }
          // Preço unitário fica como estava — só a diferença vira desconto/acréscimo.
          item.descontoItemCentavos = bruto - t;
        } else {
          const c = paraCentavos(unitario.value);
          if (c === null || c < 0) { toast('Informe um preço válido.', 'err'); return; }
          item.precoUnitCentavos = c;
          item.descontoItemCentavos = 0;
        }
        fecharModal();
        renderizar();
        focarScan();
      };
      caixa.querySelector('[data-r="1"]').addEventListener('click', aplicar);
      caixa.querySelector('[data-r="0"]').addEventListener('click', () => { fecharModal(); focarScan(); });
      unitario.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); aplicar(); } });
      total?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); aplicar(); } });
      unitario.focus(); unitario.select();
      caixa._aoEscape = () => { fecharModal(); focarScan(); };
    }
  });
}

/**
 * Ajusta o TOTAL da venda direto, sem mexer no preço de nenhum item — os
 * produtos continuam com seus próprios valores, o desconto/acréscimo fica
 * numa linha à parte entre o subtotal e o total (como desconto de cupom).
 * Diferente de pedirPreco(): aqui não tem "preço unitário" pra espelhar, só
 * o total mesmo, então não existe o risco de ida-e-volta com arredondamento.
 */
function pedirTotalVenda() {
  if (!carrinho.length) return;
  const subtotal = calcularTotais(carrinho).totalCentavos; // soma dos itens, sem o ajuste de venda
  const totalAtual = subtotal - ajusteVendaCentavos;

  abrirModal(`
    <h3>Total da venda</h3>
    <div class="sub">Os preços dos produtos continuam os mesmos — isso só aplica um desconto ou acréscimo na venda toda.</div>
    <label for="tv-total">Total desejado (R$)</label>
    <input id="tv-total" type="text" inputmode="decimal" class="mono"
           value="${(totalAtual / 100).toFixed(2).replace('.', ',')}">
    <div id="tv-ajuste-msg" class="txt-suave esp-topo-p"></div>
    <div class="btn-row">
      <button class="btn btn-ghost" data-r="0">Voltar</button>
      ${ajusteVendaCentavos !== 0 ? '<button class="btn btn-ghost" data-r="limpar">Remover ajuste</button>' : ''}
      <button class="btn btn-primary" data-r="1">Aplicar</button>
    </div>
  `, {
    aoMontar(caixa) {
      const campo = caixa.querySelector('#tv-total');
      const ajusteMsg = caixa.querySelector('#tv-ajuste-msg');

      const mostrarAjuste = () => {
        const t = paraCentavos(campo.value);
        if (t === null) { ajusteMsg.textContent = ''; return; }
        const ajuste = subtotal - t;
        if (ajuste > 0) ajusteMsg.textContent = `Desconto na venda: ${formatarBRL(ajuste)}`;
        else if (ajuste < 0) ajusteMsg.textContent = `Acréscimo na venda: ${formatarBRL(-ajuste)}`;
        else ajusteMsg.textContent = '';
      };
      campo.addEventListener('input', mostrarAjuste);
      mostrarAjuste();

      const aplicar = () => {
        const t = paraCentavos(campo.value);
        if (t === null || t < 0) { toast('Informe um total válido.', 'err'); return; }
        ajusteVendaCentavos = subtotal - t;
        fecharModal();
        renderizar();
        focarScan();
      };
      caixa.querySelector('[data-r="1"]').addEventListener('click', aplicar);
      caixa.querySelector('[data-r="0"]').addEventListener('click', () => { fecharModal(); focarScan(); });
      caixa.querySelector('[data-r="limpar"]')?.addEventListener('click', () => {
        ajusteVendaCentavos = 0;
        fecharModal();
        renderizar();
        focarScan();
      });
      campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); aplicar(); } });
      campo.focus(); campo.select();
      caixa._aoEscape = () => { fecharModal(); focarScan(); };
    }
  });
}

function removerItem(indice) {
  if (!carrinho[indice]) return;
  carrinho.splice(indice, 1);
  selecionado = Math.max(0, Math.min(selecionado, carrinho.length - 1));
  renderizar();
  focarScan();
}

async function cancelarVenda() {
  if (!carrinho.length) return;
  const ok = await confirmar({
    titulo: 'Cancelar a venda?',
    texto: 'Todos os itens bipados serão descartados. A venda não foi registrada, então nada é perdido no estoque.',
    confirmar: 'Cancelar venda',
    perigo: true
  });
  if (!ok) { focarScan(); return; }
  limpar();
  toast('Venda cancelada.');
}

function limpar() {
  clearTimeout(timerRascunho);
  vendaPendente = null;
  carrinho = [];
  selecionado = 0;
  ajusteVendaCentavos = 0;
  renderizar();
  api.vendas.rascunhoLimpar().catch(() => {});
  focarScan();
}

// ------------------------------ Finalizar -------------------------------

async function finalizar() {
  if (!carrinho.length || finalizando) return;
  buscaProdutos.fechar();
  finalizando = true;
  try {
    await concluirFinalizacao();
  } finally { finalizando = false; }
}

async function concluirFinalizacao() {
  if (vendaPendente) {
    const r = await enviarVendaPendente();
    if (r !== undefined) { vendaPendente = null; limpar(); toast(`Venda ${r.numero} registrada.`); aoFinalizarCallback?.(r); }
    return;
  }

  const { descontoVenda, acrescimoCentavos } = paramsAjusteVenda();
  const totais = calcularTotais(carrinho, descontoVenda, acrescimoCentavos);
  const pagamento = await escolherPagamento(totais.totalCentavos, { permitirFiado: true });
  if (!pagamento) { focarScan(); return; }
  const fiado = pagamento.forma === 'fiado' ? await escolherClienteFiado(totais.totalCentavos) : {};
  if (!fiado) return;

  vendaPendente = {
    operacaoId: crypto.randomUUID(),
    ...fiado,
    itens: carrinho.map((i) => ({
      produtoId: i.produtoId,
      codigoBarras: i.codigoBarras,
      precoUnitCentavos: i.precoUnitCentavos,
      qtdMilesimal: i.qtdMilesimal,
      descontoItemCentavos: i.descontoItemCentavos || 0
    })),
    descontoVenda,
    acrescimoCentavos,
    // Por ora uma forma só por venda, sem split — cobre o pedido de escolher
    // entre dinheiro/pix/débito/crédito sem entrar em pagamento misto ainda.
    pagamentos: [{
      forma: pagamento.forma,
      valorCentavos: pagamento.valorCentavos,
      recebidoCentavos: pagamento.recebidoCentavos
    }],
    totalEsperadoCentavos: totais.totalCentavos
  };
  clearTimeout(timerRascunho);
  const salvo = await tentar(() => api.vendas.rascunhoSalvar(JSON.stringify({ carrinho, ajusteVendaCentavos, vendaPendente, em: new Date().toISOString() })));
  if (salvo === undefined) { vendaPendente = null; return; }
  const r = await enviarVendaPendente();

  if (r === undefined) return;

  vendaPendente = null;
  limpar();
  const troco = r.trocoCentavos ? ` (troco ${formatarBRL(r.trocoCentavos)})` : '';
  toast(`Venda ${String(r.numero).padStart(6, '0')} registrada — ${formatarBRL(r.totais.totalCentavos)}${troco}`);
  aoFinalizarCallback?.(r);
}

async function enviarVendaPendente() {
  return tentar(() => api.vendas.finalizar(vendaPendente), { aoFalhar(e) {
    if (e.codigo && e.codigo !== 'ERRO_INTERNO') { vendaPendente = null; salvarRascunho(); }
    toast(e.message || 'Não houve confirmação. Use Finalizar novamente para consultar a mesma operação.', 'err');
  } });
}

// ------------------------------ Renderização ----------------------------

function renderizar() {
  const corpo = $('#receipt-body');
  $('#receipt-data').textContent = `${formatarDataBR(hojeISO())} · ${agoraHora()}`;

  if (!carrinho.length) {
    corpo.innerHTML = '<div class="receipt-empty">Nenhum item bipado ainda</div>';
  } else {
    const totais = calcularTotais(carrinho);
    corpo.innerHTML = carrinho.map((i, idx) => {
      const ajuste = totais.itens[idx].descontoItemCentavos;
      const notaAjuste = ajuste > 0
        ? `<div class="rline-nota">↳ Desconto nesta linha: ${formatarBRL(ajuste)}</div>`
        : ajuste < 0
          ? `<div class="rline-nota">↳ Acréscimo nesta linha: ${formatarBRL(-ajuste)}</div>`
          : '';
      return `
      <div class="rline ${idx === selecionado ? 'selecionada' : ''}">
        <span class="name" title="${escapar(i.nome)}">${escapar(i.nome)}</span>
        <span class="leader"></span>
        <span class="qty-ctrl">
          <button data-acao="menos" data-i="${idx}" title="Diminuir">−</button>
          <span class="mono qty">${formatarQtd(i.qtdMilesimal)}${i.unidade !== 'UN' ? ` ${i.unidade.toLowerCase()}` : ''}</span>
          <button data-acao="mais" data-i="${idx}" title="Aumentar">+</button>
        </span>
        <span class="price clicavel" data-acao="editar-preco" data-i="${idx}" title="Clique para mudar o preço unitário (F4)">${formatarBRL(totais.itens[idx].totalItemCentavos)}</span>
        <span class="rm" data-acao="remover" data-i="${idx}" title="Remover">✕</span>
      </div>
      ${notaAjuste}
    `;
    }).join('');
  }

  const { descontoVenda, acrescimoCentavos } = paramsAjusteVenda();
  const totalFinal = calcularTotais(carrinho, descontoVenda, acrescimoCentavos).totalCentavos;

  const ajusteEl = $('#receipt-ajuste');
  if (ajusteVendaCentavos > 0) {
    ajusteEl.textContent = `Desconto na venda: ${formatarBRL(ajusteVendaCentavos)}`;
    ajusteEl.classList.remove('oculto');
  } else if (ajusteVendaCentavos < 0) {
    ajusteEl.textContent = `Acréscimo na venda: ${formatarBRL(-ajusteVendaCentavos)}`;
    ajusteEl.classList.remove('oculto');
  } else {
    ajusteEl.classList.add('oculto');
  }

  $('#cart-total').textContent = formatarBRL(totalFinal);
  $('#btn-finalizar').disabled = carrinho.length === 0;
  $('#btn-cancelar').disabled = carrinho.length === 0;

  salvarRascunho();
}

// -------------------------- Rascunho de recuperação ---------------------

let timerRascunho = null;
function salvarRascunho() {
  clearTimeout(timerRascunho);
  timerRascunho = setTimeout(() => {
    if (!carrinho.length) return;
    api.vendas.rascunhoSalvar(JSON.stringify({ carrinho, ajusteVendaCentavos, vendaPendente, em: new Date().toISOString() })).catch(() => {});
  }, 300);
}

/** Chamado no boot: oferece recuperar um carrinho que ficou pela metade. */
export async function recuperarRascunho() {
  const r = await tentar(() => api.vendas.rascunhoLer(), { aoFalhar: () => {} });
  if (!r?.json) return;

  let dados;
  try { dados = JSON.parse(r.json); } catch { return; }
  if (!dados?.carrinho?.length) return;

  const ajusteSalvo = dados.ajusteVendaCentavos || 0;
  const descontoSalvo = ajusteSalvo > 0 ? { tipo: 'valor', valorCentavos: ajusteSalvo } : undefined;
  const acrescimoSalvo = ajusteSalvo < 0 ? -ajusteSalvo : 0;
  const total = calcularTotais(dados.carrinho, descontoSalvo, acrescimoSalvo).totalCentavos;
  const ok = await confirmar({
    titulo: 'Havia uma venda em andamento',
    texto: `Encontramos ${dados.carrinho.length} item(ns), total ${formatarBRL(total)}, ` +
           `de ${new Date(dados.em).toLocaleString('pt-BR')}. Deseja continuar essa venda?`,
    confirmar: 'Continuar a venda'
  });

  if (ok) {
    carrinho = dados.carrinho;
    selecionado = 0;
    ajusteVendaCentavos = dados.ajusteVendaCentavos || 0;
    vendaPendente = dados.vendaPendente || null;
    renderizar();
  } else {
    await tentar(() => api.vendas.rascunhoLimpar(), { aoFalhar: () => {} });
  }
  focarScan();
}
