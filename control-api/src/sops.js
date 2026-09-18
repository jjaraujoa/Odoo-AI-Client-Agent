import { AppError } from "./errors.js";

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function scoreSopMatch(sop, queryTokens) {
  let score = 0;
  const titleNorm = normalizeText(sop.title);
  const contentNorm = normalizeText(sop.content_md);
  const keywordsNorm = (sop.keywords || []).map(normalizeText);
  const categoryNorm = normalizeText(sop.category);

  for (const token of queryTokens) {
    if (token.length < 3) continue;

    if (titleNorm.includes(token)) score += 5;
    if (keywordsNorm.some((k) => k.includes(token) || token.includes(k))) score += 4;
    if (categoryNorm.includes(token)) score += 3;
    if (contentNorm.includes(token)) score += 1;
  }

  return score;
}

export async function searchSops(db, clientId, query) {
  if (!query || typeof query !== "string") return [];

  const tokens = normalizeText(query)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);

  if (tokens.length === 0) return [];

  const res = await db.query(
    `SELECT id, sop_key, title, category, content_md, keywords, updated_at
       FROM agent.client_sops
      WHERE client_id = $1`,
    [clientId],
  );

  const scored = res.rows
    .map((sop) => ({
      sop,
      score: scoreSopMatch(sop, tokens),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((item) => item.sop);
}

export async function answerSopQuery({ db, client, clientId, query }) {
  const cId = typeof client === "string" ? client : (client?.id || clientId);
  const cName = client?.name || "la empresa";
  const matches = await searchSops(db, cId, query);

  if (matches.length === 0) {
    return {
      found: false,
      text: `ℹ️ *Procedimiento no documentado*: No encontré una política o procedimiento operativo oficial para "${query.slice(0, 80)}" en la base de conocimiento de ${cName}.\n\n_Por seguridad no invento reglas externas. Por favor consulte a su supervisor de área para que el consultor registre este procedimiento._`,
    };
  }

  const best = matches[0];
  const formatted = [
    `📖 *Procedimiento Oficial: ${best.title}*`,
    `_Categoría: ${best.category.toUpperCase()}_\n`,
    best.content_md,
    "\n_Procedimiento verificado de la empresa. Ante excepciones particulares, consulte con su supervisor._",
  ].join("\n");

  return {
    found: true,
    sop_key: best.sop_key,
    title: best.title,
    category: best.category,
    text: formatted,
  };
}

export async function upsertSop(db, clientId, {
  sopKey,
  title,
  category = "operaciones",
  contentMd,
  keywords = [],
}) {
  if (!sopKey || !title || !contentMd) {
    throw new AppError(400, "invalid_sop_input", "Faltan datos obligatorios (sopKey, title, contentMd).");
  }

  const res = await db.query(
    `INSERT INTO agent.client_sops
       (client_id, sop_key, title, category, content_md, keywords)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (client_id, sop_key) DO UPDATE SET
       title = EXCLUDED.title,
       category = EXCLUDED.category,
       content_md = EXCLUDED.content_md,
       keywords = EXCLUDED.keywords,
       updated_at = now()
     RETURNING id`,
    [clientId, sopKey, title, category, contentMd, keywords],
  );

  return { id: res.rows[0].id, sop_key: sopKey };
}
