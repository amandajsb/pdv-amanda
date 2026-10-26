import { abrirModal, fecharModal, toast } from './dom.js';
import { formatarBRL, paraCentavos } from '/compartilhado/formato/moeda.js';

const FORMAS = [
  { forma: 'dinheiro', rotulo: 'Dinheiro' },
  { forma: 'pix', rotulo: 'PIX' },
  { forma: 'debito', rotulo: 'Débito' },
  { forma: 'credito', rotulo: 'Crédito' }
];

/**
 * Modal de forma de pagamento, reaproveitado pela tela Vender e por Comandas.
 * Resolve com {forma, valorCentavos, recebidoCentavos} ou null se cancelar.
 *
 * Por ora é uma forma só por venda (sem split) — dinheiro pede valor recebido
 * pra calcular troco; as demais fecham no valor exato, sem campo extra.
 */
export function escolherPagamento(totalCentavos, { permitirFiado = false } = {}) {
  const formas = permitirFiado ? [...FORMAS, { forma: 'fiado', rotulo: 'Fiado · conta a receber' }] : FORMAS;
  return new Promise((resolve) => {
    let formaEscolhida = null;
    const responder = (v) => { fecharModal(); resolve(v); };

    abrirModal(`
      <h3>Forma de pagamento</h3>
      <div class="sub">Total a cobrar: ${formatarBRL(totalCentavos)}</div>

      <div class="grid-2">
        ${formas.map((f) => `
          <button class="btn btn-ghost" data-forma="${f.forma}">${f.rotulo}</button>
        `).join('')}
      </div>

      <div id="pg-dinheiro" class="esp-topo oculto">
        <label for="pg-recebido">Valor recebido (R$)</label>
        <input id="pg-recebido" type="text" inputmode="decimal" class="mono"
               value="${(totalCentavos / 100).toFixed(2).replace('.', ',')}">
        <div class="linha-info">
          <span class="rotulo">Troco</span>
          <span class="valor" id="pg-troco">${formatarBRL(0)}</span>
        </div>
      </div>

      <div class="btn-row">
        <button class="btn btn-ghost" data-r="0">Voltar</button>
        <button class="btn btn-primary" data-r="1" disabled>Confirmar</button>
      </div>
    `, {
      aoMontar(caixa) {
        const botoesForma = [...caixa.querySelectorAll('[data-forma]')];
        const blocoDinheiro = caixa.querySelector('#pg-dinheiro');
        const recebido = caixa.querySelector('#pg-recebido');
        const trocoEl = caixa.querySelector('#pg-troco');
        const btnConfirmar = caixa.querySelector('[data-r="1"]');

        const atualizarTroco = () => {
          const recebidoCentavos = paraCentavos(recebido.value) ?? 0;
          trocoEl.textContent = formatarBRL(Math.max(0, recebidoCentavos - totalCentavos));
        };

        const selecionarForma = (forma) => {
          formaEscolhida = forma;
          for (const b of botoesForma) {
            b.classList.toggle('btn-primary', b.dataset.forma === forma);
            b.classList.toggle('btn-ghost', b.dataset.forma !== forma);
          }
          blocoDinheiro.classList.toggle('oculto', forma !== 'dinheiro');
          btnConfirmar.disabled = false;
          if (forma === 'dinheiro') { recebido.focus(); recebido.select(); }
        };

        const confirmarPagamento = () => {
          if (!formaEscolhida) return;
          if (formaEscolhida === 'dinheiro') {
            const recebidoCentavos = paraCentavos(recebido.value);
            if (recebidoCentavos === null || recebidoCentavos < totalCentavos) {
              toast('O valor recebido não pode ser menor que o total.', 'err');
              return;
            }
            responder({ forma: 'dinheiro', valorCentavos: totalCentavos, recebidoCentavos });
          } else {
            responder({ forma: formaEscolhida, valorCentavos: totalCentavos, recebidoCentavos: null });
          }
        };

        for (const b of botoesForma) {
          b.addEventListener('click', () => selecionarForma(b.dataset.forma));
        }
        recebido.addEventListener('input', atualizarTroco);
        recebido.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirmarPagamento(); } });
        btnConfirmar.addEventListener('click', confirmarPagamento);
        caixa.querySelector('[data-r="0"]').addEventListener('click', () => responder(null));
        caixa._aoEscape = () => responder(null);
      }
    });
  });
}

/**
 * Versão sem "valor recebido"/troco — pra casos onde não se está cobrando,
 * só registrando por qual canal o dinheiro voltou (ex.: devolver um item de
 * uma venda já fechada). Resolve com {forma} ou null se cancelar.
 */
export function escolherForma({ titulo = 'Forma de pagamento', subtitulo = '' } = {}) {
  return new Promise((resolve) => {
    let formaEscolhida = null;
    const responder = (v) => { fecharModal(); resolve(v); };

    abrirModal(`
      <h3>${titulo}</h3>
      ${subtitulo ? `<div class="sub">${subtitulo}</div>` : ''}

      <div class="grid-2">
        ${FORMAS.map((f) => `
          <button class="btn btn-ghost" data-forma="${f.forma}">${f.rotulo}</button>
        `).join('')}
      </div>

      <div class="btn-row">
        <button class="btn btn-ghost" data-r="0">Voltar</button>
        <button class="btn btn-primary" data-r="1" disabled>Confirmar</button>
      </div>
    `, {
      aoMontar(caixa) {
        const botoesForma = [...caixa.querySelectorAll('[data-forma]')];
        const btnConfirmar = caixa.querySelector('[data-r="1"]');

        for (const b of botoesForma) {
          b.addEventListener('click', () => {
            formaEscolhida = b.dataset.forma;
            for (const outro of botoesForma) {
              outro.classList.toggle('btn-primary', outro === b);
              outro.classList.toggle('btn-ghost', outro !== b);
            }
            btnConfirmar.disabled = false;
          });
        }
        btnConfirmar.addEventListener('click', () => { if (formaEscolhida) responder({ forma: formaEscolhida }); });
        caixa.querySelector('[data-r="0"]').addEventListener('click', () => responder(null));
        caixa._aoEscape = () => responder(null);
      }
    });
  });
}
