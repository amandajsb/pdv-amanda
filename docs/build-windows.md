# Gerar o instalador no Windows

```bash
npm run dist
```

Saída: `dist/Sistema de Vendas <versão> - instalador.exe` (NSIS, ~106 MB).

A versão atual é **0.2.0**. Esta configuração gera o instalador de uso normal,
com a identidade original do aplicativo e `pdvDemonstracao: false`.
Não execute o instalador durante a validação para evitar abrir o banco da loja.
Confira o conteúdo sem instalar:

```bash
node testes/verificarInstalador.cjs
```

A configuração `electron-builder-fiado-demo.yml` continua separada e serve
somente para demonstrações com dados fictícios. Mudanças de código ficam na
branch `feature/controle-fiado`; para atualizar o aplicativo instalado é preciso
gerar e instalar uma nova versão.

## Duas pedras no caminho, já contornadas

### 1. `node-gyp failed to rebuild better-sqlite3`

O `electron-builder` tenta recompilar dependências nativas antes de empacotar,
e isso exigiria Visual Studio Build Tools instalado.

Não é necessário: o `better-sqlite3` 13 publica prebuilds N-API por plataforma
(`node_modules/better-sqlite3/prebuilds/win32-x64.node`), que servem tanto para
o Electron quanto para o app empacotado. Por isso o `electron-builder.yml` tem
`npmRebuild: false` — e por isso o `package.json` **não** tem o
`postinstall: electron-builder install-app-deps` que normalmente se recomenda.

### 2. `Cannot create symbolic link ... winCodeSign`

O `electron-builder` baixa o pacote `winCodeSign` (que traz o `rcedit`, usado
para embutir ícone e metadados no `.exe`). Esse pacote contém symlinks de
macOS, e criar symlink no Windows exige privilégio que uma conta comum não
tem. A extração falha, o `electron-builder` a considera perdida e tenta de
novo num diretório temporário novo — em loop, sem nunca gerar o instalador.

**Contorno: pré-extrair o pacote no cache, pulando a pasta `darwin`.**
Ela só interessa a quem compila para macOS.

```bash
C="$LOCALAPPDATA/electron-builder/Cache/winCodeSign"
Z="node_modules/7zip-bin/win/x64/7za.exe"

# Um dos .7z já baixados serve — todos têm o mesmo conteúdo.
"$Z" x "$C/<qualquer>.7z" "-o$C/winCodeSign-2.6.0" -xr'!'darwin -y
```

O nome do diretório importa: o cache segue a convenção
`Cache/<ferramenta>/<nome>-<versão>` (dá para conferir olhando o
`Cache/nsis/`, que extrai sem problema). Com o diretório no lugar, o
`electron-builder` o encontra e nem tenta baixar.

Depois disso o `npm run dist` roda normal, com ícone e metadados de versão no
executável.

**Alternativa permanente:** ligar o **Modo de Desenvolvedor** do Windows
(Configurações → Sistema → Para desenvolvedores), que concede o privilégio de
symlink e dispensa o contorno acima.

Se um dia precisar sair pelo caminho mais curto, `win.signAndEditExecutable:
false` faz o build passar sem nenhuma das duas coisas — ao custo de o `.exe`
sair **sem ícone e sem metadados de versão**.

## SmartScreen

O instalador não é assinado digitalmente, então o Windows mostra
*"O Windows protegeu o seu PC"*. Para instalar: **Mais informações →
Executar assim mesmo**.

Enquanto for uma loja só, instalar presencialmente resolve. Quando houver
atualização automática, vale contratar assinatura de código — a opção mais
barata hoje é o **Azure Trusted Signing** (~US$ 10/mês, suportado pelo
`electron-builder`, sem exigir token USB).

## O que o instalador faz

- Instala por usuário (`perMachine: false`), sem exigir administrador.
- Deixa o usuário escolher a pasta.
- Cria atalho na área de trabalho e no menu Iniciar.
- **Não apaga os dados ao desinstalar** (`deleteAppDataOnUninstall: false`).
  O banco fica em `%APPDATA%\pdv-amanda\pdv.db` e sobrevive a
  desinstalação e reinstalação.
