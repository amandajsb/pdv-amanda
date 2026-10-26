// Inspeção estática: não executa o instalador nem abre o banco da loja.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const asar=require('@electron/asar');
const raiz=path.resolve(__dirname,'..');
const original=JSON.parse(fs.readFileSync(path.join(raiz,'package.json'),'utf8'));
const pasta=path.join(raiz,'dist');
const arquivo=path.join(pasta,'win-unpacked','resources','app.asar');
const metadata=JSON.parse(asar.extractFile(arquivo,'package.json').toString('utf8'));
assert.equal(metadata.version,original.version);
assert.equal(metadata.name,'pdv-amanda');
assert.equal(metadata.pdvDemonstracao,false,'O instalador de uso normal não pode obrigar demonstração.');
function conferir(dir){
  for(const entrada of fs.readdirSync(path.join(raiz,dir),{withFileTypes:true})){
    const relativo=path.join(dir,entrada.name);
    if(entrada.isDirectory())conferir(relativo);
    else assert.deepEqual(asar.extractFile(arquivo,relativo),fs.readFileSync(path.join(raiz,relativo)),`Código desatualizado: ${relativo}`);
  }
}
conferir('src');
assert.equal(asar.listPackage(arquivo).some(n=>/\.(db|sqlite\d*)(-|$)/i.test(n)),false,'O instalador não deve incluir bancos.');
const config=fs.readFileSync(path.join(raiz,'electron-builder.yml'),'utf8');
assert.match(config,/appId: com\.pdvamanda\.app/);
assert.match(config,/deleteAppDataOnUninstall: false/);
const instalador=path.join(pasta,`Sistema de Vendas ${original.version} - instalador.exe`);
assert.ok(fs.statSync(instalador).size>1000000,'Instalador incompleto.');
const fd=fs.openSync(instalador,'r');
const cabecalho=Buffer.alloc(2);fs.readSync(fd,cabecalho,0,2,0);fs.closeSync(fd);
assert.equal(cabecalho.toString('ascii'),'MZ');
if(process.env.PDV_VALIDAR_SQLITE_EM_MEMORIA==='1'){
  const Database=require(path.join(pasta,'win-unpacked','resources','app.asar.unpacked','node_modules','better-sqlite3'));
  const db=new Database(':memory:');
  db.exec('CREATE TABLE validacao(valor INTEGER); INSERT INTO validacao VALUES(123)');
  assert.equal(db.prepare('SELECT valor FROM validacao').get().valor,123);
  db.close();
  console.log('SQLite nativo do pacote aprovado no runtime do executável, usando somente memória.');
}
console.log(`Instalador ${original.version} aprovado: uso normal, código completo conferido, identidade original preservada, nenhum banco incluído.`);
