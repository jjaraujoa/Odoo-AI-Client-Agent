import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { fetchJson } from "./http.js";

export function normalizeBaseUrl(value) {
  if (!value) throw new AppError(400, "invalid_odoo_url", "URL de Odoo requerida.");
  const candidate = String(value).trim();
  const url = new URL(candidate);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new AppError(400, "insecure_odoo_url", "Odoo debe usar HTTPS; HTTP solo se permite en localhost.");
  }
  let normalized = url.origin + url.pathname.replace(/\/+$/, "");
  if (normalized.toLowerCase().endsWith("/odoo")) {
    normalized = normalized.slice(0, -5).replace(/\/+$/, "");
  }
  return normalized;
}

export function parseMajorSeries(serverVersion) {
  if (!serverVersion) return "";
  const match = String(serverVersion).match(/^(1[4-9]|20)(?:\.|$)/);
  return match ? `${match[1]}.0` : "";
}

export function isLegacyRpcSeries(series) {
  return ["14.0", "15.0", "16.0", "17.0", "18.0"].includes(series);
}

export async function detectInstance(baseUrl, { timeoutMs = 15_000 } = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: {},
    id: randomUUID(),
  };

  const response = await fetchJson(
    `${normalized}/web/webclient/version_info`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "user-agent": "Pragmatic-Odoo-AI-Agent-Pilot/0.2",
      },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );

  const result = response?.result ?? response ?? {};
  const serverVersion = String(result?.server_version ?? "");
  const serverSeries = parseMajorSeries(serverVersion);
  let transport = "unsupported";
  if (serverSeries === "19.0" || serverSeries === "20.0") {
    transport = "json2";
  } else if (isLegacyRpcSeries(serverSeries)) {
    transport = "legacy_rpc";
  }

  return {
    baseUrl: normalized,
    server_version: serverVersion,
    server_series: serverSeries,
    transport,
    server_version_info: result?.server_version_info ?? null,
  };
}

