# moneytrack

Painel **estático** do histórico do **Ibovespa** (INDEXBVMF: IBOV) — dados versionados em **JSON**, sem backend.
Pensado para rodar no **GitHub Pages**: aqui se orquestram os **dados**; a carteira vive no `my-finance`.

```
moneytrack/
├── index.html                        # painel (HTML + CSS + JS puros; Chart.js via CDN)
└── data/
    └── market_history/
        └── IBOV.json                 # 8.214 pregões (1993 → 2026), 1 registro por linha
```

## Formato dos dados

`data/market_history/<CODIGO>.json` — array de objetos, espelhando o formato do `my-finance`:

```json
[
  {"tradingDay":"1993-04-27","value":24.5},
  {"tradingDay":"2026-06-26","value":173295}
]
```

- `tradingDay` — data do pregão (`YYYY-MM-DD`)
- `value` — fechamento do índice

Origem: `my-finance` (branch `finance-db`, `db/data/insert_ibovespa_index_hist.sql`), convertido de T-SQL para JSON.
Por enquanto apenas o Ibovespa; demais índices/ativos entram como novos arquivos em `data/market_history/`.

## Rodar local

Qualquer servidor estático serve (o `fetch` do JSON exige http):

```bash
npx http-server -p 3010
# ou: python -m http.server 3010
```

Acesse **http://localhost:3010**.

## GitHub Pages

Settings → Pages → Deploy from branch → `main` / root. Nada para buildar.

## Histórico

A versão anterior (PostgreSQL + Express + Docker/Render) está preservada na branch **`postgres-legacy`**.
