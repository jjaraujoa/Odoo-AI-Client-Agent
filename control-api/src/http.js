import { AppError } from "./errors.js";

export async function readJson(request, maxBytes = 1_000_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new AppError(413, "payload_too_large", "La solicitud es demasiado grande.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "invalid_json", "El cuerpo no contiene JSON válido.");
  }
}

export function json(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

export async function fetchJson(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(options.headers ?? {}),
      },
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text.slice(0, 1000) };
    }
    if (!response.ok) {
      throw new AppError(502, "upstream_error", `Servicio externo respondió ${response.status}.`, {
        upstreamStatus: response.status,
        upstreamBody: scrubUpstream(body),
      });
    }
    return body;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(504, "upstream_timeout", "El servicio externo superó el tiempo máximo.");
    }
    if (error instanceof AppError) throw error;
    if (error instanceof TypeError) {
      throw new AppError(502, "upstream_unreachable", "No fue posible conectar con el servicio externo.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function scrubUpstream(body) {
  if (!body || typeof body !== "object") return body;
  const clone = structuredClone(body);
  for (const key of ["api_key", "token", "authorization", "password"]) {
    if (key in clone) clone[key] = "[REDACTADO]";
  }
  return clone;
}
