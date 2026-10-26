-- Não remove, renomeia ou reúne duplicidades anteriores e seus históricos.
CREATE INDEX ix_clientes_nome_chave ON clientes(nome_cliente_chave(nome));

CREATE TRIGGER clientes_nome_unico_inserir BEFORE INSERT ON clientes
WHEN EXISTS (SELECT 1 FROM clientes WHERE nome_cliente_chave(nome)=nome_cliente_chave(NEW.nome))
BEGIN
  SELECT RAISE(ABORT, 'CLIENTE_NOME_DUPLICADO');
END;

CREATE TRIGGER clientes_nome_unico_alterar BEFORE UPDATE OF nome ON clientes
WHEN nome_cliente_chave(NEW.nome) <> nome_cliente_chave(OLD.nome)
  AND EXISTS (SELECT 1 FROM clientes WHERE id<>OLD.id AND nome_cliente_chave(nome)=nome_cliente_chave(NEW.nome))
BEGIN
  SELECT RAISE(ABORT, 'CLIENTE_NOME_DUPLICADO');
END;
