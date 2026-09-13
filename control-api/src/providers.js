import { AppError } from "./errors.js";
import { fetchJson } from "./http.js";

function extractOpenAiText(body) {
  if (typeof body.output_text === "string") return body.output_text;
  for (const item of body.output ?? []) {
    for (const part of item.content ?? []) {
      if (typeof part.text === "string") return part.text;
    }
  }
  throw new AppError(502, "invalid_model_response", "OpenAI no devolvió texto estructurado.");
}

function parseJsonText(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new AppError(502, "invalid_model_json", "El modelo no devolvió JSON válido.");
  }
}

export class ModelProviders {
  constructor(config) {
    this.openaiApiKey = config.openaiApiKey;
    this.anthropicApiKey = config.anthropicApiKey;
  }

  hasCredentials(provider) {
    return provider === "openai" ? Boolean(this.openaiApiKey) : Boolean(this.anthropicApiKey);
  }

  async validateModel(provider, modelId) {
    if (provider === "openai") {
      if (!this.openaiApiKey) return { valid: false, message: "OPENAI_API_KEY no configurada" };
      try {
        const body = await fetchJson(`https://api.openai.com/v1/models/${encodeURIComponent(modelId)}`, {
          headers: { authorization: `Bearer ${this.openaiApiKey}` },
        }, 15_000);
        return { valid: body.id === modelId, message: `Modelo visible como ${body.id}` };
      } catch (error) {
        return { valid: false, message: error.message };
      }
    }
    if (provider === "anthropic") {
      if (!this.anthropicApiKey) return { valid: false, message: "ANTHROPIC_API_KEY no configurada" };
      try {
        const body = await fetchJson(`https://api.anthropic.com/v1/models/${encodeURIComponent(modelId)}`, {
          headers: {
            "x-api-key": this.anthropicApiKey,
            "anthropic-version": "2023-06-01",
          },
        }, 15_000);
        return { valid: body.id === modelId, message: `Modelo visible como ${body.id}` };
      } catch (error) {
        return { valid: false, message: error.message };
      }
    }
    return { valid: false, message: "Proveedor desconocido" };
  }

  async structured({ model, system, userText, schema, media, maxTokens = 1500 }) {
    if (model.provider === "openai") {
      return this.#openaiStructured({ model, system, userText, schema, media, maxTokens });
    }
    return this.#anthropicStructured({ model, system, userText, schema, media, maxTokens });
  }

  async #openaiStructured({ model, system, userText, schema, media, maxTokens }) {
    if (!this.openaiApiKey) throw new AppError(503, "provider_not_configured", "OpenAI no está configurado.");
    const content = [{ type: "input_text", text: userText }];
    if (media) {
      const base64 = media.data.toString("base64");
      content.push(media.mimeType === "application/pdf"
        ? { type: "input_file", filename: media.filename, file_data: base64 }
        : { type: "input_image", image_url: `data:${media.mimeType};base64,${base64}` });
    }
    const body = await fetchJson("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.openaiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: model.api_model_id,
        instructions: system,
        input: [{ role: "user", content }],
        max_output_tokens: maxTokens,
        text: {
          format: {
            type: "json_schema",
            name: "agent_result",
            strict: true,
            schema,
          },
        },
      }),
    }, 60_000);
    return {
      data: parseJsonText(extractOpenAiText(body)),
      usage: {
        input: body.usage?.input_tokens,
        output: body.usage?.output_tokens,
      },
    };
  }

  async #anthropicStructured({ model, system, userText, schema, media, maxTokens }) {
    if (!this.anthropicApiKey) throw new AppError(503, "provider_not_configured", "Anthropic no está configurado.");
    const content = [];
    if (media) {
      content.push({
        type: media.mimeType === "application/pdf" ? "document" : "image",
        source: {
          type: "base64",
          media_type: media.mimeType,
          data: media.data.toString("base64"),
        },
      });
    }
    content.push({ type: "text", text: userText });
    const body = await fetchJson("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: model.api_model_id,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content }],
        tools: [{
          name: "return_json",
          description: "Devuelve exclusivamente el resultado estructurado solicitado.",
          input_schema: schema,
        }],
        tool_choice: { type: "tool", name: "return_json" },
      }),
    }, 60_000);
    const toolUse = (body.content ?? []).find((item) => item.type === "tool_use" && item.name === "return_json");
    if (!toolUse?.input) {
      throw new AppError(502, "invalid_model_response", "Anthropic no devolvió la herramienta estructurada.");
    }
    return {
      data: toolUse.input,
      usage: {
        input: body.usage?.input_tokens,
        output: body.usage?.output_tokens,
      },
    };
  }
}
