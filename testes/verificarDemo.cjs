// Verifica o pacote sem executar o aplicativo ou abrir qualquer banco.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const raiz = path.resolve(__dirname, '..');
const pacote = path.join(raiz, process.argv[2] || 'dist-fiado-demo', 'win-unpacked', 'resources', 'app.asar');
const metadata = JSON.parse(asar.extractFile(pacote, 'package.json').toString('utf8'));
assert.equal(metadata.pdvDemonstracao, true, 'O pacote deve obrigar o modo de demonstração.');
function verificar(dir) {
  for (const entrada of fs.readdirSync(path.join(raiz, dir), { withFileTypes: true })) {
    const relativo = path.join(dir, entrada.name);
    if (entrada.isDirectory()) verificar(relativo);
    else assert.deepEqual(asar.extractFile(pacote, relativo), fs.readFileSync(path.join(raiz, relativo)), `Código desatualizado no pacote: ${relativo}`);
  }
}
verificar('src');
assert.equal(asar.listPackage(pacote).some(nome => /\.(db|sqlite|sqlite3)(-|$)/i.test(nome)), false, 'O pacote não deve conter bancos.');
console.log('Pacote aprovado: demonstração obrigatória, código e migrações conferidos, nenhum banco incluído.');
