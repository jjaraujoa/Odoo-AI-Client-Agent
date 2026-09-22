import { AppError } from "./errors.js";
import { resolveIdentity } from "./identity.js";
import { fetchJson } from "./http.js";
import { resolveTelegramChannel } from "./onboarding.js";
import { acquireConcurrency, consumeRateLimit, getLimits, releaseConcurrency } from "./limits.js";
import { addMemory, clearSession, getOrCreateSession, getRecentMemory } from "./memory.js";
import { listAvailableModels } from "./models.js";
import { classifyIntent } from "./intent.js";
import { executeIntent, summarizeToolForMemory } from "./tools.js";
import {
  cancelPendingInvoice,
  confirmInvoice,
  downloadTelegramFile,
  prepareInvoice,
} from "./invoices.js";
import { OdooJson2Client } from "./odoo.js";
import { audit, textSummary } from "./audit.js";
import { handleSemanticRead, planSemanticReadShadow } from "./read-agent.js";
import { readPlannerMode } from "./semantic-catalog.js";
import { answerSopQuery } from "./sops.js";

function extractUpdate(update) {
  const callback = update.callback_query;
  const message = update.message ?? update.edited_message ?? callback?.message;
  const from = callback?.from ?? message?.from;
  if (!message?.chat?.id || !from?.id) {
    throw new AppError(400, "unsupported_update", "Actualización de Telegram no soportada.");
  }
  const text = callback?.data ?? message.text ?? message.caption ?? "";
  return {
    raw: update,
    message,
    from,
    chatId: Number(message.chat.id),
    messageId: Number(message.message_id),
    text: String(text).trim(),
    callbackId: callback?.id,
  };
}

export function assertPrivateTelegramChat(parsed) {
  const chatType = parsed?.message?.chat?.type;
  const telegramUserId = Number(parsed?.from?.id);
  const telegramChatId = Number(parsed?.chatId);
  if (chatType !== "private" || telegramUserId !== telegramChatId) {
    throw new AppError(
      403,
      "private_chat_required",
      "Por seguridad, este bot solo funciona en una conversación privada directa.",
    );
  }
}

function extractFile(parsed) {
  if (parsed.message.document) {
    const document = parsed.message.document;
    return {
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      filename: document.file_name || "factura",
      mimeType: document.mime_type || "application/octet-stream",
      size: document.file_size,
    };
  }
  if (parsed.message.photo?.length) {
    const photo = parsed.message.photo.at(-1);
    return {
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      filename: `factura-${photo.file_unique_id}.jpg`,
      mimeType: "image/jpeg",
      size: photo.file_size,
    };
  }
  return null;
}

function commandParts(text) {
  if (!text.startsWith("/")) return null;
  const [raw, ...args] = text.split(/\s+/);
  return {
    command: raw.split("@")[0].toLowerCase(),
    argument: args.join(" ").trim(),
  };
}

