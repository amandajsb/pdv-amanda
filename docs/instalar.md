# Como instalar o Sistema de Vendas

Leva uns 2 minutos. Não precisa de senha de administrador.

---

## 1. Baixar

Use o arquivo **`Sistema de Vendas 0.2.0 - instalador.exe`**.

Esta é a versão de uso normal, com todas as melhorias do controle de fiado.
Não é a demonstração e não inclui clientes, produtos ou bancos de teste.

Se já usa o programa instalado, antes de atualizar faça **Ajustes → Fazer
backup agora** e feche o programa. Instale por cima da versão anterior, usando
o mesmo usuário do Windows. Na primeira abertura, as migrações atualizam a
estrutura do banco existente, preservando os registros. Os dados dos testes
na demonstração ficam separados e não são importados para a loja.

Ele tem cerca de 107 MB. Se o navegador perguntar se quer mesmo manter o
arquivo, responda que sim — ele avisa isso para qualquer programa baixado.

## 2. O Windows vai reclamar — e está tudo bem

Ao abrir o instalador, aparece uma tela azul dizendo
**"O Windows protegeu o seu PC"**.

Isso **não** quer dizer que tem vírus. Quer dizer que o programa ainda não tem
um certificado digital pago, que custa caro e só faz sentido quando o sistema
estiver rodando em várias lojas. Todo programa novo de desenvolvedor pequeno
mostra esse aviso.

Para continuar:

1. Clique em **Mais informações** (o texto pequeno, embaixo da mensagem).
2. Clique em **Executar assim mesmo**.

## 3. Instalar

O instalador é em português e pergunta duas coisas:

- **Onde instalar** — pode deixar como está.
- **Para quem** — instala só para o seu usuário, sem pedir senha de
  administrador.

No fim, ele cria um atalho **na área de trabalho** e no **menu Iniciar**, com
o ícone de cupom verde.

## 4. Trazer seus produtos e vendas

Se você já usava o sistema antigo:

1. Abra o sistema antigo, vá na aba **Relatórios** e clique em
   **Exportar dados (JSON)**. Guarde o arquivo que ele baixar.
2. No sistema novo, vá em **Ajustes → Trazer dados do sistema anterior** e
   escolha esse arquivo.
3. Ele mostra quantos produtos e quantas vendas trouxe.

Pode clicar sem medo: importar o mesmo arquivo duas vezes não duplica nada.

## 5. Testar

Sugestão de roteiro para o primeiro dia:

- [ ] Bipar um produto e ver se ele aparece no cupom da tela.
- [ ] Bipar um produto que **não** está cadastrado e usar o cadastro rápido.
- [ ] Fazer uma venda de verdade e conferir se o estoque baixou
      (aba **Estoque**).
- [ ] Cancelar uma venda na aba **Relatórios** e conferir se o produto voltou
      para o estoque.
- [ ] No fim do dia, comparar o **Total vendido** da aba Relatórios com o
      total do sistema antigo. **Os dois têm que bater.**
- [ ] Ir em **Ajustes → Fazer backup agora**.

---

## Funcionalidades disponíveis e limites

Para você saber o que esperar nesta versão:

- **Não imprime o comprovante ainda.** A venda é registrada, mas o cupom em
  papel vem na próxima entrega.
- As vendas aceitam dinheiro, PIX, débito, crédito ou fiado integral.
  Dinheiro tem cálculo de troco.
- O fiado inclui cadastro e busca de clientes, vencimento opcional,
  recebimentos parciais ou totais, distribuição entre compras e histórico dos produtos.
- **O fechamento completo das vendas normais ainda não está disponível.**
  A sessão disponível controla somente recebimentos de fiado.
- **O comprovante é não-fiscal.** Não substitui nota fiscal — veja o
  [manual](manual-do-usuario.md).

## Se algo der errado

Vá em **Ajustes**, role até o fim e anote a **versão do sistema** e o
**caminho do arquivo de dados**. Anote também o horário em que o problema
aconteceu e o que você estava fazendo. Isso é o suficiente para investigar.

Seus dados ficam guardados mesmo que o programa seja desinstalado.
