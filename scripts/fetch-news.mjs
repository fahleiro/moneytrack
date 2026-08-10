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
// Saída (um arquivo por DIA, no padrão dd-mm-aaaa do repositório):
//   data/news/dd-mm-aaaa.json  — os fatos daquele dia, cada um com suas tags
//   data/news/news.json        — manifesto (arquivo, data ISO p/ ordenar, contagem)
//
// Nomenclatura: "news" aqui são FATOS — o registro datado do que aconteceu, que
// alimenta os insights e, por eles, as bets.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const NEWS_DIR = join(DATA_DIR, "news");
const TOPICS_FILE = join(DATA_DIR, "news_topics.json");
const CATALOGS = ["assets.json", "indices.json"];   // origem dos tickers detectáveis
const FETCH_TIMEOUT_MS = 30_000;
const MAX_PER_TOPIC = 12;
// Extração do CORPO da matéria. O RSS do Google só traz o título (a
// <description> é o próprio título repetido), o que é pouco para curar um fato.
// Só este job tem rede, então é aqui que o texto é buscado no site do veículo.
const CONTENT_MAX = 3000;         // chars guardados por matéria
const CONTENT_CONCURRENCY = 6;    // requisições simultâneas — não martelar os sites
const CONTENT_TIMEOUT_MS = 12_000;
const UA = "Mozilla/5.0 (compatible; moneytrack/1.0; +https://github.com/fahleiro/moneytrack)";

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

// --- deduplicação --------------------------------------------------------
// O link do Google News é um redirect codificado e NÃO é estável entre
// execuções: a mesma matéria pode voltar com outra URL e ser gravada de novo.
// Por isso a chave de deduplicação é o TÍTULO normalizado — sem acento,
// pontuação, sufixo do veículo ("... - O GLOBO") e palavras curtas —, que
// também pega a mesma matéria republicada por veículos diferentes.
// Remove o sufixo do veículo ("... - CNN Brasil"). Precisa sair ANTES de
// qualquer análise: o nome do jornal não é conteúdo da notícia e envenena tanto
// a impressão digital quanto as tags ("CNN Brasil"/"Brasil de Fato" marcariam
// toda matéria como sendo sobre o Brasil).
function semVeiculo(title, source) {
  let t = title.replace(/\s+[-–|]\s+[^-–|]{2,40}$/, "");
  if (source) t = t.split(source)[0];
  return t.trim();
}

function fingerprint(title) {
  const base = unaccent(semVeiculo(title).toLowerCase()).replace(/[^a-z0-9 ]+/g, " ");
  const palavras = [...new Set(base.split(/\s+/).filter((w) => w.length > 3))].sort();
  return palavras.slice(0, 10).join(" ");
}

function unaccent(s) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

// --- tags por notícia -----------------------------------------------------
// As tags do tópico são apenas a semente: valem para as 12 matérias daquele
// tópico e não dizem nada sobre a matéria em si. Aqui cada item ganha também
// as tags que o PRÓPRIO texto sustenta, no mesmo vocabulário usado pelos
// insights — é isso que torna a notícia um nó de verdade no grafo de tags.
const TAG_KEYWORDS = {
  petroleo: ["petról", "petrol", "oil", "brent", "wti", "opep", "opec", "barril", "crude"],
  energia: ["energia", "elétric", "electric", "power", "grid", "nuclear", "gás", "gas natural"],
  juros: ["juros", "selic", "taxa básica", "interest rate", "fed funds", "yield", "rate cut", "rate hike"],
  inflacao: ["inflaç", "inflation", "ipca", "cpi", "preços ao consumidor"],
  bancos: ["banco", "bank", "crédito", "credit", "empréstim", "lending", "mortgage"],
  semicondutores: ["chip", "semicondutor", "semiconductor", "nvidia", "tsmc", "wafer", "hbm"],
  ia: ["inteligência artificial", "artificial intelligence", " ia ", " ai ", "openai", "llm", "modelo de linguagem"],
  datacenter: ["data center", "datacenter", "hyperscaler", "cloud", "nuvem"],
  defesa: ["defesa", "defense", "militar", "military", "pentágono", "pentagon", "míssil", "missile", "armas", "caça", "fighter jet"],
  geopolitica: ["guerra", "war", "conflito", "conflict", "sanç", "sanction", "cessar-fogo", "ceasefire",
    "ataque", "attack", "bombarde", "drone", "tropas", "troops", "invas", "ofensiva", "offensive", "front"],
  varejo: ["varejo", "retail", "consumidor", "consumer", "vendas", "sales"],
  imobiliario: ["imobiliár", "housing", "real estate", "hipotec", "construç", "construction"],
  resultados: ["balanço", "resultado", "earnings", "lucro", "profit", "receita", "revenue", "guidance"],
  eleicoes: ["eleiç", "election", "eleitoral", "votaç"],
  tarifas: ["tarifa", "tariff", "imposto de importação", "trade war"],
  brasil: ["brasil", "brazil", "brasileir", "ibovespa", "copom", "petrobras", "banco central do brasil"],
  eua: ["estados unidos", "eua", "u.s.", "united states", "washington", "fed "],
  china: ["china", "chinês", "chinese", "pequim", "beijing"],
};

