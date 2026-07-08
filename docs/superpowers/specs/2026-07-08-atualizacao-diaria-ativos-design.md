# Atualização diária de cotações de ativos — Design

**Data:** 2026-07-08
**Status:** Aprovado para plano de implementação

## Problema

O moneytrack é um site estático (`index.html` + Chart.js) que lê séries históricas de
`data/market_history/<TICKER>.json`. A "cotação" exibida é apenas o **último ponto**
`{tradingDay, value}` de cada série. Hoje esses arquivos só são atualizados **à mão**, então
o preço fica congelado na data do último ponto.

Objetivo: atualizar automaticamente, **1x/dia**, o preço de fechamento (EOD) dos ativos
negociáveis, sem introduzir backend.

## Decisões (aprovadas)

| Decisão | Escolha |
|---|---|
| Onde roda | **GitHub Actions** (workflow agendado por cron) |
| Granularidade | **Fim de dia (EOD)** — 1 ponto por dia |
| Fonte | **Yahoo Finance** (endpoint chart não-oficial, sem API key) |
| Linguagem | **Node.js** (stdlib: `fetch` nativo do Node 18+ e `fs`, zero dependências) |
| Valor gravado | `close` do último candle diário |
| Índices macro | **Fora de escopo** deste job (ver abaixo) |

## Arquitetura

```
GitHub Actions (cron diário, ~23:00 UTC, dias de semana)
        │
        ▼
scripts/update-prices.mjs  ──HTTP──►  query1.finance.yahoo.com/v8/finance/chart
        │
        ▼
append em data/market_history/<TICKER>.json  (só se tradingDay for novo)
        │
        ▼
git commit + push  ("chore(data): EOD prices YYYY-MM-DD")  — só se houver mudança
```

O site estático não muda em nada: ele continua lendo os mesmos JSON, que agora se atualizam
sozinhos.

## Componentes

### 1. Mapa ticker → símbolo Yahoo (em `data/assets.json`)

Adicionar um campo **opcional** `yahoo` em cada entrada de `assets.json`. O catálogo passa a ser
a fonte da verdade sobre o que atualizar:

- Ativo **com** `yahoo` e **com** `file` → o job atualiza.
- Ativo **sem** `yahoo` (campo ausente ou `null`) → o job **ignora** (é assim que os índices
  macro e os ativos sem série ficam de fora, sem lógica especial no script).

Regras de mapeamento por tipo:

| Tipo / país | Regra | Exemplo |
|---|---|---|
| Ação BR (B3) | ticker + `.SA` | `ITUB4` → `ITUB4.SA` |
| Ação/ETF US | ticker puro | `AXP` → `AXP`, `QQQ` → `QQQ` |
| Cripto | `<código>-USD` | `BTC` → `BTC-USD` |
| Commodity | símbolo de futuro Yahoo | `GOLD` → `GC=F`, `SILVER` → `SI=F`, `WTI` → `CL=F` |
| Índice negociável | símbolo `^` | `IBOV` → `^BVSP`, `SP500` → `^GSPC`, `NASDAQ` → `^IXIC` |

**Fora de escopo (sem `yahoo`, permanecem manuais):** `IPCA`, `SELIC`, `CPI`, `BR_CONS`,
`US_CONS` — são séries macro de cadência mensal, fonte BCB/FRED, não cotação diária de mercado.
Podem virar um segundo job no futuro.

### 2. Script `scripts/update-prices.mjs` (Node, ESM, stdlib)

Fluxo:

1. Lê `data/assets.json`.
2. Filtra ativos com `yahoo` e `file` preenchidos.
3. Para cada um:
   - Busca `https://query1.finance.yahoo.com/v8/finance/chart/<símbolo>?range=5d&interval=1d`
     com header `User-Agent: Mozilla/5.0`.
   - Extrai o último candle válido: `tradingDay` (a partir de `timestamp`, em UTC → data
     `YYYY-MM-DD`) e `value` = `close` correspondente.
   - Lê o `market_history/<file>` atual, pega o último ponto.
   - **Append apenas se** `tradingDay` do candle for **estritamente mais recente** que o último
     `tradingDay` do arquivo (idempotente: rodar 2x no mesmo dia ou em fim de semana/feriado não
     duplica nem altera nada).
   - Grava o JSON preservando o formato atual (array de objetos, uma linha por ponto).
4. Ao final, imprime um resumo: quantos atualizados, quantos sem novidade, quantos com erro.

Tratamento de erro: cada ticker roda em `try/catch` isolado. Falha de rede/parse num ticker
**pula** aquele ativo e segue; o run só falha de verdade se **todos** falharem (indício de
problema sistêmico, ex. mudança na API do Yahoo).

Arredondamento de `value`: manter o número como o Yahoo devolve (o formato atual já mistura
inteiros e decimais, ex. `338` e `340.54`); no máximo arredondar para 2 casas para evitar ruído
de ponto flutuante.

### 3. Workflow `.github/workflows/update-prices.yml`

- **Trigger:** `schedule` com cron `0 23 * * 1-5` (23:00 UTC, seg–sex — após o fechamento de
  B3 ~20:00 UTC e NYSE ~21:00 UTC). Também `workflow_dispatch` para rodar manualmente.
- **Job:** runner `ubuntu-latest`, Node 20, `checkout` com permissão de escrita.
- **Passos:** rodar `node scripts/update-prices.mjs`; se `git status` acusar mudança em
  `data/market_history/`, fazer commit `chore(data): EOD prices YYYY-MM-DD` e push. Se nada
  mudou, encerra sem commit.
- **Permissão:** `permissions: contents: write` para o `GITHUB_TOKEN` conseguir dar push.

> Observação de fuso: o cron do GitHub Actions é sempre UTC e **não** ajusta para horário de
> verão. 23:00 UTC dá margem suficiente para o fechamento dos dois mercados o ano todo, então
> não é problema. Como o script é idempotente por `tradingDay`, um atraso de execução do
> Actions (comum na plataforma) não causa duplicata.

## Testes / validação

Antes de ligar o cron:

1. Rodar `node scripts/update-prices.mjs` localmente e conferir que:
   - ativos com `yahoo` ganham (ou não) um ponto novo corretamente;
   - rodar 2x seguidas **não** gera segundo append (idempotência);
   - um ticker com símbolo inválido é pulado sem derrubar o run.
2. Conferir no `git diff` que o formato dos JSON continua idêntico (mesma indentação/estrutura),
   para não poluir o histórico nem quebrar o parse do `index.html`.
3. Disparar o workflow via `workflow_dispatch` uma vez e verificar o commit automático.

## Fora de escopo (YAGNI)

- Cotação intraday / tempo real.
- Atualização de `asset_results.json` (lucro por período — cadência trimestral).
- Atualização das séries macro (IPCA/SELIC/CPI/consumo).
- Preenchimento de histórico retroativo (backfill) — o job só cuida do dia corrente em diante.
- Ajuste por proventos (adjusted close) — usamos `close` para bater com as séries existentes.
