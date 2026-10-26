-- Cabeçalho de um recebimento que pode quitar várias compras do mesmo cliente.
-- Os lançamentos anteriores continuam intactos nas tabelas existentes.
CREATE TABLE recebimentos_fiado (
  id INTEGER PRIMARY KEY,
  operacao_id TEXT NOT NULL UNIQUE,
  requisicao_hash TEXT NOT NULL,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  sessao_id INTEGER NOT NULL REFERENCES caixa_sessoes(id),
  forma TEXT NOT NULL CHECK (forma IN ('dinheiro','pix','debito','credito')),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  valor_recebido_centavos INTEGER,
  troco_centavos INTEGER NOT NULL DEFAULT 0 CHECK (troco_centavos >= 0),
  saldo_apos_centavos INTEGER NOT NULL CHECK (saldo_apos_centavos >= 0),
  criado_em TEXT NOT NULL,
  criado_por TEXT
);
ALTER TABLE contas_receber_pagamentos ADD COLUMN recebimento_grupo_id INTEGER REFERENCES recebimentos_fiado(id);
CREATE INDEX ix_recebimentos_fiado_cliente ON recebimentos_fiado(cliente_id, id);
CREATE UNIQUE INDEX ux_recebimento_grupo_conta ON contas_receber_pagamentos(recebimento_grupo_id, conta_id)
  WHERE recebimento_grupo_id IS NOT NULL;
