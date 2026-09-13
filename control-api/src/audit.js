import { createHash } from "node:crypto";

export function textSummary(text) {
  return {
    length: text?.length ?? 0,
    sha256: createHash("sha256").update(text ?? "").digest("hex"),
  };
}

export async function audit(db, event) {
  try {
    await db.query(
      `INSERT INTO agent.audit_events
        (client_id, linked_user_id, session_id, telegram_chat_id, telegram_message_id,
         event_type, outcome, tool_name, provider, model_id, odoo_model,
         odoo_record_ids, request_summary, response_summary, duration_ms,
         input_tokens, output_tokens, error_code, error_message)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        event.clientId ?? null,
        event.userId ?? null,
        event.sessionId ?? null,
        event.chatId ?? null,
        event.messageId ?? null,
        event.eventType,
        event.outcome,
        event.toolName ?? null,
        event.provider ?? null,
        event.modelId ?? null,
        event.odooModel ?? null,
        JSON.stringify(event.odooRecordIds ?? []),
        JSON.stringify(event.requestSummary ?? {}),
        JSON.stringify(event.responseSummary ?? {}),
        event.durationMs ?? null,
        event.inputTokens ?? null,
        event.outputTokens ?? null,
        event.errorCode ?? null,
        event.errorMessage?.slice(0, 500) ?? null,
      ],
    );
  } catch (error) {
    process.stderr.write(`No se pudo escribir auditoría: ${error.message}\n`);
  }
}