function truncate(text, maxChars) {
  const max = Math.min(Number(maxChars), 3900);
  return text.length <= max ? text : `${text.slice(0, max - 40)}\n\n[Respuesta truncada por el límite configurado]`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shouldRetryDelivery(error) {
  if (!(error instanceof AppError)) return true;
  if (["upstream_timeout", "upstream_unreachable"].includes(error.code)) return true;
  const status = Number(error.details?.upstreamStatus ?? 0);
  return status === 429 || status >= 500;
}

export async function deliverTelegramMessage(
  botToken,
  reply,
  { request = fetchJson, pause = wait, attempts = 3 } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await request(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: reply.chat_id,
            text: reply.text,
            protect_content: reply.protect_content !== false,
          }),
        },
        15_000,
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetryDelivery(error)) throw error;
      await pause(250 * (2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

function helpText() {
  return [
    "Puedo consultar:",
    "• órdenes de venta y compra",
    "• precios de productos",
    "• inventario por producto/almacén",
    "• facturas de clientes por estado, pago, fechas o cliente",
    "• clientes y sus datos empresariales básicos",
    "• comparaciones, conteos y cálculos seguros sobre esas entidades",
    "• facturas de proveedor PDF/JPG/PNG para crear un borrador",
    "",
    "Comandos:",
    "/model — ver modelos disponibles",
    "/model automático — selección automática",
    "/model <nombre exacto> — selección manual",
    "/whoami — ver identidad vinculada",
    "/clear — limpiar memoria y volver a automático",
    "/confirmar <código> — crear el borrador pendiente",
    "/cancelar — descartar el borrador pendiente",
    "/sop <consulta> — consultar procedimientos operativos y políticas (SOPs)",
  ].join("\n");
}

export class TelegramProcessor {
  constructor({ db, config, providers }) {
    this.db = db;
    this.config = config;
    this.providers = providers;
  }

  async process(envelope) {
    const started = Date.now();
    const update = envelope?.update ?? envelope;
    const parsed = extractUpdate(update);
    const channel = await resolveTelegramChannel(
      this.db,
      this.config,
      envelope?.telegram_webhook_secret,
    );
    let identity;
    let session;
    let lease;
    try {
      assertPrivateTelegramChat(parsed);
      identity = await resolveIdentity(
        this.db, parsed.from.id, parsed.chatId, this.config.credentialMasterKey,
        channel.client_id,
      );
      const limits = await getLimits(this.db, identity);
      if (parsed.text.length > limits.max_input_chars) {
        throw new AppError(413, "message_too_long", "El mensaje supera el límite configurado.");
      }
      await consumeRateLimit(this.db, identity, limits);
      lease = await acquireConcurrency(this.db, identity, limits);
      session = await getOrCreateSession(this.db, identity, parsed.chatId, limits);
      const odoo = new OdooJson2Client({
        baseUrl: identity.odoo_base_url,
        database: identity.odoo_database,
        apiKey: identity.odooApiKey,
        timeoutMs: Number(limits.request_timeout_seconds) * 1000,
      });

      const command = commandParts(parsed.text);
      let outcome;
      if (command) {
        outcome = await this.#handleCommand({
          parsed, identity, session, limits, odoo, command,
          telegramBotToken: channel.botToken,
        });
      } else {
        const fileDescriptor = extractFile(parsed);
        outcome = fileDescriptor
          ? await this.#handleInvoice({
            parsed, identity, session, limits, odoo, fileDescriptor,
            telegramBotToken: channel.botToken,
          })
          : await this.#handleText({ parsed, identity, session, limits, odoo });
      }
      outcome.text = truncate(outcome.text, limits.max_output_chars);
      await audit(this.db, {
        clientId: identity.client_id,
        userId: identity.id,
        sessionId: session.id,
        chatId: parsed.chatId,
        messageId: parsed.messageId,
        eventType: outcome.eventType || "telegram_request",
        outcome: outcome.outcome || "success",
        toolName: outcome.toolName,
        provider: outcome.model?.provider,
        modelId: outcome.model?.api_model_id,
        odooModel: outcome.odooModel,
        odooRecordIds: outcome.recordIds,
        requestSummary: { ...textSummary(parsed.text), ...(outcome.requestAudit || {}) },
        responseSummary: textSummary(outcome.text),
        durationMs: Date.now() - started,
        inputTokens: outcome.usage?.input,
        outputTokens: outcome.usage?.output,
      });
      const reply = {
        chat_id: parsed.chatId,
        text: outcome.text,
        protect_content: true,
        callback_query_id: parsed.callbackId,
      };
      await this.#deliver(channel.botToken, reply);
      return { delivered: true, chat_id: parsed.chatId };
    } catch (error) {
      await audit(this.db, {
        clientId: identity?.client_id ?? channel.client_id,
        userId: identity?.id,
        sessionId: session?.id,
        chatId: parsed.chatId,
        messageId: parsed.messageId,
        eventType: "telegram_request",
        outcome: error.status && error.status < 500 ? "denied" : "error",
        requestSummary: textSummary(parsed.text),
        durationMs: Date.now() - started,
        errorCode: error.code || "internal_error",
        errorMessage: error.message,
      });
      if (error instanceof AppError) {
        const reply = {
          chat_id: parsed.chatId,
          text: error.message,
          protect_content: true,
          error: error.code,
          callback_query_id: parsed.callbackId,
        };
        await this.#deliver(channel.botToken, reply);
        return { delivered: true, chat_id: parsed.chatId, error: error.code };
      }
      throw error;
    } finally {
      await releaseConcurrency(this.db, lease);
      if (identity) identity.odooApiKey = undefined;
      channel.botToken = undefined;
    }
  }

  async #deliver(botToken, reply) {
    await deliverTelegramMessage(botToken, reply);
    if (reply.callback_query_id) {
      await fetchJson(
        `https://api.telegram.org/bot${botToken}/answerCallbackQuery`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callback_query_id: reply.callback_query_id }),
        },
        10_000,
      );
    }
  }

  async #handleCommand({
    parsed, identity, session, limits, odoo, command, telegramBotToken,
  }) {
    switch (command.command) {
      case "/start":
      case "/ayuda":
      case "/help":
        return { text: helpText(), eventType: "help" };
      case "/whoami":
        return {
          text: `Telegram: ${parsed.from.username ? `@${parsed.from.username}` : parsed.from.id}\nOdoo: ${identity.odoo_login}\nCliente: ${identity.client_name}`,
          eventType: "identity_check",
        };
      case "/clear":
        await clearSession(this.db, session.id);
        return { text: "Memoria de este chat eliminada. El modelo volvió a modo automático.", eventType: "memory_clear" };
      case "/model":
        return this.#handleModelCommand(identity, session, command.argument);
      case "/confirmar": {
        if (!/^\d{6}$/.test(command.argument)) {
          throw new AppError(400, "invalid_confirmation", "Usa /confirmar seguido del código de 6 dígitos.");
        }
        const confirmed = await confirmInvoice({
          db: this.db, config: this.config, identity, odoo,
          code: command.argument, chatId: parsed.chatId,
          telegramBotToken,
        });
        return {
          text: confirmed.text,
          eventType: "vendor_bill_draft_create",
          toolName: "crear_factura_proveedor_borrador",
          recordIds: [confirmed.result.move_id],
        };
      }
      case "/cancelar": {
        const count = await cancelPendingInvoice(this.db, identity, parsed.chatId);
        return {
          text: count ? "Borrador pendiente cancelado." : "No había un borrador pendiente.",
          eventType: "pending_action_cancel",
        };
      }
      case "/sop": {
        if (!command.argument) {
          throw new AppError(400, "invalid_sop_query", "Usa /sop seguido del término o procedimiento a consultar.");
        }
        const sopResult = await answerSopQuery({
          db: this.db,
          clientId: identity.client_id,
          query: command.argument,
        });
        return {
          text: sopResult.text,
          eventType: "sop_advisory",
          toolName: "consultar_procedimiento_sop",
        };
      }
      default:
        throw new AppError(400, "unknown_command", "Comando desconocido. Usa /help.");
    }
  }

  async #handleModelCommand(identity, session, argument) {
    const models = await listAvailableModels(this.db, identity.client_id);
    if (!argument) {
      const current = session.model_mode === "auto"
        ? "Automático"
        : models.find((model) => model.id === session.selected_model_id)?.display_name || "No disponible";
      return {
        text: [
          `Modelo actual: ${current}`,
          "",
          "Modelos validados y habilitados:",
          ...(models.length ? models.map((model) => `• ${model.display_name}`) : ["• Ninguno todavía"]),
          "",
          "Usa /model automático o /model <nombre exacto>.",
        ].join("\n"),
        eventType: "model_list",
      };
    }
    if (/^(auto|automático|automatico)$/i.test(argument)) {
      await this.db.query(
        "UPDATE agent.chat_sessions SET model_mode = 'auto', selected_model_id = NULL WHERE id = $1",
        [session.id],
      );
      return { text: "Selección automática activada.", eventType: "model_change" };
    }
    const selected = models.find((model) =>
      model.display_name.toLowerCase() === argument.toLowerCase()
      || model.api_model_id.toLowerCase() === argument.toLowerCase());
    if (!selected) {
      throw new AppError(400, "model_unavailable", "Ese modelo no está validado y habilitado para este cliente.");
    }
    await this.db.query(
      "UPDATE agent.chat_sessions SET model_mode = 'manual', selected_model_id = $2 WHERE id = $1",
      [session.id, selected.id],
    );
    return { text: `Modelo seleccionado: ${selected.display_name}.`, eventType: "model_change", model: selected };
  }

  async #handleText({ parsed, identity, session, limits, odoo }) {
    if (!parsed.text) throw new AppError(400, "empty_message", "Envía una consulta o una factura.");
    const memory = await getRecentMemory(this.db, session, Number(limits.max_context_messages));
    await addMemory(this.db, identity, session, "user", "message", { text: parsed.text });
    const plannerMode = readPlannerMode(identity);
    if (plannerMode === "active") {
      const semantic = await handleSemanticRead({
        db: this.db,
        providers: this.providers,
        identity,
        session,
        limits,
        odoo,
        text: parsed.text,
        memory,
      });
      if (semantic.kind === "clarification") {
        await addMemory(this.db, identity, session, "assistant", "message", { text: semantic.text });
        return {
          text: semantic.text,
          eventType: "read_plan_clarification",
          model: semantic.model,
          usage: semantic.usage,
          requestAudit: { read_planner_mode: "active", read_plan_repaired: Boolean(semantic.repaired) },
        };
      }
      if (semantic.kind === "help") {
        return { text: helpText(), eventType: "help", model: semantic.model, usage: semantic.usage };
      }
      await addMemory(this.db, identity, session, "tool", "summary", semantic.memorySummary);
      await addMemory(this.db, identity, session, "assistant", "message", { text: semantic.text });
      return {
        text: semantic.text,
        eventType: "semantic_read_v1",
        toolName: "lectura_semantica_v1",
        recordIds: semantic.recordIds,
        odooModel: semantic.entityKeys.join(","),
        model: semantic.model,
        usage: semantic.usage,
        requestAudit: {
          read_planner_mode: "active",
          read_plan_hash: semantic.planHash,
          read_entities: semantic.entityKeys,
          read_plan_repaired: semantic.repaired,
          read_retry_used: semantic.retryUsed,
          grounded_response: semantic.synthesized,
        },
      };
    }
    let shadow = null;
    if (plannerMode === "shadow") {
      shadow = await planSemanticReadShadow({
        db: this.db,
        providers: this.providers,
        identity,
        session,
        limits,
        text: parsed.text,
        memory,
      });
    }
    const legacy = await this.#handleLegacyText({ parsed, identity, session, limits, odoo, memory });
    if (shadow) {
      legacy.requestAudit = {
        read_planner_mode: "shadow",
        shadow_status: shadow.status,
        shadow_plan_hash: shadow.planHash,
        shadow_entities: shadow.entities,
        shadow_repaired: shadow.repaired,
      };
    }
    return legacy;
  }

  async #handleLegacyText({ parsed, identity, session, limits, odoo, memory }) {
    const classified = await classifyIntent({
      db: this.db,
      providers: this.providers,
      identity,
      session,
      text: parsed.text,
      memory,
    });
    if (classified.data.needs_clarification) {
      const text = classified.data.clarification || "Necesito un dato adicional para identificar el registro.";
      await addMemory(this.db, identity, session, "assistant", "message", { text });
      return { text, eventType: "clarification", model: classified.model, usage: classified.usage };
    }
    if (classified.data.intent === "help") {
      return { text: helpText(), eventType: "help", model: classified.model, usage: classified.usage };
    }
    if (classified.data.intent === "sop_advisory") {
      const sopResult = await answerSopQuery({
        db: this.db,
        clientId: identity.client_id,
        query: classified.data.query || parsed.text,
      });
      await addMemory(this.db, identity, session, "assistant", "message", { text: sopResult.text });
      return {
        text: sopResult.text,
        eventType: "sop_advisory",
        toolName: "consultar_procedimiento_sop",
        model: classified.model,
        usage: classified.usage,
        requestAudit: {
          sop_matched: sopResult.matched,
          sop_code: sopResult.sop?.code || null,
          sop_title: sopResult.sop?.title || null,
        },
      };
    }
    if (classified.data.intent === "unsupported") {
      throw new AppError(400, "unsupported_request", "Esa solicitud no está disponible en este piloto.");
    }
    const result = await executeIntent({
      db: this.db, odoo, identity, limits, classification: classified.data,
    });
    await addMemory(
      this.db, identity, session, "tool", "summary",
      summarizeToolForMemory(classified.data, result),
    );
    await addMemory(this.db, identity, session, "assistant", "message", { text: result.text });
    return {
      text: result.text,
      eventType: "odoo_query",
      toolName: result.toolName,
      recordIds: result.records?.map((record) => record.id),
      model: classified.model,
      usage: classified.usage,
    };
  }

  async #handleInvoice({
    parsed, identity, session, limits, odoo, fileDescriptor, telegramBotToken,
  }) {
    const file = await downloadTelegramFile(
      this.config,
      fileDescriptor,
      telegramBotToken,
    );
    const result = await prepareInvoice({
      db: this.db,
      providers: this.providers,
      config: this.config,
      identity,
      session,
      limits,
      odoo,
      file,
    });
    await addMemory(this.db, identity, session, "assistant", "summary", {
      invoice_status: result.status,
      action_id: result.actionId,
      text: result.text,
    });
    file.data.fill(0);
    return {
      text: result.text,
      eventType: result.status === "pending" ? "vendor_bill_preview" : "vendor_bill_blocked",
      outcome: result.status === "pending" ? "pending" : "denied",
      toolName: "crear_factura_proveedor_borrador",
      model: result.model,
      usage: result.usage,
    };
  }
}
