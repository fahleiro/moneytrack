#!/usr/bin/env node
// Monta o BRIEFING que o modelo lê para gerar insights — o passo que roda ANTES
// da geração, na Action "Generate insights".
//
// O trabalho aqui é determinístico de propósito: cruzar fatos, insights, tags,
// apostas e preços é comparação de dados, não julgamento. O modelo deve receber
// o material já organizado e gastar seu esforço no que só ele faz — interpretar
// e tomar posição. O VIÉS com que ele interpreta vem de .claude/ (repositório
// privado, clonado pela Action), não daqui.
//
// Saída (JSON, default .briefing/briefing.json):
//   catalog             ativos negociáveis + retornos (o que dá para apostar)
//   openBets            apostas vivas (para não duplicar nem contradizer sem ver)
//   existingInsights    teses já escritas + suas tags e apostas
//   tagVocabulary       vocabulário em uso, com contagem em fatos e insights
//   factsWithoutInsight FILA DE TRABALHO: fato + corpo + insights/fatos relacionados por tag
//   factsWithInsight    fatos já curados (compacto), para o modelo ver o que já foi usado

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");
const NEWS_DIR = join(DATA_DIR, "news");
const INSIGHTS_DIR = join(DATA_DIR, "insights");
const CATALOGS = ["assets.json", "indices.json"];

// Quanto de corpo mandar por fato da fila. O briefing inteiro vira prompt, então
// há um teto — mas cortar demais devolve o problema que o corpo veio resolver.
const CONTENT_CHARS = 1500;
const MAX_RELATED_FACTS = 6;
const MAX_RELATED_INSIGHTS = 5;

const readJSON = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
};

const tagsOf = (v) => (Array.isArray(v) ? v : String(v || "").split(","))
  .map((t) => t.trim().toLowerCase()).filter(Boolean);

// --- preços: retornos que dizem se a tese já está no preço ------------------
function serieStats(file) {
  const s = readJSON(join(DATA_DIR, file), []);
  if (!s.length) return null;
  const last = s[s.length - 1];
  const at = (n) => (s.length > n ? s[s.length - 1 - n].value : s[0].value);
  const ytd = (s.find((p) => p.tradingDay >= `${last.tradingDay.slice(0, 4)}-01-02`) || s[0]).value;
  const pct = (a, b) => (a ? Math.round((b / a - 1) * 1000) / 10 : null);
  return {
    points: s.length,
    lastDay: last.tradingDay,
    lastValue: last.value,
    ret1w: pct(at(5), last.value),
    ret1m: pct(at(21), last.value),
    retYtd: pct(ytd, last.value),
  };
}

