# Próximos passos

Estado atual: **Fase 1 entregue**. O app instala, bipa, vende, controla
estoque e mostra relatórios. Toda venda é gravada como **dinheiro pelo valor
exato** — é essa a limitação que as fases seguintes removem.

As tabelas de todas as fases abaixo **já existem** em `001_inicial.sql`. Isso
foi de propósito: nenhuma delas vai exigir migrar dados de produção depois.

---

## Antes de qualquer fase nova: rodar na loja

A Fase 1 só está validada em máquina de desenvolvimento. Antes de escrever
mais código:

- [ ] Instalar o `.exe` na máquina do caixa.
- [ ] Importar o JSON exportado pelo sistema antigo (Ajustes → Trazer dados).
- [ ] **Dia espelho:** operar um dia inteiro em paralelo com o sistema antigo
      e conferir se o total do dia bate nos dois.
- [ ] Confirmar que o leitor USB da loja funciona sem configuração (deve estar
      com sufixo CR, sem prefixo).

Isso é o que separa "passa nos testes" de "funciona no balcão".

---

## Fase 2 — Comprovante impresso

O que falta para o cliente sair com papel na mão.

- [ ] `src/compartilhado/cupom/montarCupom.js` — venda → documento abstrato de
      blocos. **Fonte única**: os três caminhos de saída consomem isso.
- [ ] `renderizarTexto(doc, colunas)` com 48 (80 mm) e 32 (58 mm). Concentra
      toda a quebra de linha — é o que garante que 58 mm não saia cortado.
- [ ] `renderizarHtml` + `cupom.css`.
- [ ] **Primeiro** os caminhos sem dependência nativa: PDF
      (`webContents.printToPDF`) e driver do Windows
      (`webContents.print({silent:true, deviceName})`).
- [ ] **Depois** ESC/POS (`iconv-lite` em CP850 para os acentos) com transporte
      TCP 9100 e UNC.
- [ ] Degradação automática: se todos falharem, gera o PDF, grava
      `impressoes.status='falha'` e mostra aviso **não bloqueante**.
      **A venda nunca é desfeita por erro de impressão.**
- [ ] Tela Ajustes → Impressora: lista de impressoras, largura, teste, e
      pré-visualização em texto monoespaçado.
- [ ] Reimpressão a partir da lista de vendas do dia.

*Pronto quando:* finalizar uma venda imprime na impressora real da loja por
pelo menos um caminho, e "Reimprimir" funciona.

**Testar sem impressora térmica:** subir um listener TCP em `127.0.0.1:9100`
que grava os bytes num arquivo — exercita o caminho real byte a byte. E
"Microsoft Print to PDF" como `deviceName` valida o caminho do driver.

---

## Fase 3 — Pagamentos, troco, descontos, cancelamento

- [ ] `telaPagamento.js`: teclado acumulando **em centavos** (digitar `1050`
      mostra R$ 10,50 — padrão de todo PDV), `1`=dinheiro `2`=PIX `3`=débito
      `4`=crédito.
- [ ] Split automático quando o valor digitado é menor que o restante
      ("Falta R$ X"). Troco em fonte grande — é o número que o caixa mais olha.
- [ ] Desconto por item (`F4`) e na venda (`F5`), em R$ e %.
      `ratearDesconto()` já está pronto e testado.
- [ ] Cancelamento pela tela de venda + cupom de cancelamento.
- [ ] Cupom passa a mostrar formas de pagamento e troco.

*Pronto quando:* venda com dinheiro + PIX, troco e 5% de desconto imprime
correto e pode ser cancelada com estoque revertido.

> `vendaServico.finalizar` já aceita múltiplos pagamentos e desconto de venda.
> Esta fase é quase toda tela.

---

## Fase 4 — Fechamento de caixa

- [ ] Abertura com fundo de troco; sangria e suprimento (`F10`).
- [ ] Bloquear venda sem caixa aberto (erro `CAIXA_FECHADO` já existe em
      `util/erros.js`, com CTA "Abrir caixa").
