import { AppError } from "./errors.js";
import { fetchJson } from "./http.js";

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("URL de Odoo inválida");
  return url.toString().replace(/\/+$/, "");
}

export class OdooJson2Client {
  constructor({ baseUrl, database, apiKey, timeoutMs = 30_000 }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.database = database;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async call(model, method, body = {}) {
    if (!/^[a-z0-9_.]+$/.test(model) || !/^[a-zA-Z0-9_]+$/.test(method)) {
      throw new AppError(400, "invalid_odoo_method", "Modelo o método de Odoo inválido.");
    }
    const headers = {
      authorization: `bearer ${this.apiKey}`,
      "content-type": "application/json; charset=utf-8",
      "user-agent": "Pragmatic-Odoo-AI-Agent-Pilot/0.1",
    };
    if (this.database) headers["x-odoo-database"] = this.database;
    return fetchJson(
      `${this.baseUrl}/json/2/${encodeURIComponent(model)}/${encodeURIComponent(method)}`,
      { method: "POST", headers, body: JSON.stringify(body) },
      this.timeoutMs,
    );
  }

  searchRead(model, domain, fields, { limit = 10, order, context } = {}) {
    return this.call(model, "search_read", {
      domain,
      fields,
      limit,
      ...(order ? { order } : {}),
      ...(context ? { context } : {}),
    });
  }

  searchCount(model, domain, { context, limit } = {}) {
    return this.call(model, "search_count", {
      domain,
      ...(context ? { context } : {}),
      ...(limit ? { limit } : {}),
    });
  }

  create(model, values, context = undefined) {
    return this.call(model, "create", {
      vals_list: [values],
      ...(context ? { context } : {}),
    });
  }
}

export function relationId(value) {
  if (Array.isArray(value)) return value[0];
  if (Number.isInteger(value)) return value;
  return null;
}

export function relationName(value) {
  if (Array.isArray(value)) return String(value[1] ?? "");
  return "";
}
