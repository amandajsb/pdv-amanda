# PDV-Amanda

Sistema de ponto de venda para loja de bairro: registro de itens por leitor de
código de barras, controle de estoque, comprovante de venda e relatórios.
Aplicativo desktop (Electron + SQLite), roda offline, dados na própria máquina.

**O comprovante emitido é não-fiscal.** Não substitui NFC-e. Ver
[docs/manual-do-usuario.md](docs/manual-do-usuario.md).

## Instalar (loja)

Guia para quem vai usar, não para quem desenvolve:
**[docs/instalar.md](docs/instalar.md)**. O instalador fica nas
[Releases](https://github.com/Gor0d/pdv-amanda/releases).

## Rodar (desenvolvimento)

```bash
npm install
npm run dev      # com devtools e menu
npm start        # como a loja usa
npm test         # testes unitários
npm run smoke    # sobe o app e opera a tela de ponta a ponta
npm run dist     # gera o instalador .exe em dist/
```

## Decisões que não são óbvias

**Dinheiro só em centavos (`INTEGER`).** Nenhum float encosta em valor
monetário. `parseFloat` existe em um único lugar: `paraCentavos()` em
[src/compartilhado/formato/moeda.js](src/compartilhado/formato/moeda.js).
Quantidade segue a mesma regra em milésimos (×1000), para suportar 0,350 kg.

**O banco é a verdade.** O renderer exibe totais; o main recalcula tudo dentro
da transação e grava o resultado dele. O total vindo da tela é conferido e
logado se divergir, nunca gravado.

**Nada é apagado.** Venda cancelada vira `status='cancelada'`; estoque tem
ledger append-only (`estoque_movimentos`) e `produtos.estoque_milesimal` é só
cache reconstruível; produto é inativado, não excluído.

**Testes rodam dentro do Electron.** `better-sqlite3` traz binário N-API que o
Node instalado na máquina não carrega (derruba o processo). `npm test` usa
[testes/rodar.js](testes/rodar.js), que relança a suíte com
`ELECTRON_RUN_AS_NODE=1` — mesmo runtime do app em produção.

**Sem `postinstall`.** `electron-builder install-app-deps` exigiria Visual
Studio Build Tools e quebraria o `npm install` em máquina limpa. Como o
`better-sqlite3` 13 publica prebuilds por plataforma, ele não é necessário.

**Protocolo `app://` em vez de `loadFile`.** `file://` faz o Chromium bloquear
`<script type="module">` por CORS. O protocolo próprio resolve isso e ainda
permite CSP estrita (`default-src 'self'`) — nenhuma requisição externa.

**CSP estrita proíbe `style=""`.** Por isso os ajustes pontuais de layout são
classes utilitárias no fim de
[src/renderer/css/base.css](src/renderer/css/base.css), não estilo inline.

**`import electron from 'electron'`, nunca named import.** O módulo é um
builtin injetado no runtime; o loader ESM não consegue extrair exports
nomeados dele.

**Sem framework e sem bundler.** Um PDV tem uma tela quente (Vender) e várias
frias. Cada tela é um módulo com `montar/aoEntrar`, e o `#scan-input` mora no
shell — nunca é destruído por re-render, senão o foco se perde no meio da venda.

## Estrutura

```
src/main/          processo principal: banco, IPC, serviços — só ele fala com o SQLite
src/preload/       preload.cjs — único CommonJS; define o contrato inteiro main↔tela
src/renderer/      telas (vanilla JS + módulos ES nativos)
src/compartilhado/ ESM puro, zero dependências, usado pelos dois lados
legado/pdv.html    protótipo original corrigido; gera o JSON de importação
testes/            unidade (node:test) + e2e/fumaca.js
```

## Estado atual

Entregue: cadastro de produtos com múltiplos códigos de barras, bipagem com
normalização UPC-A/EAN-13, venda com baixa de estoque em transação atômica,
cancelamento com reversão, relatórios em SQL, importação do sistema anterior,
backup e diagnóstico.

Vendas aceitam dinheiro, PIX, débito, crédito ou fiado integral, com troco e
ajustes de valor. A busca lista produtos pelas primeiras letras do nome.

O controle de fiado inclui cadastro e busca de clientes, bloqueio de nomes
repetidos, vencimento opcional, recebimentos parciais ou totais por conta ou
pelo saldo do cliente, distribuição entre compras e histórico dos produtos.
Recebimentos não movimentam estoque; cancelamento após recebimentos é bloqueado.
Detalhes e limites em **[docs/controle-fiado.md](docs/controle-fiado.md)**.

A sessão de caixa disponível controla recebimentos de fiado. O fechamento
completo das vendas normais e a impressão do comprovante continuam pendentes.

O que vem a seguir, em ordem, está em
**[docs/proximos-passos.md](docs/proximos-passos.md)**.
