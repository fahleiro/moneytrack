#!/usr/bin/env node
// Testa a captura do CORPO das matérias contra os sites reais.
//
// Por que existe: a extração roda só onde há rede (GitHub Actions). Numa sessão
// local o proxy bloqueia praticamente todo domínio, então o código de extração
// não pode ser exercitado ali — só contra mocks. Este script é o teste que roda
// no pipeline e responde: de cada 10 links guardados, em quantos o corpo é
// realmente capturado, e quando falha, POR QUÊ.
//
// Não altera dado nenhum: só lê os fatos já coletados, tenta extrair e relata.
//
// Uso:
//   node scripts/test-extraction.mjs [amostra] [arquivo-de-saida]
//   node scripts/test-extraction.mjs 30 .briefing/extraction-report.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchArticle, extractContent } from "./fetch-news.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEWS_DIR = join(ROOT, "data", "news");
const AMOSTRA = Number(process.argv[2] || 20);
const OUT = process.argv[3] || join(ROOT, ".briefing", "extraction-report.json");
const CONCURRENCY = 4;

const readJSON = (p, f) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return f; } };
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "?"; } };

// Qual estratégia de extractContent venceu — diagnóstico útil: se quase tudo cai
// em "meta", estamos guardando resumo de 160 chars achando que é matéria.
function estrategia(html, texto) {
  if (!texto) return null;
  const ld = html.match(/"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (ld && ld[1].length > 120) return "json-ld";
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].filter((m) => m[1].length > 100);
  return paras.length ? "paragrafos" : "meta-description";
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// Amostra espalhada entre veículos, não os N primeiros — senão o relatório mede
// um veículo só e a taxa não representa nada.
function amostrar(fatos, n) {
  const porFonte = new Map();
  for (const f of fatos) {
    if (!f.link) continue;
    const k = f.source || domainOf(f.link);
    if (!porFonte.has(k)) porFonte.set(k, []);
    porFonte.get(k).push(f);
  }
  const fontes = [...porFonte.values()];
  const out = [];
  for (let i = 0; out.length < n && i < 50; i++) {
    let acrescentou = false;
    for (const lista of fontes) {
      if (lista[i]) { out.push(lista[i]); acrescentou = true; }
      if (out.length >= n) break;
    }
    if (!acrescentou) break;
  }
  return out;
}

async function main() {
  const manifest = readJSON(join(NEWS_DIR, "news.json"), []);
  if (!manifest.length) { console.error("Sem fatos coletados — nada a testar."); process.exit(1); }
  const fatos = readJSON(join(NEWS_DIR, manifest[0].file), []);
  const alvos = amostrar(fatos, AMOSTRA);

  console.log(`Testando extração em ${alvos.length} matérias de ${manifest[0].file}`);
  console.log(`(${fatos.length} fatos no arquivo, ${fatos.filter((f) => f.content).length} já com corpo)\n`);

  const resultados = [];
  await pool(alvos, CONCURRENCY, async (f) => {
    const t0 = Date.now();
    const r = await fetchArticle(f.link, { diagnose: true });
    const ms = Date.now() - t0;

    const linha = {
      title: f.title.slice(0, 70), source: f.source || null,
      googleLink: f.link, resolvedUrl: r?.url || null,
      domain: r?.url ? domainOf(r.url) : null,
      ok: !!r?.ok, chars: r?.content?.length || 0, htmlChars: r?.htmlChars || 0, ms,
      motivo: r?.ok ? null : (r?.reason || "motivo desconhecido"),
      amostra: r?.content ? r.content.slice(0, 160) : null,
    };
    resultados.push(linha);
    const marca = linha.ok ? "OK " : "-- ";
    console.log(`  ${marca} ${String(linha.chars).padStart(5)} chars  ${(linha.domain || "?").padEnd(26)} ${linha.title.slice(0, 50)}`);
  });

  const ok = resultados.filter((r) => r.ok);
  const taxa = resultados.length ? Math.round((ok.length / resultados.length) * 100) : 0;

  // por domínio: onde funciona e onde não — é o que orienta ajuste do extrator
  const porDominio = {};
  for (const r of resultados) {
    const d = r.domain || "não resolvido";
    (porDominio[d] ??= { dominio: d, tentativas: 0, ok: 0, charsMedia: 0 });
    porDominio[d].tentativas++;
    if (r.ok) { porDominio[d].ok++; porDominio[d].charsMedia += r.chars; }
  }
  for (const d of Object.values(porDominio)) d.charsMedia = d.ok ? Math.round(d.charsMedia / d.ok) : 0;

  console.log(`\n=== TAXA DE EXTRAÇÃO: ${ok.length}/${resultados.length} (${taxa}%) ===`);
  console.log(`chars médios quando funciona: ${ok.length ? Math.round(ok.reduce((s, r) => s + r.chars, 0) / ok.length) : 0}`);
  console.log(`\npor domínio:`);
  for (const d of Object.values(porDominio).sort((a, b) => b.tentativas - a.tentativas)) {
    console.log(`  ${String(d.ok + "/" + d.tentativas).padStart(6)}  ${d.dominio.padEnd(30)} ${d.charsMedia ? d.charsMedia + " chars méd." : ""}`);
  }
  const falhas = resultados.filter((r) => !r.ok);
  if (falhas.length) {
    console.log(`\nfalhas (${falhas.length}):`);
    for (const f of falhas) console.log(`  ${(f.domain || "não resolvido").padEnd(30)} ${f.motivo}`);
  }

  const relatorio = {
    generatedAt: new Date().toISOString(), arquivo: manifest[0].file,
    amostra: resultados.length, sucesso: ok.length, taxaPct: taxa,
    charsMedios: ok.length ? Math.round(ok.reduce((s, r) => s + r.chars, 0) / ok.length) : 0,
    porDominio: Object.values(porDominio), resultados,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(relatorio, null, 2) + "\n");
  console.log(`\nrelatório: ${OUT}`);

  // Falha o job se a extração estiver praticamente morta — sinal de que o Google
  // mudou o redirect ou o extrator quebrou. 0% com amostra real é regressão.
  if (resultados.length >= 5 && ok.length === 0) {
    console.error("\nNENHUMA extração funcionou — provável quebra do resolvedor ou do extrator.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
