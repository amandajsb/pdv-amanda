import electron from 'electron'; // ver comentário em util/caminhos.js
import fs from 'node:fs';

const { ipcMain, dialog, shell, app } = electron;
import * as produtosRepo from '../repos/produtosRepo.js';
import * as estoqueRepo from '../repos/estoqueRepo.js';
import * as vendasRepo from '../repos/vendasRepo.js';
import * as relatoriosRepo from '../repos/relatoriosRepo.js';
import * as configRepo from '../repos/configRepo.js';
import * as vendaServico from '../servicos/vendaServico.js';
import * as comandasRepo from '../repos/comandasRepo.js';
import * as comandaServico from '../servicos/comandaServico.js';
import * as fornecedoresRepo from '../repos/fornecedoresRepo.js';
import * as clientesRepo from '../repos/clientesRepo.js';
import * as fiadoServico from '../servicos/fiadoServico.js';
import { importar } from '../servicos/importacaoServico.js';
import { backupAgora, ultimoBackup } from '../servicos/backupServico.js';
import { exportarPdf } from '../servicos/pdfServico.js';
import { obterBanco } from '../db/conexao.js';
import {
  caminhoBanco, pastaPdv, pastaBackups, pastaBackupPersonalizada, definirPastaBackupPersonalizada
} from '../util/caminhos.js';
import { ErroNegocio, CODIGOS, paraResposta } from '../util/erros.js';
import { agoraTimestamp, hojeISO, somarDiasISO } from '../../compartilhado/formato/data.js';

/**
 * Registra todos os canais. Cada handler devolve sempre
 *   { ok: true, dados } | { ok: false, codigo, mensagem }
 * para que o renderer nunca precise de try/catch em volta de cada chamada e
 * nunca receba uma stack trace.
 */
