import { AppError } from "./errors.js";

export async function listAvailableModels(db, clientId) {
  const result = await db.query(
    `SELECT m.id, m.display_name, m.provider, m.api_model_id, m.supports_vision,
            m.capability_rank, m.cost_rank, m.validation_status, cm.auto_priority
       FROM agent.models m
       JOIN agent.client_models cm ON cm.model_id = m.id
      WHERE cm.client_id = $1 AND cm.enabled AND m.active
      ORDER BY cm.auto_priority, m.cost_rank, m.display_name`,
    [clientId],
  );
  return result.rows;
}

export async function selectModel(db, clientId, { selectedModelId, requiresVision = false, complexity = 3 }) {
  if (selectedModelId) {
    const result = await db.query(
      `SELECT m.*
         FROM agent.models m
         JOIN agent.client_models cm ON cm.model_id = m.id
        WHERE m.id = $1 AND cm.client_id = $2 AND cm.enabled AND m.active`,
      [selectedModelId, clientId],
    );
    const model = result.rows[0];
    if (!model) throw new AppError(400, "model_unavailable", "El modelo seleccionado ya no está disponible.");
    if (requiresVision && !model.supports_vision) {
      throw new AppError(400, "model_without_vision", "El modelo seleccionado no admite documentos o imágenes.");
    }
    return model;
  }
  const result = await db.query(
    `SELECT m.*
       FROM agent.models m
       JOIN agent.client_models cm ON cm.model_id = m.id
      WHERE cm.client_id = $1
        AND cm.enabled
        AND m.active
        AND ($2::boolean = false OR m.supports_vision)
      ORDER BY
        CASE WHEN m.provider = 'openai' THEN 0 ELSE 1 END,
        CASE WHEN m.capability_rank >= $3 THEN 0 ELSE 1 END,
        cm.auto_priority,
        m.cost_rank,
        m.capability_rank DESC
      LIMIT 1`,
    [clientId, requiresVision, complexity],
  );
  if (!result.rows[0]) {
    throw new AppError(
      503,
      "no_validated_model",
      "No hay un modelo validado y habilitado para esta tarea. Ejecute la validación administrativa primero.",
    );
  }
  return result.rows[0];
}

export function estimateComplexity(text, requiresVision = false) {
  let score = requiresVision ? 7 : 2;
  if ((text?.length ?? 0) > 500) score += 2;
  if (/\b(analiza|compara|explica|resume|diferencia|varios|todas)\b/i.test(text ?? "")) score += 2;
  return Math.min(10, score);
}

