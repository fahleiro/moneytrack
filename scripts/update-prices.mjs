#!/usr/bin/env node
// Atualiza o preço de fechamento (EOD) dos ativos negociáveis do moneytrack.
//
// Lê data/assets.json e data/indices.json, e para cada entrada que tenha os
// campos `yahoo` (símbolo Yahoo Finance) e `file` (série em data/market_history/),
// busca o último candle diário no Yahoo Finance e faz append de {tradingDay, value}
// APENAS se o dia for mais recente que o último ponto já gravado (idempotente).
//
// Sem dependências: usa fetch nativo (Node 18+) e fs. Fonte: Yahoo Finance chart API.
// Séries macro (IPCA, SELIC, CPI, consumo) não têm `yahoo` e são ignoradas de propósito.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const CATALOGS = ["assets.json", "indices.json"];
const FETCH_TIMEOUT_MS = 30_000;

// Lê os catálogos e devolve a lista de alvos {label, yahoo, file}, sem duplicar
// arquivos (GOLD/SILVER/WTI aparecem em assets.json e indices.json).
function collectTargets() {
  const byFile = new Map();
  for (const catalog of CATALOGS) {
    const entries = JSON.parse(readFileSync(join(DATA_DIR, catalog), "utf8"));
    for (const e of entries) {
      if (!e.yahoo || !e.file) continue;
      if (byFile.has(e.file)) continue;
      byFile.set(e.file, {
        label: e.ticker || e.code || e.yahoo,
        yahoo: e.yahoo,
        file: e.file,
      });
    }
  }
  return [...byFile.values()];
}

// Converte epoch (segundos, UTC) para "YYYY-MM-DD".
function toTradingDay(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

// Busca os candles diários válidos no Yahoo Finance, em ordem cronológica.
// `range` é "1mo" na atualização do dia a dia — janela ampla o bastante para o
// job ser self-healing se o cron falhar por alguns dias — e "max" no bootstrap
// de uma série nova (ver BOOTSTRAP_MIN_POINTS).
async function fetchRecentCandles(symbol, range = "1mo") {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=1d`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let json;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const result = json?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
    throw new Error("resposta sem timestamp/close");
  }

  // Mantém só os candles com close preenchido (o Yahoo devolve null em dias
  // sem negociação ou no candle em formação durante o pregão).
  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null) {
      candles.push({
        tradingDay: toTradingDay(timestamps[i]),
        value: Math.round(closes[i] * 100) / 100,
      });
    }
  }
  if (candles.length === 0) throw new Error("nenhum close válido");
  return candles;
}

// Serializa a série no mesmo formato do repositório: um objeto por linha,
// dentro de "[\n...\n]\n".
function serialize(series) {
  return "[\n" + series.map((p) => JSON.stringify(p)).join(",\n") + "\n]\n";
}

// Abaixo disso a série é considerada nova/curta demais para os gráficos (faixas
// de 1Y/5Y/All) e para as sequências consecutivas — nesse caso vale buscar o
// histórico completo em vez da janela de 1 mês. ~200 pregões ≈ 1 ano.
const BOOTSTRAP_MIN_POINTS = 200;

async function updateTarget(t) {
  const path = join(DATA_DIR, t.file);
  const series = JSON.parse(readFileSync(path, "utf8"));
  const bootstrap = series.length < BOOTSTRAP_MIN_POINTS;

  const candles = await fetchRecentCandles(t.yahoo, bootstrap ? "max" : "1mo");

  // Merge por dia: o que já está gravado SEMPRE vence — a busca só acrescenta
  // dias ausentes (mais recentes no modo incremental, mais antigos no
  // bootstrap). Nada é sobrescrito, então rodar de novo é inofensivo.
  const byDay = new Map(candles.map((c) => [c.tradingDay, c]));
  for (const p of series) byDay.set(p.tradingDay, p);
  const merged = [...byDay.values()].sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));

  const novos = merged.length - series.length;
  if (novos === 0) {
    return { status: "skip", label: t.label, day: series.length ? series[series.length - 1].tradingDay : "vazia" };
  }

  writeFileSync(path, serialize(merged));
  const ultimo = merged[merged.length - 1];
  return {
    status: bootstrap ? "bootstrap" : "updated",
    label: t.label,
    count: novos,
    day: ultimo.tradingDay,
    value: ultimo.value,
  };
}

async function main() {
  const targets = collectTargets();
  console.log(`Atualizando ${targets.length} ativos...`);

  let updated = 0;
  let bootstrapped = 0;
  let skipped = 0;
  const errors = [];

  for (const t of targets) {
    try {
      const r = await updateTarget(t);
      if (r.status === "bootstrap") {
        bootstrapped++;
        console.log(`  ★ ${r.label}: histórico completo carregado — ${r.count} pregões até ${r.day} = ${r.value}`);
      } else if (r.status === "updated") {
        updated++;
        const dias = r.count > 1 ? ` (${r.count} dias)` : "";
        console.log(`  ✓ ${r.label}: até ${r.day} = ${r.value}${dias}`);
      } else {
        skipped++;
        console.log(`  · ${r.label}: sem novidade (último ${r.day})`);
      }
    } catch (err) {
      errors.push(t.label);
      console.log(`  ✗ ${t.label}: ${err.message}`);
    }
  }

  console.log(
    `\nResumo: ${updated} atualizados, ${bootstrapped} com histórico inicial, ${skipped} sem novidade, ${errors.length} com erro.`,
  );

  // Só falha o processo se TODOS deram erro (indício de problema sistêmico,
  // ex. mudança na API do Yahoo). Erros pontuais não derrubam o run.
  if (errors.length === targets.length && targets.length > 0) {
    console.error("Todos os ativos falharam — abortando.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
