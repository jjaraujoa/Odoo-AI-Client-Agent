import { createConnection } from "node:net";
import { AppError } from "./errors.js";

export function scanBuffer(data, { socketPath = "", host, port, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath ? { path: socketPath } : { host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AppError(503, "antivirus_timeout", "El antivirus no respondió a tiempo."));
    }, timeoutMs);
    const responseChunks = [];

    socket.on("connect", () => {
      socket.write(Buffer.from("zINSTREAM\0"));
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    socket.on("data", (chunk) => responseChunks.push(chunk));
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(new AppError(503, "antivirus_unavailable", "No fue posible conectar con el antivirus.", {
        reason: error.message,
      }));
    });
    socket.on("end", () => {
      clearTimeout(timer);
      const result = Buffer.concat(responseChunks).toString("utf8").replace(/\0/g, "").trim();
      if (result.endsWith("OK")) return resolve({ clean: true, result });
      if (result.includes("FOUND")) {
        return reject(new AppError(422, "malware_detected", "El archivo fue rechazado por el antivirus."));
      }
      return reject(new AppError(503, "antivirus_error", "El antivirus no pudo validar el archivo.", { result }));
    });
  });
}
