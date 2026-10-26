export const $ = (sel, raiz = document) => raiz.querySelector(sel);
export const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

/**
 * Escapa texto antes de interpolar em HTML.
 *
 * O protótipo já tinha isto, mas ainda montava `onclick="fn('${dado}')"` —
 * um nome de produto com apóstrofo quebrava o handler. Aqui os handlers são
 * sempre por delegação com data-* , então o dado nunca vira código.
 */
export function escapar(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** Delegação de eventos: um listener por container, não um por linha. */
export function aoClicar(container, seletor, fn) {
  container.addEventListener('click', (e) => {
    const alvo = e.target.closest(seletor);
    if (alvo && container.contains(alvo)) fn(alvo, e);
  });
}

export function mostrarMsg(elOuId, texto, tipo = 'ok', segundos = 6) {
  const el = typeof elOuId === 'string' ? $(elOuId) : elOuId;
  if (!el) return;
  el.textContent = texto;
  el.className = `msg show ${tipo}`;
  clearTimeout(el._t);
  if (segundos) el._t = setTimeout(() => el.classList.remove('show'), segundos * 1000);
}

export function esconderMsg(elOuId) {
  const el = typeof elOuId === 'string' ? $(elOuId) : elOuId;
  if (el) el.classList.remove('show');
}

let timerToast = null;
export function toast(msg, tipo = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${tipo}`;
  clearTimeout(timerToast);
  timerToast = setTimeout(() => t.classList.remove('show'), 2600);
}

// --------------------------------- Modal ---------------------------------

export function abrirModal(html, { aoMontar } = {}) {
  const fundo = $('#modal-fundo');
  const caixa = $('#modal');
  caixa._aoEscape = null;
  caixa.innerHTML = html;
  fundo.classList.add('show');
  aoMontar?.(caixa);
  return caixa;
}

export function fecharModal() {
  $('#modal-fundo').classList.remove('show');
  $('#modal').innerHTML = '';
}

export function modalAberto() {
  return $('#modal-fundo').classList.contains('show');
}

/** Confirmação com foco no botão, resolvida por Promise. */
export function confirmar({ titulo, texto, confirmar: rotulo = 'Confirmar', perigo = false }) {
  return new Promise((resolve) => {
    const caixa = abrirModal(`
      <h3>${escapar(titulo)}</h3>
      <div class="sub">${escapar(texto)}</div>
      <div class="btn-row">
        <button class="btn btn-ghost" data-r="0">Voltar</button>
        <button class="btn ${perigo ? 'btn-perigo' : 'btn-primary'}" data-r="1">${escapar(rotulo)}</button>
      </div>
    `);
    const responder = (v) => { fecharModal(); resolve(v); };
    caixa.querySelector('[data-r="1"]').addEventListener('click', () => responder(true));
    caixa.querySelector('[data-r="0"]').addEventListener('click', () => responder(false));
    caixa.querySelector('[data-r="1"]').focus();
    caixa._aoEscape = () => responder(false);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalAberto()) {
    const caixa = $('#modal');
    if (caixa._aoEscape) { const fn = caixa._aoEscape; caixa._aoEscape = null; fn(); }
    else fecharModal();
  }
});

$('#modal-fundo')?.addEventListener('click', (e) => {
  if (e.target.id === 'modal-fundo') {
    const fn = $('#modal')._aoEscape;
    if (fn) fn();
    else fecharModal();
  }
});