function inferTags(text) {
  const t = " " + unaccent(text.toLowerCase()) + " ";
  const out = [];
  for (const [tag, kws] of Object.entries(TAG_KEYWORDS)) {
    if (kws.some((k) => t.includes(unaccent(k.toLowerCase())))) out.push(tag);
  }
  return out;
}

// Tickers citados: nome da empresa (case-insensitive) ou o próprio código com
// 3+ letras em caixa alta. Códigos de 1–2 letras (C, V, BP) ficam de fora — o
// ruído de falso positivo seria maior que o ganho.
function loadTickerIndex() {
  const idx = [];
  for (const catalog of CATALOGS) {
    let entries;
    try {
      entries = JSON.parse(readFileSync(join(DATA_DIR, catalog), "utf8"));
    } catch { continue; }
    for (const e of entries) {
      const tk = e.ticker || e.code;
      if (!tk) continue;
      // corta só sufixos entre parênteses/travessão — NÃO no hífen, senão
      // "Take-Two Interactive" viraria "Take" e casaria com "Takeaways".
      const nome = (e.name || "").split(/[(—]|\s-\s/)[0].trim();
      idx.push({
        ticker: tk,
        nome: nome.length > 3 ? new RegExp(`\\b${escapeRe(unaccent(nome))}\\b`) : null,
      });
    }
  }
  return idx;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Casamento por PALAVRA INTEIRA e SENSÍVEL A MAIÚSCULAS. Sem fronteira de
// palavra, "Visa" casa com "visão" e "Target" com "targets"; sem maiúscula,
// "boosts target" viraria uma menção à Target Corp. Nome de empresa em manchete
// vem capitalizado, então exigir a caixa alta corta o ruído sem perder sinal
// (o custo é manchete escrita toda em minúsculas, que é rara).
function detectTickers(text, idx) {
  const plano = unaccent(text);
  const out = new Set();
  for (const { ticker, nome } of idx) {
    if (ticker.length >= 3 && new RegExp(`\\b${ticker}\\b`).test(text)) out.add(ticker);
    else if (nome && nome.test(plano)) out.add(ticker);
  }
  return [...out];
}

// --- extração do corpo da matéria ----------------------------------------
// Ordem de preferência: articleBody do JSON-LD (texto íntegro quando existe),
// depois os parágrafos da página, e por último a meta description. Parágrafos
// curtos são descartados porque quase sempre são legenda, crédito ou menu.
function extractContent(html) {
  const semRuido = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");

  const ld = html.match(/"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (ld) {
    // limiar menor que o dos parágrafos: se o veículo declara articleBody,
    // aquilo É a matéria — não precisa do mesmo grau de desconfiança.
    const t = clean(ld[1].replace(/\\[nrt]/g, " ").replace(/\\"/g, '"').replace(/\\\//g, "/"));
    if (t.length > 120) return t.slice(0, CONTENT_MAX);
  }

  const paras = [...semRuido.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => clean(m[1]))
    .filter((t) => t.length > 80);
  if (paras.length) {
    const t = paras.join(" ");
    if (t.length > 200) return t.slice(0, CONTENT_MAX);
  }

  const meta = html.match(/<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]+content=["']([^"']*)["']/i);
  const m = meta ? clean(meta[1]) : "";
  return m.length > 80 ? m.slice(0, CONTENT_MAX) : null;
}

// O link do RSS aponta para o redirecionador do Google; é preciso chegar ao
// site do veículo. Quando o Google devolve uma página intermediária (redirect
// por JS em vez de 302), a URL real vem no HTML.
// `diagnose: true` faz devolver o MOTIVO da falha em vez de null. A coleta não
// precisa disso (falhou, o fato fica só com o título), mas o teste de extração
// precisa distinguir "bloqueado no fetch" de "baixou mas não achou corpo" —
// sem essa distinção o relatório culpa paywall por tudo, inclusive por erro meu.
async function fetchArticle(link, { diagnose = false } = {}) {
  const falha = (reason, extra = {}) => (diagnose ? { ok: false, reason, ...extra } : null);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONTENT_TIMEOUT_MS);
  try {
    const headers = { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" };
    const res = await fetch(link, { redirect: "follow", headers, signal: ctrl.signal });
    if (!res.ok) return falha(`HTTP ${res.status} no link do Google`, { status: res.status });
    let html = await res.text();
    let url = res.url;

    if (/news\.google\./.test(url)) {
      const m = html.match(/data-n-au=["']([^"']+)["']/) ||
                html.match(/<a[^>]+href=["'](https?:\/\/(?!news\.google)[^"']+)["']/i);
      if (!m) return falha("redirect do Google não resolvido (formato mudou?)", { url });
      const res2 = await fetch(decodeEntities(m[1]), { redirect: "follow", headers, signal: ctrl.signal });
      if (!res2.ok) return falha(`HTTP ${res2.status} no veículo`, { status: res2.status, url: decodeEntities(m[1]) });
      html = await res2.text();
      url = res2.url;
    }
    const text = extractContent(html);
    if (!text) return falha("baixou, mas sem corpo extraível (paywall ou HTML sem parágrafos)", { url, htmlChars: html.length });
    return { ok: true, content: text, url, htmlChars: html.length };
  } catch (e) {
    const motivo = e.name === "AbortError" ? `timeout (${CONTENT_TIMEOUT_MS}ms)` : `falha de rede: ${e.message}`;
    return falha(motivo);
  } finally {
    clearTimeout(timer);
  }
}

// Executa fn sobre os itens com no máximo `n` em voo ao mesmo tempo.
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// Preenche `content`/`articleUrl` nos itens que ainda não têm. Idempotente:
// quem já tem conteúdo é pulado, então rodar de novo só tenta os que faltaram.
async function enrichContent(items, label) {
  const alvos = items.filter((i) => !i.content && i.link);
  if (!alvos.length) return 0;
  let ok = 0;
  await pool(alvos, CONTENT_CONCURRENCY, async (item) => {
    const r = await fetchArticle(item.link);
    if (r) {
      item.content = r.content;
      item.articleUrl = r.url;
      ok++;
    } else if (item.content === undefined) {
      item.content = null;      // marca a tentativa, para o log distinguir
    }
  });
  console.log(`  ${label}: corpo extraído de ${ok}/${alvos.length} matérias`);
  return ok;
}

// --- coleta ---------------------------------------------------------------
async function fetchTopic(t, tickerIdx) {
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
    const snippet = clean(tag(raw, "description")).slice(0, 600) || null;
    const source = clean(tag(raw, "source")) || null;
    const fp = fingerprint(title);
    // texto analisável = título + resumo, ambos sem o nome do veículo
    const texto = `${semVeiculo(title, source)} ${semVeiculo(snippet || "", source)}`;
    items.push({
      // id derivado do TÍTULO, não do link: o redirect do Google muda entre
      // execuções e faria a mesma matéria voltar como nova.
      id: createHash("sha1").update(fp).digest("hex").slice(0, 12),
      fingerprint: fp,
      topics: [t.topic],           // vira lista: a mesma matéria pode servir a vários tópicos
      tags: [...new Set([...(t.tags || []), ...inferTags(texto)])].sort(),
      tickers: detectTickers(texto, tickerIdx),
      title,
      source,
      link,
      publishedAt: date && !isNaN(date) ? date.toISOString() : null,
      snippet,
      // campos preenchidos depois, na curadoria (mantidos aqui para dar o formato)
      reviewed: false,
      insight: null,
    });
  }
  return items;
}

// Matérias já gravadas em execuções anteriores. Recalcula a impressão digital
// a partir do título — assim itens gravados antes desta lógica (cujo id vinha
// do link) continuam sendo reconhecidos e não voltam duplicados.
function knownIds() {
  if (!existsSync(NEWS_DIR)) return new Set();
  const ids = new Set();
  for (const f of readdirSync(NEWS_DIR)) {
    if (!f.endsWith(".json") || f === "news.json") continue;
    try {
      for (const it of JSON.parse(readFileSync(join(NEWS_DIR, f), "utf8"))) {
        ids.add(it.id);
        if (it.title) {
          ids.add(createHash("sha1").update(fingerprint(it.title)).digest("hex").slice(0, 12));
        }
      }
    } catch { /* arquivo ilegível não derruba a coleta */ }
  }
  return ids;
}

// Os arquivos seguem o padrão dd-mm-aaaa do repositório (mesmo dos insights e
// das branches). Como esse formato não ordena cronologicamente como string, o
// manifesto guarda também a data ISO — é por ela que se ordena.
const toDMY = (iso) => iso.split("-").reverse().join("-");
const toISO = (dmy) => dmy.split("-").reverse().join("-");

function writeManifest() {
  const manifest = readdirSync(NEWS_DIR)
    .filter((f) => f.endsWith(".json") && f !== "news.json")
    .map((file) => {
      const items = JSON.parse(readFileSync(join(NEWS_DIR, file), "utf8"));
      return { file, date: toISO(file.replace(/\.json$/, "")), count: items.length };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  writeFileSync(join(NEWS_DIR, "news.json"), JSON.stringify(manifest, null, 2) + "\n");
}

// Normaliza um item já gravado para o formato/vocabulário atuais. Usado tanto
// na coleta quanto no reprocessamento.
function normalize(it, tickerIdx) {
  const fp = fingerprint(it.title);
  const texto = `${semVeiculo(it.title, it.source)} ${semVeiculo(it.snippet || "", it.source)}`;
  const semente = (it.tags || []).filter((t) => !(t in TAG_KEYWORDS)); // preserva tags do tópico/curadoria
  return {
    ...it,
    id: createHash("sha1").update(fp).digest("hex").slice(0, 12),
    fingerprint: fp,
    topics: it.topics || (it.topic ? [it.topic] : []),
    tags: [...new Set([...semente, ...inferTags(texto)])].sort(),
    tickers: detectTickers(texto, tickerIdx),
    topic: undefined,
  };
}

// --retag: recalcula id/tags/tickers dos arquivos já gravados, sem rede. Serve
// para aplicar refinamentos do vocabulário de tags ao histórico já coletado.
function retagStored() {
  if (!existsSync(NEWS_DIR)) return console.log("Nada a reprocessar.");
  const tickerIdx = loadTickerIndex();
  for (const f of readdirSync(NEWS_DIR)) {
    if (!f.endsWith(".json") || f === "news.json") continue;
    const path = join(NEWS_DIR, f);
    const items = JSON.parse(readFileSync(path, "utf8"));
    const porId = new Map();
    for (const it of items) {
      const norm = normalize(it, tickerIdx);
      const antes = porId.get(norm.id);
      if (antes) {
        antes.topics = [...new Set([...antes.topics, ...norm.topics])];
        antes.tags = [...new Set([...antes.tags, ...norm.tags])].sort();
        continue;
      }
      porId.set(norm.id, norm);
    }
    const out = [...porId.values()];
    writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
    console.log(`  ${f}: ${items.length} -> ${out.length} itens (${items.length - out.length} duplicatas mescladas)`);
  }
  writeManifest();
}

async function main() {
  if (process.argv.includes("--retag")) {
    console.log("Reprocessando notícias já gravadas (sem rede)...");
    return retagStored();
  }
  const topics = JSON.parse(readFileSync(TOPICS_FILE, "utf8"));
  mkdirSync(NEWS_DIR, { recursive: true });

  const seen = knownIds();
  const tickerIdx = loadTickerIndex();
  console.log(`Coletando ${topics.length} tópicos (${seen.size} matérias já conhecidas)...`);

  const porId = new Map();   // matérias novas desta execução, por id
  const errors = [];
  let repetidas = 0, cruzadas = 0;
  for (const t of topics) {
    try {
      const items = await fetchTopic(t, tickerIdx);
      let frescas = 0;
      for (const it of items) {
        if (seen.has(it.id)) { repetidas++; continue; }   // já gravada em execução anterior
        const antes = porId.get(it.id);
        if (antes) {
          // mesma matéria vinda de outro tópico: mescla em vez de duplicar
          antes.topics = [...new Set([...antes.topics, ...it.topics])];
          antes.tags = [...new Set([...antes.tags, ...it.tags])].sort();
          cruzadas++;
          continue;
        }
        porId.set(it.id, it);
        frescas++;
      }
      console.log(`  ✓ ${t.topic}: ${frescas} novas (de ${items.length})`);
    } catch (err) {
      errors.push(t.topic);
      console.log(`  ✗ ${t.topic}: ${err.message}`);
    }
  }
  const novos = [...porId.values()];
  console.log(`\nFiltro: ${repetidas} já conhecidas descartadas, ${cruzadas} mescladas entre tópicos.`);

  // o dia vem do próprio job (UTC), não de um argumento
  const day = toDMY(new Date().toISOString().slice(0, 10));
  const path = join(NEWS_DIR, `${day}.json`);
  const anteriores = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const todos = [...anteriores, ...novos];

  // Busca o corpo das matérias — tanto das novas quanto das já gravadas que
  // ainda estão sem conteúdo (ex.: coletadas antes desta etapa existir).
  console.log("\nExtraindo conteúdo das matérias...");
  const enriquecidas = await enrichContent(todos, day);

  // grava se houve matéria nova OU se o backfill preencheu algum corpo
  if (novos.length === 0 && enriquecidas === 0) {
    console.log("Nada novo — nem matéria, nem conteúdo. Nada a gravar.");
    return;
  }

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

// Só executa quando chamado direto. Assim o test-extraction.mjs pode importar as
// funções de extração e exercitá-las contra sites reais sem disparar uma coleta.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { fetchArticle, extractContent, semVeiculo, fingerprint, inferTags, detectTickers, loadTickerIndex, clean };
