// Todos os dados são artificiais e ficam numa pasta temporária exclusiva.
import electron from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const { app } = electron;
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-fiado-e2e-'));
app.setPath('userData', pasta);
process.argv.push('--fiado-demo'); // Isola também backups e arquivos auxiliares.
const { abrirBanco, fecharBanco } = await import('../../src/main/db/conexao.js');
const { registrarIpc } = await import('../../src/main/ipc/registrarIpc.js');
const { registrarEsquemaPrivilegiado, registrarProtocolo, criarJanela } = await import('../../src/main/janela.js');
const log = { info() {}, warn() {}, error(e) { console.error(e); } };
registrarEsquemaPrivilegiado();
const esperar = ms => new Promise(r => setTimeout(r, ms));
const limite = setTimeout(() => { console.error('Tempo limite do teste de interface.'); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  let codigo = 0;
  const db = abrirBanco(path.join(pasta, 'teste-ficticio.db'), { log });
  registrarProtocolo({ log });
  registrarIpc({ log });
  const win = criarJanela({ log, mostrar: false });
  const wc = win.webContents;
  const erros = [];
  wc.on('console-message', e => { if (e.level === 'error') erros.push(e.message); });
  const exec = js => wc.executeJavaScript(js, true);
  const ate = async js => {
    for (let i = 0; i < 150; i++) { if (await exec(js)) return; await esperar(50); }
    throw new Error(`A interface não chegou ao estado esperado: ${js}`);
  };
  const clicar = async seletor => {
    await ate(`Boolean(document.querySelector(${JSON.stringify(seletor)}))`);
    await exec(`document.querySelector(${JSON.stringify(seletor)}).click()`);
  };
  const preencher = (seletor, valor) => exec(`(() => { const el=document.querySelector(${JSON.stringify(seletor)}); el.value=${JSON.stringify(valor)}; el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const chamar = async (grupo, metodo, ...args) => {
    const r = await exec(`window.pdv[${JSON.stringify(grupo)}][${JSON.stringify(metodo)}](...${JSON.stringify(args)})`);
    assert.ok(r.ok, r.mensagem);
    return r.dados;
  };
  const contar = tabela => db.prepare(`SELECT count(*) n FROM ${tabela}`).get().n;
  const check = (nome, condicao) => { assert.ok(condicao, nome); console.log(`ok — ${nome}`); };
  try {
    await new Promise(r => wc.once('did-finish-load', r));
    await ate(`document.querySelector('#hdr-versao').textContent.includes('DEMONSTRAÇÃO')`);
    const produtoId = await chamar('produtos', 'criar', { nome: 'Produto fictício de teste', precoCentavos: 1000, codigos: ['TESTE-FIADO'] });
    await chamar('estoque','entrada',{ produtoId, qtdMilesimal: 20000, motivo: 'Estoque fictício de teste' });
    await clicar('[data-tab="clientes"]');
    await clicar('#fi-novo');
    await preencher('#fc-nome','Cliente fictício de teste');
    await preencher('#fc-telefone','11987650000');
    await clicar('#fc-salvar');
    await ate(`Boolean(document.querySelector('[data-cliente]'))`);
    const clienteId = db.prepare('SELECT id FROM clientes').get().id;
    check('cadastro pela interface', contar('clientes') === 1);

    const bipar = async () => {
      await clicar('[data-tab="vender"]');
      await preencher('#scan-input','TESTE-FIADO');
      await exec(`document.querySelector('#scan-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
      await ate(`document.querySelector('#cart-total').textContent.includes('10,00')`);
      await clicar('#btn-finalizar');
      await ate(`Boolean(document.querySelector('[data-forma="pix"]'))`);
    };
    await bipar();
    await clicar('[data-forma="pix"]');
    await clicar('#modal [data-r="1"]');
    await ate(`document.querySelector('#cart-total').textContent.replace(/[^0-9]/g,'') === '000' && !document.querySelector('#modal-fundo').classList.contains('show')`);
    check('venda normal PIX continua funcionando', contar('vendas') === 1 && contar('contas_receber') === 0);
    await bipar();
    await clicar('[data-forma="fiado"]');
    await clicar('#modal [data-r="1"]');
    await ate(`Boolean(document.querySelector('#vf-cliente'))`);
    check('botão de cadastro rápido aparece no cabeçalho',await exec(`Boolean(document.querySelector('.vf-cabecalho #vf-abrir-cadastro')) && !document.querySelector('#vf-abrir-cadastro').hidden`));
    await preencher('#vf-busca','CLIENTE FICTICIO');
    await ate(`document.querySelectorAll('[data-vf-cliente]').length===1 && !document.querySelector('#vf-resultados').hidden`);
    check('busca mostra clientes por nome parcial sem acento',await exec(`document.querySelector('#vf-resultados').textContent.includes('Cliente fictício de teste')`));
    await exec(`document.querySelector('#vf-busca').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));document.querySelector('#vf-busca').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    check('seleção do cliente pelas setas e Enter',await exec(`document.querySelector('#vf-cliente').value===${JSON.stringify(String(clienteId))} && document.querySelector('#vf-resultados').hidden`));
    await preencher('#vf-busca','8765');
    await ate(`document.querySelectorAll('[data-vf-cliente]').length===1 && !document.querySelector('#vf-resultados').hidden`);
    await clicar('[data-vf-cliente]');
    check('busca por telefone e seleção com clique',await exec(`document.querySelector('#vf-busca-msg').textContent.includes('Cliente selecionado')`));
    await preencher('#vf-busca','NOME FICTICIO INEXISTENTE');
    await ate(`document.querySelector('#vf-busca-msg').textContent.includes('Nenhum cliente encontrado')`);
    check('busca sem resultados orienta cadastrar sem criar clientes',contar('clientes')===1);
    await clicar('#vf-abrir-cadastro');
    check('botão destacado abre o formulário de cadastro rápido',await exec(`!document.querySelector('#vf-cadastro-rapido').hidden`));
    await preencher('#vf-nome',' CLIENTE  FICTICIO DE TESTE ');
    await clicar('#vf-cadastrar');
    await ate(`document.querySelector('#vf-cadastro-msg').textContent.includes('sobrenome')`);
    check('cadastro rápido recusa nome já existente',contar('clientes') === 1);
    await preencher('#vf-nome','Cliente fictício de teste Silva');
    await exec(`document.querySelector('#vf-cadastrar').click(); document.querySelector('#vf-cadastrar').click()`);
    await ate(`document.querySelector('#vf-cadastro-msg').textContent.includes('cadastrado e selecionado')`);
    await clicar('#vf-cadastrar');
    check('cadastro rápido continua bloqueado após salvar e mostra confirmação',contar('clientes') === 2 && await exec(`document.querySelector('#vf-cadastrar').disabled && document.querySelector('#vf-cadastro-rapido').hidden`));
    check('cliente recém-cadastrado foi selecionado',await exec(`document.querySelector('#vf-cliente').selectedOptions[0].textContent.includes('Silva')`));
    await preencher('#vf-busca','CLIENTE FICTICIO DE TESTE');
    await ate(`Boolean(document.querySelector('[data-vf-cliente="${clienteId}"]'))`);
    await clicar(`[data-vf-cliente="${clienteId}"]`);
    await clicar('#vf-confirmar');
    await ate(`document.querySelector('#cart-total').textContent.replace(/[^0-9]/g,'') === '000' && !document.querySelector('#modal-fundo').classList.contains('show')`);
    const conta = db.prepare('SELECT * FROM contas_receber').get();
    check('venda fiada cria conta sem vencimento obrigatório', conta.valor_centavos === 1000 && conta.vencimento === null);
    check('fiado não é entrada de dinheiro', contar('caixa_movimentos') === 0);
    check('duas vendas baixam estoque uma vez cada', db.prepare('SELECT estoque_milesimal n FROM produtos WHERE id=?').get(produtoId).n === 18000);
    await clicar('[data-tab="clientes"]');
    await clicar(`[data-cliente="${clienteId}"]`);
    await ate(`Boolean(document.querySelector('[data-receber]'))`);
    await clicar('[data-receber]');
    await ate(`document.querySelector('#toast').textContent.includes('Abra a sessão')`);
    check('recebimento exige sessão aberta', contar('contas_receber_pagamentos') === 0);
    await clicar('#fi-abrir-caixa');
    await ate(`Boolean(document.querySelector('#fi-fechar-caixa'))`);
    const sessaoId = db.prepare("SELECT id FROM caixa_sessoes WHERE status='aberta'").get().id;
    await clicar('[data-receber]');
    await ate(`Boolean(document.querySelector('#fr-valor'))`);
    await preencher('#fr-valor','3,00');
    await preencher('#fr-forma','pix');
    await exec(`document.querySelector('#fr-confirmar').click(); document.querySelector('#fr-confirmar')?.click()`);
    await ate(`!document.querySelector('#modal-fundo').classList.contains('show') && document.querySelector('#fi-detalhe').textContent.includes('7,00')`);
    check('duplo clique recebe uma única vez', contar('contas_receber_pagamentos') === 1 && contar('caixa_movimentos') === 1);
    check('saldo parcial correto na interface', db.prepare('SELECT valor_pago_centavos n FROM contas_receber').get().n === 300);
    if (process.env.PDV_CAPTURA_FIADO) fs.writeFileSync(process.env.PDV_CAPTURA_FIADO, (await wc.capturePage()).toPNG());

    // Simula queda depois do commit e antes de limpar a confirmação local.
    const p = db.prepare('SELECT operacao_id FROM contas_receber_pagamentos').get();
    const pendente = { operacaoId: p.operacao_id, contaId: conta.id, sessaoId, valorCentavos: 300, forma: 'pix', recebidoCentavos: null };
    await exec(`localStorage.setItem('fiado-recebimento-pendente-v1',${JSON.stringify(JSON.stringify(pendente))})`);
    const recarregado = new Promise(r => wc.once('did-finish-load',r));
    wc.reload();
    await recarregado;
    await ate(`Boolean(document.querySelector('#fi-novo'))`);
    await clicar('[data-tab="clientes"]');
    await ate(`localStorage.getItem('fiado-recebimento-pendente-v1') === null`);
    check('reinício confirma operação anterior sem duplicar', contar('contas_receber_pagamentos') === 1);
    await clicar(`[data-cliente="${clienteId}"]`);
    await ate(`Boolean(document.querySelector('[data-receber]'))`);
    await clicar('[data-receber]');
    await ate(`Boolean(document.querySelector('#fr-valor'))`);
    await preencher('#fr-recebido','10,00');
    await clicar('#fr-confirmar');
    await ate(`!document.querySelector('#modal-fundo').classList.contains('show') && document.querySelector('#fi-detalhe').textContent.includes('Quitada')`);
    check('quitação preserva histórico e dá troco', db.prepare('SELECT SUM(troco_centavos) n FROM contas_receber_pagamentos').get().n === 300);
    check('recebimentos não movimentam estoque', db.prepare('SELECT estoque_milesimal n FROM produtos WHERE id=?').get(produtoId).n === 18000);
    const cancelamento = await exec(`window.pdv.vendas.cancelar({vendaId:${conta.venda_id},motivo:'Teste fictício'})`);
    check('cancelamento após pagamento é bloqueado', !cancelamento.ok && cancelamento.codigo === 'CONTA_COM_PAGAMENTO');
    await clicar('[data-tab="relatorios"]');
    await ate(`document.querySelector('#rel-fiado').textContent.includes('Recebido de fiado')`);
    check('relatório distingue recebimento de faturamento', db.prepare('SELECT SUM(valor_centavos) n FROM caixa_movimentos').get().n === 1000 && contar('vendas') === 2);

    // Duas novas compras fictícias: recebe 25 de um saldo total de 30.
    for(const qtd of [2000,1000]) await chamar('vendas','finalizar',{
      operacaoId:randomUUID(),clienteId,itens:[{produtoId,qtdMilesimal:qtd}],pagamentos:[{forma:'fiado',valorCentavos:qtd}]
    });
    const estoqueAntesTotal=db.prepare('SELECT estoque_milesimal n FROM produtos WHERE id=?').get(produtoId).n;
    await clicar('[data-tab="clientes"]');
    await clicar(`[data-cliente="${clienteId}"]`);
    await ate(`document.querySelector('#fi-detalhe h2').textContent.includes('30,00')`);
    check('histórico mostra produtos e quantidades de cada compra',await exec(`document.querySelectorAll('#fi-historico-produtos details').length===3 && document.querySelector('#fi-historico-produtos').textContent.includes('Produto fictício de teste')`));
    await clicar('#fi-receber-total');
    await ate(`Boolean(document.querySelector('#fr-valor'))`);
    await preencher('#fr-valor','25,00');
    await preencher('#fr-forma','pix');
    check('prévia mostra distribuição entre compras e saldo restante',await exec(`document.querySelector('#fr-distribuicao').textContent.includes('20,00') && document.querySelector('#fr-distribuicao').textContent.includes('5,00')`));
    await exec(`document.querySelector('#fr-confirmar').click();document.querySelector('#fr-confirmar')?.click()`);
    await ate(`!document.querySelector('#modal-fundo').classList.contains('show') && document.querySelector('#fi-detalhe h2').textContent.includes('5,00')`);
    check('recebimento único abate 25 entre duas contas',contar('recebimentos_fiado')===1 && db.prepare('SELECT SUM(valor_pago_centavos) n FROM contas_receber').get().n===3500);
    check('histórico agrupa o montante recebido sem duplicar',await exec(`document.querySelectorAll('#fi-historico-pagamentos tbody tr').length===3`));
    check('recebimento do saldo total não movimenta estoque',db.prepare('SELECT estoque_milesimal n FROM produtos WHERE id=?').get(produtoId).n===estoqueAntesTotal);
    const grupo=db.prepare('SELECT * FROM recebimentos_fiado').get();
    const rateioEsperado=db.prepare('SELECT conta_id contaId,valor_centavos valorCentavos FROM contas_receber_pagamentos WHERE recebimento_grupo_id=? ORDER BY id').all(grupo.id);
    const conjuntoPendente={operacaoId:grupo.operacao_id,clienteId,rateioEsperado,sessaoId,valorCentavos:2500,forma:'pix',recebidoCentavos:null};
    await exec(`localStorage.setItem('fiado-recebimento-pendente-v1',${JSON.stringify(JSON.stringify(conjuntoPendente))})`);
    const recarregadoTotal=new Promise(r=>wc.once('did-finish-load',r));wc.reload();await recarregadoTotal;
    await clicar('[data-tab="clientes"]');
    await ate(`localStorage.getItem('fiado-recebimento-pendente-v1')===null`);
    check('reinício não duplica pagamento distribuído entre compras',contar('recebimentos_fiado')===1 && db.prepare('SELECT SUM(valor_centavos) n FROM caixa_movimentos').get().n===3500);
    check('nenhum erro de JavaScript na tela', erros.length === 0);
  } catch (e) { codigo = 1; console.error(e.stack); }
  clearTimeout(limite);
  fecharBanco();
  // Mantém a pasta de teste descartável para diagnóstico; nunca usa dados da loja.
  console.log(`Interface: ${codigo === 0 ? 'APROVADA' : 'FALHOU'}`);
  app.exit(codigo);
}).catch(e => { console.error(e); app.exit(1); });