- [ ] Prévia e fechamento com conferência por forma de pagamento.
      O esperado em dinheiro sai direto do banco porque `valor_centavos` é
      gravado separado de `valor_recebido_centavos` — o troco já está fora.
- [ ] Barra de status passa a mostrar a sessão aberta e o saldo em dinheiro
      (hoje mostra "não controlado").
- [ ] Relatório de fechamento impresso.
- [ ] **Estorno:** cancelar venda de sessão já fechada lança os movimentos
      negativos na sessão **atual**, preservando o fechamento conferido.
      A coluna `cancelada_sessao_id` existe para isso.

*Pronto quando:* um dia inteiro de operação fecha com diferença R$ 0,00
conferida à mão.

---

## Fase 5 — Clientes e fiado

- [x] Cadastro, edição, inativação e busca de clientes por nome/telefone.
- [x] Fiado integral vinculado a cliente ativo → `contas_receber`, sem limite de crédito.
- [x] Tela Clientes / Fiado: contas, atraso, saldo por cliente e histórico.
- [x] Recebimento parcial/total por conta ou pelo saldo do cliente, com distribuição entre compras, sessão de recebimentos e proteção contra duplicidade.
- [x] Histórico de produtos por compra, preservando os preços e descrições da venda.
- [ ] Atalho `F6` e pagamento misto.
- [ ] Cupom de venda a prazo em 2 vias, com linha de assinatura e saldo devedor.

*Pronto quando:* vender fiado, receber parcialmente, ver o saldo correto e o
dinheiro aparecer no fechamento do caixa.

Implementação e limites desta entrega: [Controle de Fiado](controle-fiado.md).

---

## Fase 6 — Robustez

- [ ] **Backup automático** ao fechar o app e uma vez por dia (hoje só
      manual). `backupServico.js` já faz a cópia e a retenção de 30.
- [ ] Restauração de backup pela interface.
- [ ] Tela Diagnóstico separada dos Ajustes: abrir pasta de log, versão do
      esquema, conferência de estoque.
- [ ] Inventário e registro de perdas.
- [ ] Relatórios por período, ranking, margem (se o custo estiver cadastrado),
      exportação CSV.
- [ ] Usuários com PIN e permissões (cancelar venda, dar desconto acima de X%).
- [ ] Assinatura de código (Azure Trusted Signing, ~US$ 10/mês) +
      `electron-updater`.

*Pronto quando:* a dona da loja consegue restaurar um backup sozinha seguindo
o manual.

---

## Fase 7 — Não prometer prazo

Balança/PLU (o modelo já prevê `produto_codigos.tipo='BALANCA_PLU'`),
impressão de etiquetas, segundo caixa (exigiria servidor), e **NFC-e** — as
colunas `nfce_*` e os campos fiscais de produto já existem; entraria como um
serviço novo sem tocar em vendas nem em itens.

---

## Pendências pequenas, fora das fases

- [ ] **Ícone do app.** Colocar `recursos/icone.ico`, ligar o Modo de
      Desenvolvedor do Windows e remover `signAndEditExecutable: false` do
      `electron-builder.yml` — hoje o `.exe` sai sem ícone e sem metadados de
      versão. Ver [build-windows.md](build-windows.md).
- [ ] **Visibilidade do repositório.** Está público. Se não for a intenção:
      `gh repo edit Gor0d/pdv-amanda --visibility private`.
- [ ] **Nobreak.** Não é software, mas é a melhor relação custo/benefício do
      projeto inteiro: evita perder a venda em andamento na queda de luz.
      O rascunho de recuperação já existe, mas prevenir é melhor.
- [ ] **Impressora com Ethernet.** Se a loja ainda vai comprar, escolher uma
      com rede em vez de USB: o transporte TCP 9100 é o mais confiável dos três.
- [ ] `docs/checklist-aceite.md` — roteiro manual por fase, para rodar na
      máquina da loja antes de cada atualização.
