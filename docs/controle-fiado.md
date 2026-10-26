# Controle de Fiado

Implementado offline com SQLite, na branch `feature/controle-fiado`.
O desenvolvimento inicial usou um repositório local sem histórico, inicializado
com autorização. A publicação no GitHub parte da `main` do repositório original
e preserva esse histórico, sem alterar a `main`.

## Como usar

1. Em **Clientes / Fiado**, cadastre o cliente. Somente nome é obrigatório.
2. Em **Vender**, finalize escolhendo **Fiado**. Selecione um cliente ativo e,
   se necessário, informe o vencimento. Também há cadastro rápido nesse momento.
   Digite o início do nome ou telefone para ver uma lista de clientes e escolha
   com clique ou com setas e Enter. O botão **+ Cadastrar cliente rápido** fica
   no cabeçalho e abre o formulário sem sair da venda.
3. Na aba **Clientes / Fiado**, abra uma sessão de recebimentos com o nome do operador.
4. Selecione o cliente e clique em **Receber** na conta desejada. Informe um
   valor parcial ou o saldo total, a forma e, em dinheiro, o valor entregue.
   Para pagar várias compras com um único valor, use **Receber do saldo total**.
   A prévia mostra a distribuição, começando pelas compras mais antigas.
   Exemplo: R$ 20,00 + R$ 10,00, recebendo R$ 25,00, deixa R$ 5,00 em aberto.
5. Consulte saldo, compras, pagamentos, cancelamentos e totais da sessão.
   Os relatórios separam fiado vendido e recebimentos pela data efetiva.
   Em **Histórico de compras e produtos**, abra a compra para ver produtos,
   quantidades e preços da época, incluindo compras canceladas identificadas.

## Regras

- Fiado é conta a receber. A confirmação não gera entrada em `caixa_movimentos`.
- O registro `pagamentos.forma='fiado'` identifica a composição da venda;
  não representa dinheiro recebido. Recebimentos posteriores usam outra tabela.
- Estoque baixa na venda e não se altera em recebimentos.
- Venda, conta e estoque são gravados em uma transação. Recebimento, saldo e
  lançamento de caixa também são uma transação.
- Identificadores de operação impedem repetir venda/recebimento por reenvio.
  A tela conserva o pedido pendente para repetir a mesma operação após falha.
- Sem vencimento, a conta não é considerada atrasada. A data não é preenchida
  automaticamente pela configuração antiga de prazo padrão.
- Inativação preserva histórico e permite cobrar dívidas existentes, mas impede novo fiado.
- Não há limite de crédito. A coluna antiga é preservada e ignorada.
- Nomes repetidos são bloqueados no cadastro e na edição, inclusive clientes
  inativos, ignorando diferenças de maiúsculas, acentos e espaços. Acrescente
  um sobrenome para distinguir outra pessoa. O cadastro rápido confirma o
  salvamento, seleciona o cliente e bloqueia novos cliques para o mesmo nome.
  A migração 008 preserva cadastros antigos duplicados e seus históricos;
  nenhuma exclusão ou unificação é automática.
- Cancelamento sem recebimentos preserva venda e conta, exige motivo, registra
  operador/data e devolve estoque uma vez. Após qualquer recebimento, o
  cancelamento fica bloqueado: devolução auditada será uma etapa própria.
- Alterações de itens de venda fiada ficam bloqueadas no serviço e na tela.
  Para compras adicionais, registre uma nova venda.

## Limites desta entrega

Fiado integral, um cliente e uma conta por venda; recebimento por conta ou pelo saldo do cliente.
Pagamento misto, devoluções de recebimentos, cancelamento de vendas já pagas,
fiado em comandas, recibo impresso e atalho F6 não foram incluídos.

A migração 009 adiciona um cabeçalho para cada recebimento conjunto, ligado
às parcelas aplicadas em cada conta. Todo o conjunto é gravado em uma transação,
com proteção contra reenvio, troco único e preservação dos recebimentos antigos.

A sessão disponível nesta entrega controla **recebimentos de fiado**.
O fechamento completo das vendas normais continua sendo uma funcionalidade
separada. Não há conciliação física, fundo de troco, sangria ou suprimento nessa tela.

## Banco e compatibilidade

A migração `007_controle_fiado.sql` acrescenta identificadores, auditoria,
índices e vínculo único entre recebimento e caixa, sem reescrever migrações
anteriores ou apagar dados. Duplicidades anteriores de conta por venda fazem
a migração falhar em transação, preservando a versão anterior para conferência.

Nenhum dado real ou banco da loja foi usado no desenvolvimento.

## Validação

- `npm test`: testes unitários, banco em memória, compatibilidade e migração.
- `npm run smoke:fiado`: fluxo real tela → IPC → SQLite, com dados fictícios e
  pasta temporária, incluindo repetição e recuperação após recarregar a tela.
- As dependências nativas devem ser testadas sob o runtime do Electron.

## Executável de demonstração

`npm run demo:build` gera `dist-fiado-demo/win-unpacked/PDV Amanda - Demonstracao Fiado.exe`.
Mantenha toda a pasta `win-unpacked` junta; o executável depende dos arquivos ao lado.
Não é um instalador e não substitui o programa instalado.

Essa configuração grava `pdvDemonstracao: true` no pacote. Mesmo ao abrir pelo
Explorer, o executável usa `%TEMP%/pdv-amanda-demonstracao-fiado` e isola também
backups e arquivos auxiliares. A tela mostra **DEMONSTRAÇÃO · dados fictícios**.
Na primeira execução cria somente um cliente e um produto artificiais, uma
venda fiada de R$ 30,00 e um recebimento de R$ 10,00, deixando R$ 20,00 em aberto.

O banco de demonstração permanece nessa pasta para você continuar os testes.
O código é publicado somente na branch de desenvolvimento. Não há deploy nem PR nesta entrega.