function sanitizeRpcErrorMessage(raw) {
  if (!raw) return "Error desconocido";
  const str = String(raw).trim();
  const firstLine = str.split("\n")[0].trim();
  return firstLine.replace(/['"](?:\\.|(?!\1).)*\1/g, "'<redactado>'").slice(0, 250);
}

export class OdooJson2Client {
  constructor({ baseUrl, database, apiKey, timeoutMs = 30_000 }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.database = database;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.transport = "json2";
  }

  async call(model, method, body = {}) {
    if (!/^[a-z0-9_.]+$/.test(model) || !/^[a-zA-Z0-9_]+$/.test(method)) {
      throw new AppError(400, "invalid_odoo_method", "Modelo o método de Odoo inválido.");
    }
    const headers = {
      authorization: `bearer ${this.apiKey}`,
      "content-type": "application/json; charset=utf-8",
      "user-agent": "Pragmatic-Odoo-AI-Agent-Pilot/0.2",
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

  write(model, id, vals, context = undefined) {
    const recordId = Number(id);
    if (!Number.isInteger(recordId) || recordId <= 0) {
      throw new AppError(400, "invalid_res_id", "El ID del registro para la actualización es inválido.");
    }
    return this.call(model, "write", {
      ids: [recordId],
      vals,
      ...(context ? { context } : {}),
    });
  }

  async postChatterMessage(model, resId, body, { partnerIds = [], messageType = "comment" } = {}) {
    const id = Number(resId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError(400, "invalid_res_id", "El ID del registro para el mensaje de chatter es inválido.");
    }
    const values = {
      model,
      res_id: id,
      body: String(body),
      message_type: messageType,
    };
    if (Array.isArray(partnerIds) && partnerIds.length > 0) {
      const validPartners = partnerIds.map(Number).filter((p) => Number.isInteger(p) && p > 0);
      if (validPartners.length > 0) {
        values.partner_ids = [[6, 0, validPartners]];
      }
    }
    return this.create("mail.message", values);
  }
}

export class OdooLegacyRpcClient {
  constructor({ baseUrl, database, apiKey, login, uid = null, timeoutMs = 30_000 }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.database = database;
    this.apiKey = apiKey;
    this.login = login;
    this.authenticatedUid = uid ? Number(uid) : null;
    this.timeoutMs = timeoutMs;
    this.transport = "legacy_rpc";
  }

  async authenticateLegacy() {
    if (this.authenticatedUid && Number.isSafeInteger(this.authenticatedUid) && this.authenticatedUid > 0) {
      return this.authenticatedUid;
    }
    if (!this.database) {
      throw new AppError(400, "database_required", "Las versiones de Odoo con protocolo RPC heredado (14 a 18) requieren el nombre de la base de datos.");
    }
    if (!this.login) {
      throw new AppError(400, "login_required", "Las versiones de Odoo con protocolo RPC heredado requieren el usuario (login).");
    }
    if (!this.apiKey) {
      throw new AppError(400, "api_key_required", "Se requiere una API key o credencial para autenticar en Odoo.");
    }

    const payload = {
      jsonrpc: "2.0",
      method: "call",
      params: {
        service: "common",
        method: "authenticate",
        args: [this.database, this.login, this.apiKey, {}],
      },
      id: randomUUID(),
    };

    const envelope = await this.sendJsonRpc(payload);
    const uid = Number(envelope?.result);
    if (!Number.isSafeInteger(uid) || uid <= 0) {
      throw new AppError(401, "odoo_authentication_failed", "Odoo RPC heredado rechazó las credenciales, el login o el nombre de base.");
    }
    this.authenticatedUid = uid;
    return uid;
  }

  async sendJsonRpc(payload) {
    const envelope = await fetchJson(
      `${this.baseUrl}/jsonrpc`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "user-agent": "Pragmatic-Odoo-AI-Agent-Pilot/0.2",
        },
        body: JSON.stringify(payload),
      },
      this.timeoutMs,
    );

    if (envelope?.error) {
      const errData = envelope.error.data || {};
      const errName = errData.name || envelope.error.message || "Error en llamada RPC de Odoo";
      const detail = sanitizeRpcErrorMessage(errData.message || envelope.error.message || errName);
      throw new AppError(400, "odoo_rpc_error", `Odoo RPC error (${errName}): ${detail}`);
    }

    return envelope;
  }

  async call(model, method, body = {}) {
    if (!/^[a-z0-9_.]+$/.test(model) || !/^[a-zA-Z0-9_]+$/.test(method)) {
      throw new AppError(400, "invalid_odoo_method", "Modelo o método de Odoo inválido.");
    }
    const uid = await this.authenticateLegacy();

    let positional = [];
    const keywords = {};

    if (method === "context_get" || method === "fields_get") {
      positional = [];
    } else if (method === "read") {
      positional = [body.ids || []];
    } else if (method === "search_read" || method === "search_count") {
      positional = [body.domain ?? []];
    } else if (method === "check_access_rights") {
      positional = [body.operation];
    } else if (method === "create") {
      if (Array.isArray(body.vals_list)) {
        const useMulti = Boolean(body._closed_model_create_multi);
        positional = [useMulti ? body.vals_list : (body.vals_list[0] || {})];
      } else {
        positional = [body.vals || {}];
      }
    } else if (method === "write") {
      positional = [body.ids || [], body.vals || {}];
    } else if (
      [
        "action_confirm",
        "button_confirm",
        "action_set_won",
        "action_set_lost",
        "action_assign",
        "button_validate",
        "action_post",
        "action_apply_inventory",
        "action_cancel",
        "button_cancel",
        "run",
        "button_immediate_install",
      ].includes(method)
    ) {
      positional = [body.ids || []];
    } else {
      positional = body.ids ? [body.ids] : [];
    }

    for (const [key, value] of Object.entries(body)) {
      if (["ids", "domain", "vals", "vals_list", "operation", "_closed_model_create_multi"].includes(key)) {
        continue;
      }
      if (value !== undefined && value !== null) {
        keywords[key] = value;
      }
    }

    const payload = {
      jsonrpc: "2.0",
      method: "call",
      params: {
        service: "object",
        method: "execute_kw",
        args: [this.database, uid, this.apiKey, model, method, positional, keywords],
      },
      id: randomUUID(),
    };

    const envelope = await this.sendJsonRpc(payload);
    return envelope?.result;
  }

  async searchRead(model, domain, fields, { limit = 10, offset = 0, order, context } = {}) {
    return this.call(model, "search_read", {
      domain,
      fields,
      limit,
      offset,
      ...(order ? { order } : {}),
      ...(context ? { context } : {}),
    });
  }

  async searchCount(model, domain, { context, limit } = {}) {
    return this.call(model, "search_count", {
      domain,
      ...(context ? { context } : {}),
      ...(limit ? { limit } : {}),
    });
  }

  async create(model, values, context = undefined) {
    const result = await this.call(model, "create", {
      vals_list: [values],
      ...(context ? { context } : {}),
    });
    // Si Odoo devuelve un solo ID entero (comportamiento tradicional de execute_kw create),
    // lo adaptamos para que devuelva un valor uniforme y predecible.
    return result;
  }

  async write(model, id, vals, context = undefined) {
    const recordId = Number(id);
    if (!Number.isInteger(recordId) || recordId <= 0) {
      throw new AppError(400, "invalid_res_id", "El ID del registro para la actualización es inválido.");
    }
    return this.call(model, "write", {
      ids: [recordId],
      vals,
      ...(context ? { context } : {}),
    });
  }

  async postChatterMessage(model, resId, body, { partnerIds = [], messageType = "comment" } = {}) {
    const id = Number(resId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError(400, "invalid_res_id", "El ID del registro para el mensaje de chatter es inválido.");
    }
    const values = {
      model,
      res_id: id,
      body: String(body),
      message_type: messageType,
    };
    if (Array.isArray(partnerIds) && partnerIds.length > 0) {
      const validPartners = partnerIds.map(Number).filter((p) => Number.isInteger(p) && p > 0);
      if (validPartners.length > 0) {
        values.partner_ids = [[6, 0, validPartners]];
      }
    }
    return this.create("mail.message", values);
  }
}

export class Odoo20McpClient {
  constructor({ baseUrl, apiKey, database = null, timeoutMs = 30_000 }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = apiKey;
    this.database = database;
    this.timeoutMs = timeoutMs;
    this.transport = "mcp_native";
  }

  async sendMcpRequest(method, params = {}) {
    const headers = {
      authorization: `bearer ${this.apiKey}`,
      "content-type": "application/json; charset=utf-8",
      accept: "application/json",
      "user-agent": "Pragmatic-Odoo-AI-Agent-Pilot/0.2",
    };
    if (this.database) headers["x-odoo-database"] = this.database;

    const payload = {
      jsonrpc: "2.0",
      method,
      params,
      id: randomUUID(),
    };

    const envelope = await fetchJson(
      `${this.baseUrl}/mcp`,
      { method: "POST", headers, body: JSON.stringify(payload) },
      this.timeoutMs,
    );

    if (envelope?.error) {
      const message = envelope.error.message || "Error al invocar servidor MCP de Odoo 20";
      throw new AppError(502, "odoo_mcp_error", message, envelope.error);
    }

    return envelope?.result ?? envelope;
  }

  async listTools() {
    const result = await this.sendMcpRequest("tools/list", {});
    return result?.tools ?? [];
  }

  async callTool(name, args = {}) {
    const result = await this.sendMcpRequest("tools/call", {
      name,
      arguments: args,
    });
    return result;
  }

  async getModels() {
    return this.callTool("get_models", {});
  }

  async getFields(model) {
    return this.callTool("get_fields", { model });
  }

  async search(model, domain = [], fields = [], limit = 10) {
    return this.callTool("search", { model, domain, fields, limit });
  }

  async readGroup(model, domain = [], groupby = [], fields = []) {
    return this.callTool("read_group", { model, domain, groupby, fields });
  }

  async retrieveInitialContext() {
    return this.callTool("retrieve_initial_context", {});
  }
}

export class OdooClient {
  constructor(adapter, mcpClient = null) {
    this.adapter = adapter;
    this.mcp = mcpClient;
    this.baseUrl = adapter.baseUrl;
    this.database = adapter.database;
    this.apiKey = adapter.apiKey;
    this.transport = adapter.transport;
  }

  call(model, method, body) {
    return this.adapter.call(model, method, body);
  }

  searchRead(model, domain, fields, options) {
    return this.adapter.searchRead(model, domain, fields, options);
  }

  searchCount(model, domain, options) {
    return this.adapter.searchCount(model, domain, options);
  }

  create(model, values, context) {
    return this.adapter.create(model, values, context);
  }

  write(model, id, vals, context) {
    return this.adapter.write(model, id, vals, context);
  }

  postChatterMessage(model, resId, body, options) {
    return this.adapter.postChatterMessage(model, resId, body, options);
  }
}

export function createOdooClient({
  baseUrl,
  database,
  apiKey,
  login = null,
  uid = null,
  transport = "auto",
  odooVersion = null,
  enableMcp = false,
  timeoutMs = 30_000,
}) {
  const normBaseUrl = normalizeBaseUrl(baseUrl);
  const series = parseMajorSeries(odooVersion);

  let chosenTransport = transport;
  if (!chosenTransport || chosenTransport === "auto") {
    if (isLegacyRpcSeries(series)) {
      chosenTransport = "legacy_rpc";
    } else {
      chosenTransport = "json2";
    }
  }

  let adapter;
  let mcpClient = null;

  if (chosenTransport === "legacy_rpc") {
    adapter = new OdooLegacyRpcClient({
      baseUrl: normBaseUrl,
      database,
      apiKey,
      login,
      uid,
      timeoutMs,
    });
  } else {
    adapter = new OdooJson2Client({
      baseUrl: normBaseUrl,
      database,
      apiKey,
      timeoutMs,
    });
  }

  if (enableMcp || chosenTransport === "mcp_native" || series === "20.0") {
    mcpClient = new Odoo20McpClient({
      baseUrl: normBaseUrl,
      apiKey,
      database,
      timeoutMs,
    });
  }

  return new OdooClient(adapter, mcpClient);
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
