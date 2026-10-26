// Único arquivo CommonJS do projeto: com `sandbox: true` o preload não pode
// ser ESM. Ele não tem lógica nenhuma — só expõe canais nomeados — então não
// perde nada por isso.
//
// Este arquivo é o contrato inteiro entre a tela e o resto do sistema. Nada
// além do que está aqui atravessa a fronteira: o renderer não tem acesso a
// `require`, ao sistema de arquivos nem ao banco.

const { contextBridge, ipcRenderer } = require('electron');

const chamar = (canal) => (...args) => ipcRenderer.invoke(canal, ...args);

contextBridge.exposeInMainWorld('pdv', {
  clientes: {
    listar: chamar('clientes:listar'),
    salvar: chamar('clientes:salvar'),
    definirAtivo: chamar('clientes:definirAtivo')
  },
  fiado: {
    extrato: chamar('fiado:extrato'),
    receber: chamar('fiado:receber'),
    receberCliente: chamar('fiado:receberCliente'),
    caixaAtual: chamar('fiado:caixaAtual'),
    abrirCaixa: chamar('fiado:abrirCaixa'),
    fecharCaixa: chamar('fiado:fecharCaixa')
  },
  produtos: {
    listar: chamar('produtos:listar'),
    porId: chamar('produtos:porId'),
    buscarPorCodigo: chamar('produtos:buscarPorCodigo'),
    criar: chamar('produtos:criar'),
    atualizar: chamar('produtos:atualizar'),
    inativar: chamar('produtos:inativar'),
    codigos: chamar('produtos:codigos'),
    adicionarCodigo: chamar('produtos:adicionarCodigo'),
    removerCodigo: chamar('produtos:removerCodigo')
  },

  fornecedores: {
    listar: chamar('fornecedores:listar'),
    porId: chamar('fornecedores:porId'),
    criar: chamar('fornecedores:criar'),
    atualizar: chamar('fornecedores:atualizar'),
    inativar: chamar('fornecedores:inativar')
  },

  estoque: {
    entrada: chamar('estoque:entrada'),
    ajustar: chamar('estoque:ajustar'),
    movimentos: chamar('estoque:movimentos'),
    recalcularCache: chamar('estoque:recalcularCache')
  },

  vendas: {
    finalizar: chamar('vendas:finalizar'),
    adicionarItens: chamar('vendas:adicionarItens'),
    removerItem: chamar('vendas:removerItem'),
    cancelar: chamar('vendas:cancelar'),
    porId: chamar('vendas:porId'),
    listarDoPeriodo: chamar('vendas:listarDoPeriodo'),
    rascunhoSalvar: chamar('vendas:rascunhoSalvar'),
    rascunhoLer: chamar('vendas:rascunhoLer'),
    rascunhoLimpar: chamar('vendas:rascunhoLimpar')
  },

  comandas: {
    abrir: chamar('comandas:abrir'),
    listarAbertas: chamar('comandas:listarAbertas'),
    porId: chamar('comandas:porId'),
    adicionarItem: chamar('comandas:adicionarItem'),
    removerItem: chamar('comandas:removerItem'),
    fechar: chamar('comandas:fechar')
  },

  relatorios: {
    doPeriodo: chamar('relatorios:doPeriodo'),
    diasComVenda: chamar('relatorios:diasComVenda'),
    estoqueAtual: chamar('relatorios:estoqueAtual'),
    produtosAVencer: chamar('relatorios:produtosAVencer')
  },

  config: {
    obterTudo: chamar('config:obterTudo'),
    definirVarios: chamar('config:definirVarios')
  },

  sistema: {
    info: chamar('sistema:info'),
    importarArquivo: chamar('sistema:importarArquivo'),
    backupAgora: chamar('sistema:backupAgora'),
    exportarPdf: chamar('sistema:exportarPdf'),
    abrirPasta: chamar('sistema:abrirPasta'),
    escolherPastaBackup: chamar('sistema:escolherPastaBackup'),
    usarPastaBackupAutomatica: chamar('sistema:usarPastaBackupAutomatica')
  }
});
