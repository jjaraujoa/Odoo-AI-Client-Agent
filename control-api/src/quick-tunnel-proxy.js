import http from "node:http";
import { pathToFileURL } from "node:url";

export const TELEGRAM_WEBHOOK_PATH = "/webhook/odoo-ai-telegram";

function forwardHeaders(headers) {
  const result = {};
  for (const name of [
    "content-type",
    "content-length",
    "user-agent",
    "x-telegram-bot-api-secret-token",
  ]) {
    if (headers[name] !== undefined) result[name] = headers[name];
  }
  return result;
}

export function createQuickTunnelProxy({
  targetHost = "127.0.0.1",
  targetPort = 5678,
  listenHost = "127.0.0.1",
  listenPort = 5680,
  maxBodyBytes = 1_048_576,
} = {}) {
  const server = http.createServer((request, response) => {
    let parsed;
    try {
      parsed = new URL(request.url ?? "/", "http://localhost");
    } catch {
      response.writeHead(400).end("Solicitud inválida.");
      return;
    }

    if (parsed.pathname !== TELEGRAM_WEBHOOK_PATH || parsed.search) {
      response.writeHead(404).end("No encontrado.");
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end("Método no permitido.");
      return;
    }

    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      response.writeHead(413).end("Solicitud demasiado grande.");
      request.resume();
      return;
    }

    let receivedBytes = 0;
    let completed = false;
    const upstream = http.request({
      hostname: targetHost,
      port: targetPort,
      method: "POST",
      path: TELEGRAM_WEBHOOK_PATH,
      headers: forwardHeaders(request.headers),
      timeout: 15_000,
    }, (upstreamResponse) => {
      completed = true;
      response.writeHead(upstreamResponse.statusCode ?? 502, {
        "content-type": upstreamResponse.headers["content-type"] ?? "text/plain; charset=utf-8",
      });
      upstreamResponse.pipe(response);
    });

    upstream.on("timeout", () => upstream.destroy(new Error("Tiempo de espera agotado.")));
    upstream.on("error", () => {
      if (!completed && !response.headersSent) {
        response.writeHead(502).end("El servicio interno no está disponible.");
      } else if (!response.writableEnded) {
        response.end();
      }
    });

    request.on("data", (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBodyBytes) {
        upstream.destroy();
        if (!response.headersSent) response.writeHead(413).end("Solicitud demasiado grande.");
        request.destroy();
      }
    });
    request.pipe(upstream);
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenPort, listenHost, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function main() {
  const proxy = createQuickTunnelProxy({
    listenPort: Number(process.env.QUICK_TUNNEL_PROXY_PORT ?? 5680),
    targetPort: Number(process.env.N8N_PORT ?? 5678),
  });
  const address = await proxy.listen();
  console.log(`Proxy temporal limitado a ${TELEGRAM_WEBHOOK_PATH} en 127.0.0.1:${address.port}.`);

  const stop = async () => {
    await proxy.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`No fue posible iniciar el proxy temporal: ${error.message}`);
    process.exit(1);
  });
}
