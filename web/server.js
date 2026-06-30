import express from "express";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = process.env.PORT || 3000;

// Conexão: DATABASE_URL (Render) ou variáveis discretas (docker-compose local).
const { Pool } = pg;
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
      }
    : {
        host: process.env.PGHOST || "db",
        port: Number(process.env.PGPORT || 5432),
        user: process.env.PGUSER || "moneytrack",
        password: process.env.PGPASSWORD || "moneytrack",
        database: process.env.PGDATABASE || "moneytrack",
      }
);

// Garante schema + seed na subida. Idempotente: só popula se a tabela estiver vazia.
// Assim "sobe com o database" tanto no compose quanto no Render.
async function ensureDatabase() {
  const schema = await readFile(join(ROOT, "db", "01_schema.sql"), "utf-8");
  await pool.query(schema);

  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM index_hist");
  if (rows[0].n === 0) {
    console.log("[init] tabela vazia — carregando seed do Ibovespa...");
    const seed = await readFile(join(ROOT, "db", "02_seed_ibovespa.sql"), "utf-8");
    await pool.query(seed);
    const { rows: after } = await pool.query("SELECT COUNT(*)::int AS n FROM index_hist");
    console.log(`[init] seed carregado: ${after[0].n} registros.`);
  } else {
    console.log(`[init] base já populada: ${rows[0].n} registros.`);
  }
}

const app = express();
app.use(express.static(join(__dirname, "public")));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Série histórica do Ibovespa (data + valor), opcionalmente filtrada por ?from=YYYY-MM-DD
app.get("/api/ibovespa", async (req, res) => {
  try {
    const params = ["BR_IBOV"];
    let where = "code = $1";
    if (req.query.from) {
      params.push(String(req.query.from));
      where += ` AND d >= $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS d, value::float8 AS value
         FROM index_hist
        WHERE ${where}
        ORDER BY d`,
      params
    );
    res.json({ code: "BR_IBOV", count: rows.length, series: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "erro ao consultar a base" });
  }
});

ensureDatabase()
  .then(() => app.listen(PORT, () => console.log(`moneytrack rodando em http://localhost:${PORT}`)))
  .catch((err) => {
    console.error("[fatal] falha ao iniciar a base:", err);
    process.exit(1);
  });