export function registrarIpc({ log = console } = {}) {
  const canal = (nome, fn) => {
    ipcMain.handle(nome, async (_evento, ...args) => {
      try {
        return { ok: true, dados: await fn(...args) };
      } catch (e) {
        return paraResposta(e, log);
      }
    });
  };

  canal('clientes:listar', (filtro) => clientesRepo.listar(filtro || {}));
  canal('clientes:salvar', (id, dados) => clientesRepo.salvar(id, dados));
  canal('clientes:definirAtivo', (id, ativo) => clientesRepo.definirAtivo(id, ativo));
  canal('fiado:extrato', (clienteId) => fiadoServico.extrato(clienteId));
  canal('fiado:receber', (entrada) => fiadoServico.receber(entrada));
  canal('fiado:receberCliente', (entrada) => fiadoServico.receberCliente(entrada));
  canal('fiado:caixaAtual', () => fiadoServico.caixaAtual());
  canal('fiado:abrirCaixa', (entrada) => fiadoServico.abrirCaixa(entrada));
  canal('fiado:fecharCaixa', (entrada) => fiadoServico.fecharCaixa(entrada));

  // ------------------------------ Produtos ------------------------------
  canal('produtos:listar', (filtro) => produtosRepo.listar(filtro || {}));
  canal('produtos:porId', (id) => produtosRepo.porId(id));
  canal('produtos:buscarPorCodigo', (codigo) => produtosRepo.buscarPorCodigo(codigo));
  canal('produtos:codigos', (id) => produtosRepo.codigosDe(id));

  canal('produtos:criar', (dados) => {
    validarProduto(dados);
    for (const c of dados.codigos || []) {
      const dono = produtosRepo.donoDoCodigo(c);
      if (dono) {
        const p = produtosRepo.porId(dono.produto_id);
        throw new ErroNegocio(
          CODIGOS.CODIGO_DUPLICADO,
          `O código ${c} já pertence a "${p?.nome ?? 'outro produto'}".`
        );
      }
    }
    return produtosRepo.criar(dados);
  });

  canal('produtos:atualizar', (id, dados) => {
    validarProduto(dados);
    if (!produtosRepo.porId(id)) {
      throw new ErroNegocio(CODIGOS.PRODUTO_NAO_ENCONTRADO, 'Produto não encontrado.');
    }
    produtosRepo.atualizar(id, dados);
    return true;
  });

  canal('produtos:inativar', (id) => {
    produtosRepo.inativar(id);
    return true;
  });

  canal('produtos:adicionarCodigo', (produtoId, codigo) => {
    const limpo = String(codigo || '').trim();
    if (!limpo) throw new ErroNegocio(CODIGOS.DADOS_INVALIDOS, 'Informe o código de barras.');
    const dono = produtosRepo.donoDoCodigo(limpo);
    if (dono) {
      const p = produtosRepo.porId(dono.produto_id);
      throw new ErroNegocio(
        CODIGOS.CODIGO_DUPLICADO,
        `O código ${limpo} já pertence a "${p?.nome ?? 'outro produto'}".`
      );
    }
    const jaTem = produtosRepo.codigosDe(produtoId).length > 0;
    produtosRepo.adicionarCodigo(produtoId, limpo, { principal: !jaTem });
    return true;
  });

  canal('produtos:removerCodigo', (codigoId) => {
    produtosRepo.removerCodigo(codigoId);
    return true;
  });

  // ----------------------------- Fornecedores ----------------------------
  canal('fornecedores:listar', (filtro) => fornecedoresRepo.listar(filtro || {}));
  canal('fornecedores:porId', (id) => fornecedoresRepo.porId(id));

  canal('fornecedores:criar', (dados) => {
    validarFornecedor(dados);
    return fornecedoresRepo.criar(dados);
  });

  canal('fornecedores:atualizar', (id, dados) => {
    validarFornecedor(dados);
    if (!fornecedoresRepo.porId(id)) {
      throw new ErroNegocio(CODIGOS.FORNECEDOR_NAO_ENCONTRADO, 'Fornecedor não encontrado.');
    }
    fornecedoresRepo.atualizar(id, dados);
    return true;
  });

  canal('fornecedores:inativar', (id) => {
    fornecedoresRepo.inativar(id);
    return true;
  });

  // ------------------------------- Estoque ------------------------------
  canal('estoque:entrada', ({ produtoId, qtdMilesimal, motivo, custoUnitCentavos }) => {
    if (!(qtdMilesimal > 0)) {
      throw new ErroNegocio(CODIGOS.DADOS_INVALIDOS, 'A quantidade da entrada deve ser maior que zero.');
    }
    return obterBanco().transaction(() =>
      estoqueRepo.lancar(produtoId, 'entrada', qtdMilesimal, { motivo, custoUnitCentavos })
    )();
  });

  canal('estoque:ajustar', ({ produtoId, novoSaldoMilesimal, motivo }) => {
    if (!motivo || !String(motivo).trim()) {
      throw new ErroNegocio(CODIGOS.DADOS_INVALIDOS, 'Informe o motivo do ajuste de estoque.');
    }
    const p = produtosRepo.porId(produtoId);
    if (!p) throw new ErroNegocio(CODIGOS.PRODUTO_NAO_ENCONTRADO, 'Produto não encontrado.');
    const delta = novoSaldoMilesimal - p.estoque_milesimal;
    if (delta === 0) return p.estoque_milesimal;
    return obterBanco().transaction(() =>
      estoqueRepo.lancar(produtoId, 'ajuste', delta, { motivo: String(motivo).trim() })
    )();
  });

  canal('estoque:movimentos', (produtoId) => estoqueRepo.movimentosDe(produtoId));
  canal('estoque:recalcularCache', () => estoqueRepo.recalcularCache());

  // -------------------------------- Vendas ------------------------------
  canal('vendas:finalizar', (entrada) => vendaServico.finalizar(entrada, { log }));
  canal('vendas:adicionarItens', (vendaId, entrada) => vendaServico.adicionarItens(vendaId, entrada, { log }));
  canal('vendas:removerItem', (vendaId, itemId, entrada) => vendaServico.removerItem(vendaId, itemId, entrada, { log }));
  canal('vendas:cancelar', (entrada) => vendaServico.cancelar(entrada, { log }));
  canal('vendas:porId', (id) => vendasRepo.porId(id));
  canal('vendas:listarDoPeriodo', (dataInicio, dataFim) => vendasRepo.listarDoPeriodo(dataInicio, dataFim));
  canal('vendas:rascunhoSalvar', (json) => {
    vendasRepo.salvarRascunho(json, agoraTimestamp());
    return true;
  });
  canal('vendas:rascunhoLer', () => vendasRepo.lerRascunho());
  canal('vendas:rascunhoLimpar', () => {
    vendasRepo.limparRascunho();
    return true;
  });

  // ------------------------------ Comandas ------------------------------
  canal('comandas:abrir', ({ identificador, clienteNome, operador, observacoes } = {}) => {
    if (!identificador || !String(identificador).trim()) {
      throw new ErroNegocio(CODIGOS.DADOS_INVALIDOS, 'Informe a mesa ou o nome do cliente.');
    }
    return comandasRepo.abrir({ identificador, clienteNome, operador, observacoes });
  });
  canal('comandas:listarAbertas', () => comandasRepo.listarAbertas());
  canal('comandas:porId', (id) => comandasRepo.porId(id));

  canal('comandas:adicionarItem', (comandaId, { produtoId, qtdMilesimal }) => {
    const comanda = comandasRepo.porId(comandaId);
    if (!comanda) throw new ErroNegocio(CODIGOS.COMANDA_NAO_ENCONTRADA, 'Comanda não encontrada.');
    if (comanda.status === 'fechada') {
      throw new ErroNegocio(CODIGOS.COMANDA_JA_FECHADA, 'Essa comanda já foi fechada.');
    }
    const p = produtosRepo.porId(produtoId);
    if (!p) throw new ErroNegocio(CODIGOS.PRODUTO_NAO_ENCONTRADO, 'Produto não encontrado.');
    if (!(qtdMilesimal > 0)) {
      throw new ErroNegocio(CODIGOS.DADOS_INVALIDOS, 'Informe uma quantidade maior que zero.');
    }
    return comandasRepo.adicionarItem(comandaId, {
      produtoId: p.id,
      descricao: p.nome,
      precoUnitCentavos: p.preco_centavos,
      qtdMilesimal
    });
  });

  canal('comandas:removerItem', (itemId) => {
    comandasRepo.removerItem(itemId);
    return true;
  });

  canal('comandas:fechar', (comandaId, entrada) => comandaServico.fechar(comandaId, entrada, { log }));

  // ------------------------------ Relatórios ----------------------------
  canal('relatorios:doPeriodo', (dataInicio, dataFim) => ({
    fiado: relatoriosRepo.fiadoDoPeriodo(dataInicio, dataFim),
    resumo: relatoriosRepo.resumoDoPeriodo(dataInicio, dataFim),
    produtos: relatoriosRepo.produtosDoPeriodo(dataInicio, dataFim),
    formas: relatoriosRepo.porFormaPagamento(dataInicio, dataFim)
  }));
  canal('relatorios:diasComVenda', (limite) => relatoriosRepo.diasComVenda(limite));
  canal('relatorios:estoqueAtual', () => relatoriosRepo.estoqueAtual());
  canal('relatorios:produtosAVencer', (dias = 10) =>
    relatoriosRepo.produtosAVencer(somarDiasISO(hojeISO(), dias))
  );

  // ------------------------------- Config -------------------------------
  canal('config:obterTudo', () => configRepo.obterTudo());
  canal('config:definirVarios', (obj) => {
    configRepo.definirVarios(obj);
    return true;
  });

  // ------------------------------- Sistema ------------------------------
  canal('sistema:info', () => ({
    demonstracao: process.argv.includes('--fiado-demo'),
    versaoApp: app.getVersion(),
    versaoElectron: process.versions.electron,
    versaoEsquema: obterBanco().pragma('user_version', { simple: true }),
    caminhoBanco: caminhoBanco(),
    pastaPdv: pastaPdv(),
    pastaBackups: pastaBackups(),
    pastaBackupPersonalizada: pastaBackupPersonalizada(),
    ultimoBackup: ultimoBackup()
  }));

  canal('sistema:escolherPastaBackup', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Escolha a pasta onde salvar os backups (fora da nuvem, se preferir)',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    definirPastaBackupPersonalizada(r.filePaths[0]);
    return pastaBackups();
  });

  canal('sistema:usarPastaBackupAutomatica', () => {
    definirPastaBackupPersonalizada(null);
    return pastaBackups();
  });

  canal('sistema:importarArquivo', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Escolha o arquivo exportado do sistema anterior',
      filters: [{ name: 'Export do PDV', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const caminho = r.filePaths[0];
    return importar(fs.readFileSync(caminho, 'utf8'), { arquivo: caminho, log });
  });

  canal('sistema:backupAgora', () => backupAgora({ log }));
  canal('sistema:exportarPdf', (entrada) => exportarPdf(entrada, { log }));

  canal('sistema:abrirPasta', (qual) => {
    shell.openPath(qual === 'banco' ? app.getPath('userData') : pastaBackups());
    return true;
  });
}

function validarProduto(d) {
  if (!d?.nome || !String(d.nome).trim()) {
    throw new ErroNegocio(CODIGOS.DADOS_INVALIDOS, 'Informe o nome do produto.');
  }
  if (!Number.isInteger(d.precoCentavos) || d.precoCentavos < 0) {
    throw new ErroNegocio(CODIGOS.DADOS_INVALIDOS, 'Informe um preço válido.');
  }
}

function validarFornecedor(d) {
  if (!d?.nome || !String(d.nome).trim()) {
    throw new ErroNegocio(CODIGOS.DADOS_INVALIDOS, 'Informe o nome do fornecedor.');
  }
}
