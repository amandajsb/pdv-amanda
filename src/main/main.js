import electron from 'electron'; // ver comentário em util/caminhos.js
import log from 'electron-log/main.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { app, dialog } = electron;
import { abrirBanco, fecharBanco } from './db/conexao.js';
import { registrarIpc } from './ipc/registrarIpc.js';
import { registrarEsquemaPrivilegiado, registrarProtocolo, criarJanela } from './janela.js';
import { caminhoBanco } from './util/caminhos.js';
import { verificarValidadesProximas } from './servicos/notificacaoServico.js';
import { prepararDemonstracao } from './servicos/demonstracaoServico.js';

// Enquanto o app fica aberto o dia inteiro no balcão, confere de novo a cada
// tanto tempo — o serviço já se protege pra avisar no máximo uma vez por dia.
const INTERVALO_AVISO_VALIDADE_MS = 6 * 60 * 60 * 1000;

const dev = process.argv.includes('--dev');
const pacote = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
const demonstracao = process.argv.includes('--fiado-demo') || pacote.pdvDemonstracao === true;
if (demonstracao) {
  if (!process.argv.includes('--fiado-demo')) process.argv.push('--fiado-demo');
  const pasta = path.join(os.tmpdir(), 'pdv-amanda-demonstracao-fiado');
  fs.mkdirSync(pasta, { recursive: true });
  app.setPath('userData', pasta);
}

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = dev ? 'debug' : 'warn';

app.setAppUserModelId(demonstracao ? 'com.pdvamanda.fiado.demonstracao' : 'com.pdvamanda.app');

// Duas instâncias no mesmo SQLite é risco desnecessário — a segunda apenas
// traz a janela existente para a frente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let janela = null;

  app.on('second-instance', () => {
    if (janela) {
      if (janela.isMinimized()) janela.restore();
      janela.focus();
    }
  });

  // Obrigatoriamente antes do whenReady().
  registrarEsquemaPrivilegiado();

  app.whenReady().then(() => {
    try {
      abrirBanco(caminhoBanco(), { log });
      if (demonstracao) prepararDemonstracao();
    } catch (e) {
      log.error('Falha ao abrir o banco', e);
      dialog.showErrorBox(
        'Não foi possível abrir os dados',
        'O arquivo de dados do sistema não pôde ser aberto.\n\n' +
          `Detalhe técnico: ${e.message}\n\n` +
          'Nada foi alterado. Feche o programa e chame o suporte.'
      );
      app.quit();
      return;
    }

    registrarProtocolo({ log });
    registrarIpc({ log });
    janela = criarJanela({ dev, log });
    if (demonstracao) janela.setTitle('PDV Amanda — DEMONSTRAÇÃO — dados fictícios');

    verificarValidadesProximas({ log });
    setInterval(() => verificarValidadesProximas({ log }), INTERVALO_AVISO_VALIDADE_MS);
  });

  app.on('window-all-closed', () => {
    fecharBanco();
    app.quit();
  });

  process.on('uncaughtException', (e) => log.error('Exceção não tratada', e));
}