function buildCatalog() {
  const out = [];
  const seen = new Set();
  for (const c of CATALOGS) {
    for (const e of readJSON(join(DATA_DIR, c), [])) {
      const ticker = e.ticker || e.code;
      if (!ticker || seen.has(ticker) || !e.file) continue;
      seen.add(ticker);
      const stats = serieStats(e.file);
      if (!stats) continue;                       // sem série = aposta não resolve
      out.push({ ticker, name: e.name || null, country: e.country || null,
        sectors: e.sectors || [], ...stats });
    }
  }
  return out.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

// --- insights e apostas ----------------------------------------------------
function loadInsights() {
  if (!existsSync(INSIGHTS_DIR)) return [];
  return readdirSync(INSIGHTS_DIR)
    .filter((f) => f.endsWith(".json") && f !== "insights.json")
    .map((file) => {
      const d = readJSON(join(INSIGHTS_DIR, file), null);
      return d ? { file, ...d, tagList: tagsOf(d.tags) } : null;
    })
    .filter(Boolean);
}

// Resolve a aposta contra o histórico — mesma regra da view Bets, para o modelo
// enxergar exatamente o placar que o painel mostra.
function resolveBet(bet, placedDate, fileByTicker) {
  const file = fileByTicker[bet.ticker] || `market_history/${bet.ticker}.json`;
  const s = readJSON(join(DATA_DIR, file), []);
  if (!s.length) return { status: "nodata" };
  const onBefore = (iso) => { let v = null; for (const p of s) { if (p.tradingDay <= iso) v = p; else break; } return v; };
  const base = onBefore(placedDate) || s[0];
  const d = new Date(placedDate + "T00:00:00Z");
  const q = bet.period?.qty || 0;
  if (bet.period?.type === "day") d.setUTCDate(d.getUTCDate() + q);
  else if (bet.period?.type === "week") d.setUTCDate(d.getUTCDate() + q * 7);
  else if (bet.period?.type === "month") d.setUTCMonth(d.getUTCMonth() + q);
  const endDate = d.toISOString().slice(0, 10);
  const open = endDate > s[s.length - 1].tradingDay;
  const end = open ? s[s.length - 1] : (onBefore(endDate) || s[s.length - 1]);
  const change = base.value ? Math.round((end.value / base.value - 1) * 1000) / 10 : 0;
  let thr = null;
  if (bet.target) { const m = String(bet.target).match(/-?\d+(?:[.,]\d+)?/); if (m) thr = parseFloat(m[0].replace(",", ".")); }
  const bull = bet.expect === "bullish";
  const win = thr != null ? (bull ? change >= thr : change <= thr) : (bull ? change > 0 : change < 0);
  return { status: open ? "open" : (win ? "win" : "loss"), change, endDate };
}

// --- montagem --------------------------------------------------------------
function main() {
  const outPath = process.argv[2] || join(ROOT, ".briefing", "briefing.json");

  const manifest = readJSON(join(NEWS_DIR, "news.json"), []);
  if (!manifest.length) { console.error("Sem fatos coletados — nada a preparar."); process.exit(1); }
  const day = manifest[0];
  const facts = readJSON(join(NEWS_DIR, day.file), []);

  const insights = loadInsights();
  const fileByTicker = {};
  for (const c of CATALOGS)
    for (const e of readJSON(join(DATA_DIR, c), []))
      if ((e.ticker || e.code) && e.file) fileByTicker[e.ticker || e.code] ??= e.file;

  const openBets = [];
  for (const ins of insights)
    for (const bet of ins.bets || [])
      openBets.push({ ticker: bet.ticker, expect: bet.expect, target: bet.target || null,
        period: bet.period, placedAt: ins.date, insight: ins.code,
        ...resolveBet(bet, ins.date, fileByTicker) });

  const semInsight = facts.filter((f) => !f.insight);
  const comInsight = facts.filter((f) => f.insight);

  // vocabulário: onde cada tag aparece — em fatos e em insights
  const vocab = {};
  for (const f of facts) for (const t of tagsOf(f.tags)) (vocab[t] ??= { tag: t, facts: 0, insights: 0 }).facts++;
  for (const i of insights) for (const t of i.tagList) (vocab[t] ??= { tag: t, facts: 0, insights: 0 }).insights++;

  // FILA DE TRABALHO: cada fato não curado já vem com quem ele toca por tag
  const fila = semInsight.map((f) => {
    const ft = tagsOf(f.tags);
    const relatedInsights = insights
      .map((i) => ({ code: i.code, title: i.title, shared: i.tagList.filter((t) => ft.includes(t)) }))
      .filter((r) => r.shared.length)
      .sort((a, b) => b.shared.length - a.shared.length)
      .slice(0, MAX_RELATED_INSIGHTS);
    const relatedFacts = semInsight
      .filter((o) => o.id !== f.id)
      .map((o) => ({ id: o.id, title: o.title, shared: tagsOf(o.tags).filter((t) => ft.includes(t)) }))
      .filter((r) => r.shared.length >= 2)
      .sort((a, b) => b.shared.length - a.shared.length)
      .slice(0, MAX_RELATED_FACTS);
    return {
      id: f.id, title: f.title, source: f.source, publishedAt: f.publishedAt,
      link: f.articleUrl || f.link, topics: f.topics || [], tags: ft, tickers: f.tickers || [],
      content: f.content ? f.content.slice(0, CONTENT_CHARS) : null,
      hasBody: !!f.content,
      relatedInsights, relatedFacts,
    };
  });

  const briefing = {
    generatedAt: new Date().toISOString(),
    day: day.date,
    file: day.file,
    counts: {
      facts: facts.length,
      withoutInsight: semInsight.length,
      withInsight: comInsight.length,
      withBody: facts.filter((f) => f.content).length,
      insights: insights.length,
      bets: openBets.length,
      betsOpen: openBets.filter((b) => b.status === "open").length,
    },
    catalog: buildCatalog(),
    openBets,
    tagVocabulary: Object.values(vocab).sort((a, b) => (b.facts + b.insights) - (a.facts + a.insights)),
    existingInsights: insights.map((i) => ({ code: i.code, file: i.file, title: i.title,
      date: i.date, tags: i.tagList, bets: (i.bets || []).map((b) => `${b.ticker} ${b.expect}`) })),
    factsWithoutInsight: fila,
    factsWithInsight: comInsight.map((f) => ({ id: f.id, title: f.title, tags: tagsOf(f.tags), insight: f.insight })),
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(briefing, null, 2) + "\n");

  const c = briefing.counts;
  console.log(`Briefing de ${briefing.day} -> ${outPath}`);
  console.log(`  fatos: ${c.facts} (${c.withoutInsight} sem insight, ${c.withBody} com corpo)`);
  console.log(`  insights: ${c.insights} | apostas: ${c.bets} (${c.betsOpen} em aberto)`);
  console.log(`  ativos negociáveis: ${briefing.catalog.length} | tags em uso: ${briefing.tagVocabulary.length}`);
  const semRel = fila.filter((f) => !f.relatedInsights.length).length;
  console.log(`  fatos sem nenhuma tese relacionada (tema novo): ${semRel}`);
}

main();
