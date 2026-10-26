import { api, tentar } from '../api.js';
import { $, escapar, abrirModal, fecharModal, toast, confirmar } from '../lib/dom.js';
import { formatarBRL, paraCentavos, formatarQtd } from '/compartilhado/formato/moeda.js';
import { hojeISO, formatarDataBR } from '/compartilhado/formato/data.js';

let clienteId = null;
let versaoLista = 0;
let recuperando = false;
const CHAVE_RECEBIMENTO = 'fiado-recebimento-pendente-v1';
const data = v => v ? formatarDataBR(v) : 'Sem vencimento';
const rotulo = { aberta: 'Em aberto', parcial: 'Pagamento parcial', paga: 'Quitada', cancelada: 'Cancelada' };

export function montar() {
  $('#fi-busca').addEventListener('input', atualizar);
  $('#fi-filtro').addEventListener('change', atualizar);
  $('#fi-novo').addEventListener('click', () => editarCliente());
  $('#fi-clientes').addEventListener('click', e => {
    const b = e.target.closest('[data-cliente]');
    if (b) { clienteId = Number(b.dataset.cliente); detalhe(); }
  });
}

export async function aoEntrar() {
  if (recuperando) return;
  recuperando = true;
  try { await recuperarRecebimento(); }
  finally { recuperando = false; atualizar(); detalhe(); caixa(); }
}

async function recuperarRecebimento() {
  const texto = localStorage.getItem(CHAVE_RECEBIMENTO);
  if (!texto) return true;
  let entrada;
  try { entrada = JSON.parse(texto); }
  catch { toast('Há um recebimento pendente ilegível. Solicite conferência.', 'err'); return false; }
  const r = await tentar(() => enviarRecebimento(entrada), { aoFalhar(e) {
    if (e.codigo && e.codigo !== 'ERRO_INTERNO') localStorage.removeItem(CHAVE_RECEBIMENTO);
    toast(e.message || 'Recebimento pendente de confirmação. Tente novamente.', 'err');
  } });
  if (r !== undefined) { localStorage.removeItem(CHAVE_RECEBIMENTO); toast('Recebimento pendente confirmado.'); return true; }
  return false;
}

function enviarRecebimento(entrada) {
  return entrada.clienteId != null ? api.fiado.receberCliente(entrada) : api.fiado.receber(entrada);
}

async function atualizar() {
  const versao = ++versaoLista;
  const filtro = $('#fi-filtro').value;
  let clientes = await tentar(() => api.clientes.listar({ termo: $('#fi-busca').value, apenasAtivos: filtro === 'ativos' }));
  if (!clientes || versao !== versaoLista) return;
  if (filtro === 'devedores') clientes = clientes.filter(c => c.saldo_centavos > 0);
  // Atraso é calculado no SQLite; o cadastro nunca precisa de uma data obrigatória.
  if (filtro === 'vencidos') clientes = clientes.filter(c => c.vencido_centavos > 0);
  $('#fi-clientes').innerHTML = clientes.length ? `<table><thead><tr><th>Cliente</th><th>Telefone</th><th>Situação</th><th>Saldo devedor</th><th></th></tr></thead><tbody>${clientes.map(c => `<tr>
    <td>${escapar(c.nome)}</td><td>${escapar(c.telefone || '—')}</td><td>${c.ativo ? 'Ativo' : 'Inativo'}</td>
    <td>${formatarBRL(c.saldo_centavos)}</td><td><button class="btn btn-ghost" data-cliente="${c.id}">Ver histórico</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty-state">Nenhum cliente encontrado.</div>';
}

