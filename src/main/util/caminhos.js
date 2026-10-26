import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// O módulo 'electron' é um builtin injetado no runtime, não um arquivo CJS
// comum: o loader ESM não consegue extrair exports nomeados dele. Por isso
// todo o main importa o default e desestrutura.
import electron from 'electron';
import * as configRepo from '../repos/configRepo.js';

const { app } = electron;
const CHAVE_PASTA_BACKUP_CUSTOM = 'backup_pasta_custom';

/** Banco de dados: %APPDATA%\pdv-amanda\pdv.db */
export function caminhoBanco() {
  return path.join(app.getPath('userData'), 'pdv.db');
}

/**
 * Pasta de trabalho visível para a dona da loja.
 * Se existir OneDrive, usamos ele: backup fora da máquina sem custo nenhum,
 * o que resolve metade do risco de perder tudo num HD que morreu.
 */
export function pastaPdv() {
  if (process.argv.includes('--fiado-demo')) return path.join(app.getPath('userData'), 'arquivos-demo');
  const oneDrive = process.env.OneDrive || path.join(os.homedir(), 'OneDrive');
  const base = fs.existsSync(oneDrive) ? oneDrive : app.getPath('documents');
  return path.join(base, 'PDV');
}

/**
 * Por padrão o backup cai dentro de pastaPdv() (OneDrive/Documentos,
 * automático). Quem preferir escolher a pasta na mão — outro HD, um pendrive,
 * uma pasta local sem nuvem — grava o caminho em config.backup_pasta_custom
 * (tela de Ajustes) e essa escolha passa a valer no lugar do automático.
 */
export function pastaBackups() {
  const custom = configRepo.obter(CHAVE_PASTA_BACKUP_CUSTOM, '');
  if (custom) return garantir(custom);
  return garantir(path.join(pastaPdv(), 'backups'));
}

export function pastaBackupPersonalizada() {
  return configRepo.obter(CHAVE_PASTA_BACKUP_CUSTOM, '') || null;
}

export function definirPastaBackupPersonalizada(caminho) {
  configRepo.definir(CHAVE_PASTA_BACKUP_CUSTOM, caminho || '');
}

export function pastaCupons(data = new Date()) {
  const mes = `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}`;
  return garantir(path.join(pastaPdv(), 'cupons', mes));
}

export function garantir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
