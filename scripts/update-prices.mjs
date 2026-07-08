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

// Busca o último candle diário válido no Yahoo Finance.
async function fetchLatestCandle(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=5d&interval=1d`;

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

  // Pega o candle mais recente com close preenchido (o último costuma ser null
  // durante o pregão ou em dias sem negociação).
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (closes[i] != null) {
      return {
        tradingDay: toTradingDay(timestamps[i]),
        value: Math.round(closes[i] * 100) / 100,
      };
    }
  }
  throw new Error("nenhum close válido");
}

// Serializa a série no mesmo formato do repositório: um objeto por linha,
// dentro de "[\n...\n]\n".
function serialize(series) {
  return "[\n" + series.map((p) => JSON.stringify(p)).join(",\n") + "\n]\n";
}

async function updateTarget(t) {
  const path = join(DATA_DIR, t.file);
  const series = JSON.parse(readFileSync(path, "utf8"));
  const last = series[series.length - 1];

  const candle = await fetchLatestCandle(t.yahoo);

  if (last && candle.tradingDay <= last.tradingDay) {
    return { status: "skip", label: t.label, day: candle.tradingDay };
  }

  series.push(candle);
  writeFileSync(path, serialize(series));
  return { status: "updated", label: t.label, day: candle.tradingDay, value: candle.value };
}

async function main() {
  const targets = collectTargets();
  console.log(`Atualizando ${targets.length} ativos...`);

  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const t of targets) {
    try {
      const r = await updateTarget(t);
      if (r.status === "updated") {
        updated++;
        console.log(`  ✓ ${r.label}: +${r.day} = ${r.value}`);
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
    `\nResumo: ${updated} atualizados, ${skipped} sem novidade, ${errors.length} com erro.`,
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
