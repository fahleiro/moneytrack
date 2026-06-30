-- Schema mínimo para o painel Ibovespa (PostgreSQL).
-- Idempotente: pode rodar várias vezes sem erro.

CREATE TABLE IF NOT EXISTS idx_index (
  code    TEXT PRIMARY KEY,            -- ex.: 'BR_IBOV'
  name    TEXT NOT NULL,
  country TEXT NOT NULL,               -- 'BR' | 'US'
  unit    TEXT NOT NULL                -- 'index' | 'pct_yoy' | ...
);

CREATE TABLE IF NOT EXISTS index_hist (
  code  TEXT NOT NULL REFERENCES idx_index(code),
  d     DATE NOT NULL,                 -- data do pregão
  value NUMERIC(18,4) NOT NULL,
  PRIMARY KEY (code, d)
);

CREATE INDEX IF NOT EXISTS ix_index_hist_d ON index_hist (code, d);

INSERT INTO idx_index (code, name, country, unit)
VALUES ('BR_IBOV', 'Ibovespa (INDEXBVMF: IBOV)', 'BR', 'index')
ON CONFLICT (code) DO NOTHING;
