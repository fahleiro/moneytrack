#!/usr/bin/env python3
# Converte o seed T-SQL (SQL Server) do Ibovespa para PostgreSQL.
# Origem: my-finance/db/data/insert_ibovespa_index_hist.sql
# Entrada (linha): (@id,'YYYY-MM-DD',NUM),
# Saida: INSERT INTO index_hist (code, d, value) VALUES ('BR_IBOV','YYYY-MM-DD',NUM), ...
#
# Uso: python scripts/convert_ibovespa.py <arquivo_origem.sql> [db/02_seed_ibovespa.sql]
import re, sys, os

src = sys.argv[1] if len(sys.argv) > 1 else \
    r"C:/Users/gabriel.faleiro/Documents/github/my-finance/db/data/insert_ibovespa_index_hist.sql"
dst = sys.argv[2] if len(sys.argv) > 2 else \
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "db", "02_seed_ibovespa.sql")

row_re = re.compile(r"^\s*\(@id,'(\d{4}-\d{2}-\d{2})',\s*(-?\d+(?:\.\d+)?)\)")

rows = []
with open(src, encoding="utf-8") as f:
    for line in f:
        m = row_re.match(line)
        if m:
            rows.append((m.group(1), m.group(2)))

if not rows:
    sys.exit("Nenhuma linha encontrada — verifique o formato de origem.")

seen, uniq = set(), []
for d, v in rows:
    if d not in seen:
        seen.add(d)
        uniq.append((d, v))

with open(dst, "w", encoding="utf-8") as out:
    out.write("-- Seed Ibovespa (BR_IBOV) — diario. Convertido de my-finance (SQL Server) para PostgreSQL.\n")
    out.write("-- NAO editar a mao: gerado por scripts/convert_ibovespa.py.\n")
    out.write("INSERT INTO index_hist (code, d, value) VALUES\n")
    out.write(",\n".join(f"('BR_IBOV','{d}',{v})" for d, v in uniq))
    out.write("\nON CONFLICT (code, d) DO NOTHING;\n")

print(f"linhas lidas: {len(rows)} | unicas: {len(uniq)} | {uniq[0][0]} -> {uniq[-1][0]}")
