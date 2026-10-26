import { api, tentar } from '../api.js';
import { $, escapar, abrirModal, fecharModal, toast } from './dom.js';
import { formatarBRL } from '/compartilhado/formato/moeda.js';
import { chaveNomeCliente } from '/compartilhado/formato/nomeCliente.js';

export async function escolherClienteFiado(totalCentavos) {
  const clientes = await tentar(() => api.clientes.listar({ apenasAtivos: true }));
  if (!clientes) return null;
  return new Promise(resolve => {
    let salvando = false;
    let busca = 0;
    const responder = r => { if(salvando)return; ++busca; fecharModal(); resolve(r); };
    let ultimoNomeSalvo = null;
    let lista = clientes;
    let selecionado = null;
    let indice = -1;
    const m = abrirModal(`<div class="vf-cabecalho"><h3>Venda fiada · ${formatarBRL(totalCentavos)}</h3>
      <button type="button" id="vf-abrir-cadastro" class="btn btn-primary" aria-expanded="false" aria-controls="vf-cadastro-rapido">+ Cadastrar cliente rápido</button></div>
      <p>O valor ficará em contas a receber. Nenhum dinheiro entra no caixa agora.</p>
      <label for="vf-busca">Buscar cliente por nome ou telefone</label><input id="vf-busca" type="search" autocomplete="off"
        placeholder="Digite o início do nome ou telefone" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="vf-resultados">
      <div id="vf-resultados" class="vf-resultados" role="listbox" aria-label="Clientes encontrados"></div>
      <p id="vf-busca-msg" role="status" aria-live="polite"></p>
      <label for="vf-cliente">Cliente selecionado (obrigatório)</label><select id="vf-cliente"></select>
      <div id="vf-cadastro-rapido" class="vf-cadastro-rapido" hidden><h3>Cadastrar cliente rápido</h3>
        <label for="vf-nome">Nome *</label><input id="vf-nome" maxlength="200">
        <p class="sub">Se já existir esse nome, acrescente um sobrenome para diferenciar.</p>
        <label for="vf-telefone">Telefone (opcional)</label><input id="vf-telefone">
        <label for="vf-endereco">Endereço (opcional)</label><input id="vf-endereco">
        <label for="vf-observacoes">Observações (opcional)</label><input id="vf-observacoes">
        <button class="btn btn-primary" id="vf-cadastrar">Cadastrar e selecionar</button>
      </div>
      <p id="vf-cadastro-msg" role="status" aria-live="polite"></p>
      <label for="vf-vencimento">Vencimento (opcional)</label><input id="vf-vencimento" type="date">
      <div class="btn-row"><button class="btn btn-ghost" id="vf-voltar">Voltar</button><button class="btn btn-primary" id="vf-confirmar">Confirmar venda fiada</button></div>`);
    const campoBusca=$('#vf-busca',m);
    const resultados=$('#vf-resultados',m);
    const botaoCadastro=$('#vf-abrir-cadastro',m);
    const formulario=$('#vf-cadastro-rapido',m);
    const mostrarResultados = mostrar => {
      resultados.hidden=!mostrar;
      campoBusca.setAttribute('aria-expanded',String(mostrar));
      if(!mostrar)campoBusca.removeAttribute('aria-activedescendant');
    };
    const alternarCadastro = abrir => {
      formulario.hidden=!abrir;
      botaoCadastro.setAttribute('aria-expanded',String(abrir));
      botaoCadastro.textContent=abrir?'Fechar cadastro rápido':'+ Cadastrar cliente rápido';
      if(abrir){mostrarResultados(false);$('#vf-nome',m).focus();}
    };
    botaoCadastro.onclick=()=>{if(!salvando)alternarCadastro(formulario.hidden);};
    const desenhar = id => {
      if(id!=null)selecionado=lista.find(c=>c.id===Number(id))||selecionado;
      const opcoes=selecionado&&!lista.some(c=>c.id===selecionado.id)?[selecionado,...lista]:lista;
      $('#vf-cliente',m).innerHTML = '<option value="">Selecione um cliente</option>' + opcoes.map(c => `<option value="${c.id}">${escapar(c.nome)}${c.telefone ? ' · ' + escapar(c.telefone) : ''}</option>`).join('');
      $('#vf-cliente',m).value=selecionado?.id||'';
      resultados.innerHTML=lista.slice(0,30).map((c,i)=>`<button type="button" id="vf-opcao-${i}" class="vf-cliente-opcao ${i===indice?'ativa':''}" role="option" aria-selected="${selecionado?.id===c.id}" data-vf-cliente="${c.id}"><strong>${escapar(c.nome)}</strong><small>${escapar(c.telefone||'Telefone não informado')}</small></button>`).join('');
      if(indice>=0){campoBusca.setAttribute('aria-activedescendant',`vf-opcao-${indice}`);$(`#vf-opcao-${indice}`,m)?.scrollIntoView({block:'nearest'});}
      else campoBusca.removeAttribute('aria-activedescendant');
    };
    const escolher = id => {
      if(salvando)return;
      const c=lista.find(c=>c.id===Number(id));if(!c)return;
      ++busca;selecionado=c;indice=-1;desenhar(c.id);
      campoBusca.value=c.nome;mostrarResultados(false);
      $('#vf-busca-msg',m).textContent=`Cliente selecionado: ${c.nome}.`;
      $('#vf-confirmar',m).focus();
    };
    resultados.onclick=e=>{const b=e.target.closest('[data-vf-cliente]');if(b)escolher(b.dataset.vfCliente);};
    $('#vf-cliente',m).onchange=()=>escolher($('#vf-cliente',m).value);
    campoBusca.onkeydown=e=>{
      if(['ArrowDown','ArrowUp'].includes(e.key)&&lista.length){e.preventDefault();e.stopPropagation();mostrarResultados(true);indice=e.key==='ArrowDown'?Math.min(Math.min(lista.length,30)-1,indice+1):(indice<0?Math.min(lista.length,30)-1:Math.max(0,indice-1));desenhar();}
      if(e.key==='Enter'){e.preventDefault();e.stopPropagation();if(!resultados.hidden&&(indice>=0||lista.length===1))escolher(lista[Math.max(0,indice)].id);}
      if(e.key==='Escape'&&!resultados.hidden){e.preventDefault();e.stopPropagation();mostrarResultados(false);}
    };
    $('#vf-nome',m).oninput = () => {
      if (salvando) return;
      const jaSalvo = ultimoNomeSalvo && chaveNomeCliente($('#vf-nome',m).value) === ultimoNomeSalvo;
      $('#vf-cadastrar',m).disabled = Boolean(jaSalvo);
      $('#vf-cadastrar',m).textContent = jaSalvo ? 'Cliente cadastrado e selecionado' : 'Cadastrar e selecionar';
    };
    campoBusca.oninput = async () => {
      const atual = ++busca;
      selecionado=null;indice=-1;lista=[];desenhar();mostrarResultados(true);
      $('#vf-busca-msg',m).textContent='Buscando clientes…';
      const nova = await tentar(() => api.clientes.listar({ termo: campoBusca.value, apenasAtivos: true }),{aoFalhar(erro){if(atual===busca&&$('#vf-busca',m)===campoBusca)$('#vf-busca-msg',m).textContent=erro.message;}});
      if (nova && atual === busca && $('#vf-busca',m)===campoBusca) {
        lista = nova; desenhar();
        $('#vf-busca-msg',m).textContent=nova.length?(nova.length>30?'Mostrando 30 clientes. Digite mais letras para filtrar.':'Clique no cliente para selecionar, ou use ↑ ↓ e Enter.'):'Nenhum cliente encontrado. Use o botão Cadastrar cliente rápido.';
      }
    };
    $('#vf-cadastrar',m).onclick = async e => {
      if (salvando) return;
      if (ultimoNomeSalvo && chaveNomeCliente($('#vf-nome',m).value) === ultimoNomeSalvo) return;
      salvando = true; e.target.disabled = true;
      e.target.textContent = 'Salvando…';
      $('#vf-cadastro-msg',m).textContent = '';
      const dados = Object.fromEntries(['nome','telefone','endereco','observacoes'].map(k => [k,$(`#vf-${k}`,m).value]));
      m.querySelectorAll('#vf-cadastro-rapido input').forEach(campo => campo.disabled = true);
      botaoCadastro.disabled=true;campoBusca.disabled=true;$('#vf-voltar',m).disabled=true;$('#vf-confirmar',m).disabled=true;$('#vf-cliente',m).disabled=true;
      const id = await tentar(() => api.clientes.salvar(null,dados), { aoFalhar(erro) {
        $('#vf-cadastro-msg',m).textContent = erro.message;
      } });
      if (id !== undefined) {
        ++busca; lista = [{ id, nome: dados.nome.trim(), telefone: dados.telefone },...lista]; desenhar(id);
        ultimoNomeSalvo = chaveNomeCliente(dados.nome);
        $('#vf-cadastro-msg',m).textContent = `Cliente ${dados.nome.trim()} cadastrado e selecionado. Agora confirme a venda fiada.`;
        campoBusca.value=dados.nome.trim();mostrarResultados(false);alternarCadastro(false);
        $('#vf-busca-msg',m).textContent=`Cliente selecionado: ${dados.nome.trim()}.`;
        $('#vf-confirmar',m).focus();
      }
      salvando = false;
      m.querySelectorAll('#vf-cadastro-rapido input').forEach(campo => campo.disabled = false);
      botaoCadastro.disabled=false;campoBusca.disabled=false;$('#vf-voltar',m).disabled=false;$('#vf-confirmar',m).disabled=false;$('#vf-cliente',m).disabled=false;
      e.target.disabled = id !== undefined;
      e.target.textContent = id !== undefined ? 'Cliente cadastrado e selecionado' : 'Cadastrar e selecionar';
      if (id === undefined) $('#vf-nome',m).focus();
      else $('#vf-confirmar',m).focus();
    };
    $('#vf-voltar',m).onclick = () => responder(null);
    m._aoEscape = () => responder(null);
    $('#vf-confirmar',m).onclick = () => {
      if (salvando) return;
      const clienteId = Number($('#vf-cliente',m).value);
      if (!clienteId) { toast('Selecione um cliente.', 'err'); return; }
      const input = $('#vf-vencimento',m);
      if (!input.checkValidity()) { input.reportValidity(); return; }
      responder({ clienteId, vencimento: input.value || null });
    };
    desenhar();
    $('#vf-busca-msg',m).textContent=lista.length?'Clique no cliente para selecionar, ou digite para filtrar.':'Nenhum cliente cadastrado. Use o botão Cadastrar cliente rápido.';
  });
}
