# moneytrack

Painel web simples do **histórico do Ibovespa** (INDEXBVMF: IBOV), com base **PostgreSQL**.
Migrado de `my-finance` — por enquanto apenas o índice Ibovespa.

```
moneytrack/
├── db/
│   ├── 01_schema.sql          # tabelas (idx_index, index_hist)
│   └── 02_seed_ibovespa.sql   # 8.214 pregões (1993 → 2026), gerado do my-finance
├── web/
│   ├── server.js              # Express + pg: API + serve o painel; carrega o seed na subida
│   └── public/index.html      # painel (Chart.js): série, variação, máx/mín
├── scripts/convert_ibovespa.py # converte o .sql T-SQL (SQL Server) -> Postgres
├── Dockerfile                 # imagem do web (node:20-alpine)
├── docker-compose.yml         # postgres (imagem pública) + web
└── render.yaml                # blueprint do Render (DB gerenciado + web Docker)
```

## Rodar local (Docker)

O compose sobe **duas imagens públicas**: `postgres:16-alpine` (banco) e
`node:20-alpine` (painel, com o projeto montado via volume). Não há build local —
o `Dockerfile` é usado só no Render.

```bash
npm install            # popula node_modules no host (uma vez)
docker compose up -d
```

Acesse **http://localhost:3010** (host 3010 → container 3000; a 3000 estava em uso
nesta máquina — ajuste em `docker-compose.yml` se quiser). Na primeira subida o
`server.js` cria o schema e carrega o seed automaticamente (só se a tabela estiver
vazia). Os dados ficam no volume `moneytrack-pgdata`.

Para zerar a base: `docker compose down -v`.

## Rodar sem Docker

```bash
# 1. suba um Postgres e exporte a conexão
export DATABASE_URL="postgres://moneytrack:moneytrack@localhost:5432/moneytrack"
export PGSSL=false
# 2. instale e rode
npm install
npm start            # http://localhost:3000
```

## Deploy no Render

O `render.yaml` é um **Blueprint**: cria um PostgreSQL gerenciado (free) e um web
service Docker, já ligando a `DATABASE_URL` do banco no app.

1. Suba este repositório no GitHub.
2. No Render: **New → Blueprint** e aponte para o repo.
3. O Render constrói a imagem pelo `Dockerfile` e sobe o web. Na primeira subida o
   app cria o schema e carrega o seed na base gerenciada.

> Observação: no plano free do Render o web "dorme" após inatividade e o banco tem
> limite de retenção — adequado para painel de demonstração.

## API

| Rota | Descrição |
|------|-----------|
| `GET /api/ibovespa` | série completa `{ d, value }` (filtro opcional `?from=YYYY-MM-DD`) |
| `GET /api/health`   | healthcheck (usado pelo Render) |

## Por que PostgreSQL (e não SQL Server)?

A origem (`my-finance`) usa SQL Server. Para um painel simples que sobe no Render a
partir de **imagem pública**, o Postgres é mais leve (`postgres:16-alpine`), é o banco
**nativo gerenciado do Render** e dispensa licença/EULA e os ~2 GB de RAM do SQL Server.
O `scripts/convert_ibovespa.py` faz a conversão do dump T-SQL para o seed Postgres.

## Migrar outros índices/ativos depois

```bash
python scripts/convert_ibovespa.py \
  /caminho/my-finance/db/data/insert_<algo>_index_hist.sql \
  db/03_seed_<algo>.sql
```

Ajuste o `code`/insert no script conforme o índice e some o arquivo ao load do `server.js`.
