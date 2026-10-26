-- Extensão aditiva: preserva cadastros e lançamentos anteriores.
ALTER TABLE vendas ADD COLUMN requisicao_hash TEXT;
ALTER TABLE contas_receber ADD COLUMN cancelada_em TEXT;
ALTER TABLE contas_receber ADD COLUMN cancelada_por TEXT;
ALTER TABLE contas_receber ADD COLUMN cancelada_motivo TEXT;
ALTER TABLE contas_receber_pagamentos ADD COLUMN operacao_id TEXT;
ALTER TABLE contas_receber_pagamentos ADD COLUMN requisicao_hash TEXT;
ALTER TABLE caixa_movimentos ADD COLUMN recebimento_id INTEGER REFERENCES contas_receber_pagamentos(id);

CREATE UNIQUE INDEX ux_cr_venda ON contas_receber(venda_id) WHERE venda_id IS NOT NULL;
CREATE UNIQUE INDEX ux_crp_operacao ON contas_receber_pagamentos(operacao_id) WHERE operacao_id IS NOT NULL;
CREATE UNIQUE INDEX ux_caixa_recebimento ON caixa_movimentos(recebimento_id) WHERE recebimento_id IS NOT NULL;
CREATE INDEX ix_cr_vencimento ON contas_receber(vencimento) WHERE status IN ('aberta','parcial');

CREATE TRIGGER validar_novo_recebimento BEFORE INSERT ON contas_receber_pagamentos
BEGIN
  SELECT CASE WHEN NEW.valor_centavos <= 0 OR typeof(NEW.valor_centavos) <> 'integer'
    OR NEW.forma NOT IN ('dinheiro','pix','debito','credito')
    OR NOT EXISTS (SELECT 1 FROM contas_receber WHERE id = NEW.conta_id
      AND status IN ('aberta','parcial') AND NEW.valor_centavos <= valor_centavos - valor_pago_centavos)
    OR NOT EXISTS (SELECT 1 FROM caixa_sessoes WHERE id = NEW.sessao_id AND status = 'aberta')
    THEN RAISE(ABORT, 'Recebimento inválido ou conta sem saldo disponível') END;
END;
