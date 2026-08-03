#!/usr/bin/env node
// Coleta notícias por tópico e grava o conteúdo bruto em data/news/.
//
// Este script é a metade do pipeline que PRECISA DE REDE — por isso roda no
// GitHub Actions, não localmente. Ele não interpreta nada: só busca, normaliza
// e versiona o material. A curadoria (ler, filtrar, enriquecer com metadados,
// escrever insights e derivar bets) é feita depois, em cima do JSON gravado.
//
// Fonte: RSS do Google News (sem chave de API). Sem dependências: fetch nativo
// (Node 18+), fs e um parser mínimo de RSS — o formato é estável e previsível.
//
// Saída:
//   data/news/YYYY-MM-DD.json  — itens coletados na execução
//   data/news/news.json        — manifesto (arquivo, data, contagem)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const NEWS_DIR = join(DATA_DIR, "news");
const TOPICS_FILE = join(DATA_DIR, "news_topics.json");
const FETCH_TIMEOUT_MS = 30_000;
const MAX_PER_TOPIC = 12;

const LOCALE = {
  "pt-BR": { hl: "pt-BR", gl: "BR", ceid: "BR:pt-419" },
  "en-US": { hl: "en-US", gl: "US", ceid: "US:en" },
};

function feedURL(query, lang) {
  const l = LOCALE[lang] || LOCALE["en-US"];
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
    `&hl=${l.hl}&gl=${l.gl}&ceid=${encodeURIComponent(l.ceid)}`;
}

// --- parser mínimo de RSS -------------------------------------------------
const stripCDATA = (s) => s.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1");

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(\w+);/g, (m, n) => (n in named ? named[n] : m));
}

// As descrições do Google News vêm com HTML DUPLAMENTE escapado (&lt;p&gt;),
// então é preciso decodificar ANTES de remover as tags — e decodificar de novo
// depois, para as entidades que só aparecem uma vez desfeito o primeiro nível.
const clean = (s) => decodeEntities(decodeEntities(stripCDATA(s || "")).replace(/<[^>]*>/g, " "))
  .replace(/\s+/g, " ")
  .trim();

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

function parseItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
}

// --- coleta ---------------------------------------------------------------
async function fetchTopic(t) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let xml;
  try {
    const res = await fetch(feedURL(t.query, t.lang), {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const items = [];
  for (const raw of parseItems(xml).slice(0, MAX_PER_TOPIC)) {
    const link = clean(tag(raw, "link"));
    const title = clean(tag(raw, "title"));
    if (!link || !title) continue;
    const pub = clean(tag(raw, "pubDate"));
    const date = pub ? new Date(pub) : null;
    items.push({
      // id estável pelo link: é o que permite deduplicar entre execuções
      id: createHash("sha1").update(link).digest("hex").slice(0, 12),
      topic: t.topic,
      tags: t.tags || [],          // tags-semente do tópico; refinadas na curadoria
      title,
      source: clean(tag(raw, "source")) || null,
      link,
      publishedAt: date && !isNaN(date) ? date.toISOString() : null,
      snippet: clean(tag(raw, "description")).slice(0, 600) || null,
      // campos preenchidos depois, na curadoria (mantidos aqui para dar o formato)
      reviewed: false,
      insight: null,
    });
  }
  return items;
}

// ids já gravados em execuções anteriores, para não repetir a mesma matéria
function knownIds() {
  if (!existsSync(NEWS_DIR)) return new Set();
  const ids = new Set();
  for (const f of readdirSync(NEWS_DIR)) {
    if (!f.endsWith(".json") || f === "news.json") continue;
    try {
      for (const it of JSON.parse(readFileSync(join(NEWS_DIR, f), "utf8"))) ids.add(it.id);
    } catch { /* arquivo ilegível não derruba a coleta */ }
  }
  return ids;
}

function writeManifest() {
  const files = readdirSync(NEWS_DIR)
    .filter((f) => f.endsWith(".json") && f !== "news.json")
    .sort()
    .reverse();
  const manifest = files.map((file) => {
    const items = JSON.parse(readFileSync(join(NEWS_DIR, file), "utf8"));
    return { file, date: file.replace(/\.json$/, ""), count: items.length };
  });
  writeFileSync(join(NEWS_DIR, "news.json"), JSON.stringify(manifest, null, 2) + "\n");
}

async function main() {
  const topics = JSON.parse(readFileSync(TOPICS_FILE, "utf8"));
  mkdirSync(NEWS_DIR, { recursive: true });

  const seen = knownIds();
  console.log(`Coletando ${topics.length} tópicos (${seen.size} matérias já conhecidas)...`);

  const novos = [];
  const errors = [];
  for (const t of topics) {
    try {
      const items = await fetchTopic(t);
      const frescos = items.filter((i) => !seen.has(i.id));
      frescos.forEach((i) => seen.add(i.id));
      novos.push(...frescos);
      console.log(`  ✓ ${t.topic}: ${frescos.length} novas (de ${items.length})`);
    } catch (err) {
      errors.push(t.topic);
      console.log(`  ✗ ${t.topic}: ${err.message}`);
    }
  }

  if (novos.length === 0) {
    console.log("\nNenhuma matéria nova — nada a gravar.");
    return;
  }

  // o dia vem do próprio job (UTC), não de um argumento
  const day = new Date().toISOString().slice(0, 10);
  const path = join(NEWS_DIR, `${day}.json`);
  const anteriores = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const todos = [...anteriores, ...novos];
  writeFileSync(path, JSON.stringify(todos, null, 2) + "\n");
  writeManifest();

  console.log(`\nResumo: ${novos.length} matérias novas em news/${day}.json ` +
    `(${todos.length} no arquivo), ${errors.length} tópicos com erro.`);

  // Só falha se TODOS os tópicos falharem (indício de bloqueio/mudança de formato).
  if (errors.length === topics.length && topics.length > 0) {
    console.error("Todos os tópicos falharam — abortando.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
