import test from 'node:test';
import assert from 'node:assert/strict';
import { bancoLimpo, criarProduto } from './ajuda.js';
import * as produtos from '../../src/main/repos/produtosRepo.js';

test('busca por início e parte do nome ignora maiúsculas e acentos', () => {
  bancoLimpo();
  const a = criarProduto({nome:'Açúcar cristal fictício'});
  criarProduto({nome:'Arroz branco fictício'});
  for (const termo of ['açu','ACU','acucar','CRISTAL']) assert.deepEqual(produtos.listar({termo}).map(p=>p.id),[a]);
});

test('sugestões incluem códigos e SKU e excluem produtos inativos', () => {
  bancoLimpo();
  const a = criarProduto({nome:'Arroz branco fictício',codigo:'DEMO-TESTE'});
  const b = criarProduto({nome:'Arroz antigo fictício'});
  produtos.inativar(b);
  assert.deepEqual(produtos.listar({termo:'arr'}).map(p=>p.id),[a]);
  assert.deepEqual(produtos.listar({termo:'demo'}).map(p=>p.id),[a]);
  const c = produtos.criar({nome:'Produto por SKU fictício',precoCentavos:100,sku:'SKU-FICTICIO'});
  assert.deepEqual(produtos.listar({termo:'sku-fic'}).map(p=>p.id),[c]);
});

test('busca não interpreta caracteres digitados como curingas SQL', () => {
  bancoLimpo();
  const a = criarProduto({nome:'Produto 100% fictício'});
  criarProduto({nome:'Produto 1000 fictício'});
  assert.deepEqual(produtos.listar({termo:'100%'}).map(p=>p.id),[a]);
  assert.deepEqual(produtos.listar({termo:'%_'}),[]);
});
