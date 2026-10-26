import { api, tentar } from './api.js';
import { $, $$ } from './lib/dom.js';
import * as telaVender from './telas/telaVender.js';
import * as telaComandas from './telas/telaComandas.js';
import * as telaEstoque from './telas/telaEstoque.js';
import * as telaFornecedores from './telas/telaFornecedores.js';
import * as telaRelatorios from './telas/telaRelatorios.js';
import * as telaAjustes from './telas/telaAjustes.js';
import * as telaClientes from './telas/telaClientes.js';

const TELAS = {
  clientes: telaClientes,
  vender: telaVender,
  comandas: telaComandas,
  estoque: telaEstoque,
  fornecedores: telaFornecedores,
  relatorios: telaRelatorios,
  ajustes: telaAjustes
};

let atual = 'vender';

function trocarAba(nome) {
  if (!TELAS[nome]) return;
  atual = nome;
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === nome));
  $$('.tab').forEach((t) => t.classList.remove('active'));
  $(`#tab-${nome}`).classList.add('active');
  TELAS[nome].aoEntrar?.();
}

async function atualizarBarraDeStatus() {
  const [cfg, info, estoque] = await Promise.all([
    tentar(() => api.config.obterTudo(), { aoFalhar: () => {} }),
    tentar(() => api.sistema.info(), { aoFalhar: () => {} }),
    tentar(() => api.relatorios.estoqueAtual(), { aoFalhar: () => {} })
  ]);

  if (cfg) {
    // Controle de caixa entra na fase 4; até lá a barra diz isso claramente em
    // vez de mostrar um estado que não existe.
    $('#st-caixa').textContent = 'não controlado';
    const modo = cfg.impressao_modo;
    $('#st-impressora').textContent =
      modo === 'nenhum' || !modo ? 'não configurada' : `${modo} ${cfg.impressao_largura}mm`;
  }

  if (info) {
    $('#st-backup').textContent = info.ultimoBackup
      ? new Date(info.ultimoBackup.em).toLocaleDateString('pt-BR')
      : 'nunca';
  }

  if (estoque) {
    const baixos = estoque.filter((p) => p.estoque_milesimal <= p.estoque_minimo_milesimal).length;
    const el = $('#st-estoque');
    el.textContent = baixos ? `⚠ ${baixos} produto(s) com estoque baixo` : '';
    el.className = baixos ? 'item alerta' : 'item';
  }
}

async function iniciar() {
  $$('.tab-btn').forEach((b) => b.addEventListener('click', () => trocarAba(b.dataset.tab)));

  telaVender.montar({ aoFinalizar: atualizarBarraDeStatus });
  telaComandas.montar();
  telaEstoque.montar();
  telaFornecedores.montar();
  telaClientes.montar();
  telaRelatorios.montar();
  telaAjustes.montar({ aoMudar: atualizarBarraDeStatus });

  const info = await tentar(() => api.sistema.info(), { aoFalhar: () => {} });
  if (info) $('#hdr-versao').textContent = info.demonstracao ? 'DEMONSTRAÇÃO · dados fictícios' : `v${info.versaoApp}`;

  await atualizarBarraDeStatus();
  trocarAba('vender');
  await telaVender.recuperarRascunho();

  // Deixar o app aberto o dia inteiro faria a barra envelhecer; 5 min é
  // suficiente para o alerta de estoque baixo continuar útil.
  setInterval(atualizarBarraDeStatus, 5 * 60 * 1000);
}

iniciar();
