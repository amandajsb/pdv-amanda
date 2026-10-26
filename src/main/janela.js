import path from 'node:path';
import fs from 'node:fs/promises';
import electron from 'electron'; // ver comentário em util/caminhos.js
import { fileURLToPath } from 'node:url';

const { BrowserWindow, Menu, protocol, dialog } = electron;

const RAIZ_SRC = path.dirname(fileURLToPath(import.meta.url)).replace(/[\\/]main$/, '');
const RENDERER = path.join(RAIZ_SRC, 'renderer');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

/**
 * Precisa rodar ANTES de app.whenReady(). Sem `standard: true` o protocolo não
 * tem origem própria e módulos ES continuam bloqueados.
 */
export function registrarEsquemaPrivilegiado() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ]);
}

/**
 * Serve src/renderer e src/compartilhado por app://.
 *
 * Existe porque loadFile() serve por file://, e o Chromium bloqueia
 * <script type="module"> nessa origem por CORS — o app não abriria. De quebra,
 * uma origem real permite CSP estrita.
 */
export function registrarProtocolo({ log = console } = {}) {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    const relativo = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';

    // `compartilhado/` fica fora de renderer/ porque o main também o importa.
    const base = relativo.startsWith('compartilhado/') ? RAIZ_SRC : RENDERER;
    const destino = path.join(base, relativo);

    // Impede que um path traversal saia da pasta servida.
    if (!destino.startsWith(RAIZ_SRC)) return new Response('', { status: 403 });

    try {
      const conteudo = await fs.readFile(destino);
      return new Response(conteudo, {
        headers: { 'content-type': TIPOS[path.extname(destino)] || 'application/octet-stream' }
      });
    } catch {
      log.warn?.(`Recurso não encontrado: ${relativo}`);
      return new Response('Não encontrado', { status: 404 });
    }
  });
}

export function criarJanela({ dev = false, log = console, mostrar = true } = {}) {
  // Em produção não existe menu: F5 e Ctrl+R recarregariam o app e apagariam
  // a venda em andamento.
  if (!dev) Menu.setApplicationMenu(null);

  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#F4F2EA',
    title: 'Sistema de Vendas',
    webPreferences: {
      preload: path.join(RAIZ_SRC, 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  // F5 é atalho de desconto na venda; recarregar a janela por acidente custaria
  // o carrinho inteiro.
  win.webContents.on('before-input-event', (evento, input) => {
    if (dev) return;
    const k = String(input.key).toLowerCase();
    const recarga = k === 'f5' || (input.control && k === 'r');
    const devtools = (input.control && input.shift && k === 'i') || k === 'f12';
    if (recarga || devtools) evento.preventDefault();
  });

  // Erro na tela vira linha de log em arquivo. Sem isso, um defeito no
  // renderer some junto com o devtools fechado — e a loja fica sem diagnóstico.
  win.webContents.on('console-message', (evento) => {
    const { level, message, lineNumber, sourceId } = evento;
    if (level === 'error' || level === 'warning') {
      log.warn?.(`[tela] ${message} (${sourceId}:${lineNumber})`);
    } else if (dev) {
      log.debug?.(`[tela] ${message}`);
    }
  });

  win.webContents.on('render-process-gone', (_e, detalhe) => {
    log.error?.('A tela foi encerrada inesperadamente', detalhe);
  });

  win.once('ready-to-show', () => {
    if (!mostrar) return;
    win.maximize();
    win.show();
  });

  // Fechar sem querer (X, Alt+F4) no meio de uma venda é o pesadelo do balcão.
  // O carrinho já fica salvo como rascunho, mas confirmar custa um clique e
  // evita o susto.
  let fechamentoConfirmado = false;
  win.on('close', (evento) => {
    if (fechamentoConfirmado) return;
    evento.preventDefault();
    dialog
      .showMessageBox(win, {
        type: 'question',
        buttons: ['Cancelar', 'Fechar mesmo assim'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Fechar o sistema?',
        message: 'Tem certeza que deseja fechar o sistema de vendas?',
        detail: 'Uma venda em andamento fica salva e pode ser retomada na próxima vez que abrir o programa.'
      })
      .then(({ response }) => {
        if (response === 1) {
          fechamentoConfirmado = true;
          win.close();
        }
      });
  });

  win.loadURL('app://pdv/index.html');
  if (dev) win.webContents.openDevTools({ mode: 'detach' });

  return win;
}