async function detalhe() {
  if (!clienteId) return;
  const id = clienteId;
  const r = await tentar(() => api.fiado.extrato(id));
  if (!r || clienteId !== id) return;
  const { cliente: c, contas, recebimentos, compras } = r;
  $('#fi-detalhe').innerHTML = `<h2>${escapar(c.nome)} · ${formatarBRL(r.saldoCentavos)} em aberto</h2>
    <p>${escapar(c.telefone || '')} ${escapar(c.endereco || '')}</p><p>${escapar(c.observacoes || '')}</p>
    <div class="btn-row">${r.saldoCentavos > 0 ? '<button id="fi-receber-total" class="btn btn-primary">Receber do saldo total</button>' : ''}<button id="fi-editar" class="btn btn-ghost">Editar cadastro</button><button id="fi-ativo" class="btn btn-ghost">${c.ativo ? 'Inativar' : 'Reativar'} cliente</button></div>
    <h3>Contas a receber</h3>${contas.length ? `<table><thead><tr><th>Venda</th><th>Vencimento</th><th>Valor</th><th>Recebido</th><th>Saldo</th><th>Situação</th><th></th></tr></thead><tbody>${contas.map(x => `<tr>
      <td>${x.venda_numero ? '#' + x.venda_numero : escapar(x.descricao || 'Conta')}</td><td>${data(x.vencimento)}</td>
      <td>${formatarBRL(x.valor_centavos)}</td><td>${formatarBRL(x.valor_pago_centavos)}</td><td>${formatarBRL(x.saldo_centavos)}</td>
      <td>${rotulo[x.status]}${x.saldo_centavos > 0 && x.vencimento && x.vencimento < hojeISO() ? ' · Vencida' : ''}${x.status === 'cancelada' ? `<br>${escapar(x.cancelada_motivo || '')}` : ''}</td>
      <td>${x.saldo_centavos > 0 ? `<button class="btn btn-primary" data-receber="${x.id}">Receber</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p>Nenhuma conta.</p>'}
    <h3>Pagamentos recebidos</h3>${recebimentos.length ? `<table id="fi-historico-pagamentos"><thead><tr><th>Data</th><th>Distribuição por compra</th><th>Forma</th><th>Valor total</th><th>Operador</th></tr></thead><tbody>${recebimentos.map(p => `<tr><td>${escapar(p.criado_em)}</td><td>${p.distribuicao.map(d=>`Venda ${d.venda_numero ? '#'+d.venda_numero : '—'}: ${formatarBRL(d.valor_centavos)}`).join('<br>')}</td><td>${escapar(p.forma)}</td><td>${formatarBRL(p.valor_centavos)}</td><td>${escapar(p.criado_por)}</td></tr>`).join('')}</tbody></table>` : '<p>Nenhum pagamento recebido.</p>'}
    <h3>Histórico de compras e produtos</h3><div id="fi-historico-produtos">${compras.length ? compras.map(v=>`<details class="fi-compra">
      <summary>Venda #${v.numero} · ${escapar(v.criado_em)} · ${formatarBRL(v.total_centavos)} · ${v.status==='cancelada'?'Cancelada':'Finalizada'}</summary>
      <table><thead><tr><th>Produto na compra</th><th>Quantidade</th><th>Preço unitário</th><th>Total do item</th></tr></thead><tbody>${v.itens.map(i=>`<tr><td>${escapar(i.descricao)}</td><td>${formatarQtd(i.qtd_milesimal)} ${escapar(i.unidade)}</td><td>${formatarBRL(i.preco_unit_centavos)}</td><td>${formatarBRL(i.total_item_centavos)}</td></tr>`).join('')}</tbody></table></details>`).join('') : '<p>Nenhuma compra.</p>'}</div>`;
  $('#fi-receber-total')?.addEventListener('click',()=>receber({clienteCompleto:true,saldo_centavos:r.saldoCentavos},c,contas));
  $('#fi-editar').onclick = () => editarCliente(c);
  $('#fi-ativo').onclick = async () => {
    if (!(await confirmar({ titulo: c.ativo ? 'Inativar cliente' : 'Reativar cliente', texto: 'O histórico e os saldos serão preservados.' }))) return;
    if (await tentar(() => api.clientes.definirAtivo(c.id, !c.ativo))) aoEntrar();
  };
  $('#fi-detalhe').querySelectorAll('[data-receber]').forEach(b => b.onclick = () => receber(contas.find(x => x.id === Number(b.dataset.receber)), c));
}

function editarCliente(c = {}) {
  const m = abrirModal(`<h3>${c.id ? 'Editar' : 'Cadastrar'} cliente</h3>
    <label for="fc-nome">Nome *</label><input id="fc-nome" maxlength="200" value="${escapar(c.nome || '')}">
    <label for="fc-telefone">Telefone</label><input id="fc-telefone" value="${escapar(c.telefone || '')}">
    <label for="fc-endereco">Endereço</label><input id="fc-endereco" value="${escapar(c.endereco || '')}">
    <label for="fc-observacoes">Observações</label><textarea id="fc-observacoes">${escapar(c.observacoes || '')}</textarea>
    <div class="btn-row"><button class="btn btn-ghost" id="fc-voltar">Voltar</button><button class="btn btn-primary" id="fc-salvar">Salvar cliente</button></div>`);
  $('#fc-voltar', m).onclick = fecharModal;
  $('#fc-salvar', m).onclick = async e => {
    e.target.disabled = true;
    const dados = Object.fromEntries(['nome','telefone','endereco','observacoes'].map(k => [k, $(`#fc-${k}`, m).value]));
    const id = await tentar(() => api.clientes.salvar(c.id ?? null, dados));
    if (id !== undefined) { clienteId = id; fecharModal(); aoEntrar(); }
    else e.target.disabled = false;
  };
  $('#fc-nome', m).focus();
}

async function caixa() {
  const r = await tentar(() => api.fiado.caixaAtual());
  if (!r) return;
  $('#fi-caixa').innerHTML = r.sessao ? `<p>Sessão #${r.sessao.id} aberta por ${escapar(r.sessao.aberta_por)}.</p>
    ${r.formas.map(f => `<p>${escapar(f.forma)}: ${formatarBRL(f.total_centavos)}</p>`).join('') || '<p>Nenhum recebimento nesta sessão.</p>'}
    <button class="btn btn-ghost" id="fi-fechar-caixa">Encerrar sessão de recebimentos</button>` : `<p>Nenhuma sessão aberta.</p><label for="fi-operador">Operador</label><input id="fi-operador" value="Operador"><button class="btn btn-primary" id="fi-abrir-caixa">Abrir sessão de recebimentos</button>`;
  $('#fi-abrir-caixa')?.addEventListener('click', async e => {
    e.target.disabled = true;
    await tentar(() => api.fiado.abrirCaixa({ operador: $('#fi-operador').value }));
    caixa();
  });
  $('#fi-fechar-caixa')?.addEventListener('click', async () => {
    if (!(await confirmar({ titulo: 'Encerrar sessão', texto: 'Os recebimentos serão preservados com os totais desta sessão.' }))) return;
    await tentar(() => api.fiado.fecharCaixa({ sessaoId: r.sessao.id, operador: r.sessao.aberta_por }));
    caixa();
  });
}

async function receber(conta, cliente, contas = []) {
  if (!(await recuperarRecebimento())) return;
  const atual = await tentar(() => api.fiado.caixaAtual());
  if (!atual?.sessao) { toast('Abra a sessão de recebimentos no final desta tela.', 'err'); return; }
  let operacaoId = crypto.randomUUID();
  let pendente = null;
  const porCliente = Boolean(conta.clienteCompleto);
  const abertas = contas.filter(c=>c.saldo_centavos>0).sort((a,b)=>a.criado_em.localeCompare(b.criado_em)||a.id-b.id);
  const distribuir = valor => {
    let restante=valor;
    const rateio=[];
    for(const c of abertas){if(restante<=0)break;const aplicado=Math.min(restante,c.saldo_centavos);rateio.push({contaId:c.id,valorCentavos:aplicado});restante-=aplicado;}
    return rateio;
  };
  const m = abrirModal(`<h3>${porCliente?'Receber do saldo total de':'Receber de'} ${escapar(cliente.nome)}</h3><p>Saldo: ${formatarBRL(conta.saldo_centavos)}</p>
    ${porCliente?'<p>O valor será abatido das compras mais antigas primeiro.</p>':''}
    <label for="fr-valor">Valor a abater (R$)</label><input id="fr-valor" inputmode="decimal" value="${(conta.saldo_centavos/100).toFixed(2).replace('.', ',')}">
    <label for="fr-forma">Forma</label><select id="fr-forma"><option value="dinheiro">Dinheiro</option><option value="pix">PIX</option><option value="debito">Débito</option><option value="credito">Crédito</option></select>
    <label for="fr-recebido">Dinheiro entregue (opcional, para calcular troco)</label><input id="fr-recebido" inputmode="decimal">
    <div id="fr-troco"></div><div id="fr-distribuicao"></div><div class="btn-row"><button id="fr-voltar" class="btn btn-ghost">Voltar</button><button id="fr-confirmar" class="btn btn-primary">Confirmar recebimento</button></div>`);
  const troco = () => {
    const valor = paraCentavos($('#fr-valor',m).value);
    const recebido = paraCentavos($('#fr-recebido',m).value);
    $('#fr-recebido',m).disabled = $('#fr-forma',m).value !== 'dinheiro';
    $('#fr-troco',m).textContent = `Troco: ${formatarBRL($('#fr-forma',m).value === 'dinheiro' ? Math.max(0,(recebido ?? valor)-(valor ?? 0)) : 0)}`;
    if(porCliente) $('#fr-distribuicao',m).innerHTML = valor>0 && valor<=conta.saldo_centavos
      ? `<p><b>Distribuição deste pagamento:</b></p>${distribuir(valor).map(d=>{const c=abertas.find(c=>c.id===d.contaId);return `<p>Venda ${c.venda_numero?'#'+c.venda_numero:'—'}: ${formatarBRL(d.valorCentavos)}</p>`;}).join('')}<p>Saldo total após receber: <b>${formatarBRL(conta.saldo_centavos-valor)}</b></p>`
      : '<p>Informe um valor positivo até o saldo total.</p>';
  };
  m.querySelectorAll('input,select').forEach(el => el.addEventListener('input',troco));
  $('#fr-voltar',m).onclick = fecharModal;
  $('#fr-confirmar',m).onclick = async e => {
    if (!pendente) {
      const valorCentavos = paraCentavos($('#fr-valor',m).value);
      const forma = $('#fr-forma',m).value;
      const textoRecebido = $('#fr-recebido',m).value.trim();
      const recebidoCentavos = forma === 'dinheiro' ? (textoRecebido ? paraCentavos(textoRecebido) : valorCentavos) : null;
      if (!Number.isSafeInteger(valorCentavos) || valorCentavos <= 0 || valorCentavos > conta.saldo_centavos || (forma === 'dinheiro' && (!Number.isSafeInteger(recebidoCentavos) || recebidoCentavos < valorCentavos))) {
        toast('Confira o valor a abater e o dinheiro entregue.', 'err'); return;
      }
      pendente = { operacaoId, ...(porCliente ? {clienteId:cliente.id,rateioEsperado:distribuir(valorCentavos)} : {contaId:conta.id}), sessaoId: atual.sessao.id, valorCentavos, forma, recebidoCentavos };
    }
    try { localStorage.setItem(CHAVE_RECEBIMENTO, JSON.stringify(pendente)); }
    catch { toast('Não foi possível salvar a operação pendente. Nenhum recebimento foi enviado.', 'err'); return; }
    e.target.disabled = true;
    m.querySelectorAll('input,select').forEach(el => el.disabled = true);
    const r = await tentar(() => enviarRecebimento(pendente), { aoFalhar(erro) {
      if (erro.codigo && erro.codigo !== 'ERRO_INTERNO') {
        localStorage.removeItem(CHAVE_RECEBIMENTO); pendente = null; operacaoId = crypto.randomUUID();
        m.querySelectorAll('input,select').forEach(el => el.disabled = false);
        troco();
      }
      toast(erro.message || 'Sem confirmação. Tente novamente a mesma operação.', 'err');
    } });
    if (r !== undefined) { localStorage.removeItem(CHAVE_RECEBIMENTO); fecharModal(); toast('Recebimento registrado.'); aoEntrar(); }
    else { e.target.disabled = false; e.target.textContent = pendente ? 'Tentar o mesmo recebimento novamente' : 'Confirmar recebimento'; }
  };
  troco();
}
