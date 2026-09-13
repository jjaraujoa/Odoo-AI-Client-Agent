import { createHash, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";

const pem = await readFile(process.argv[2], "utf8");
const jwk = createPublicKey(pem).export({ format: "jwk" });
if (jwk.kty !== "RSA") throw new Error("La clave pública no es RSA.");
function fromBase64Url(value) {
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}
const materialFingerprint = createHash("sha256").update(Buffer.concat([
  fromBase64Url(jwk.n),
  Buffer.from([0]),
  fromBase64Url(jwk.e),
])).digest("hex");
process.stdout.write(`${JSON.stringify({
  format: "odooai-public-key",
  version: 1,
  algorithm: "RSA-3072-OAEP-SHA256",
  key_id: process.argv[3],
  material_fingerprint: materialFingerprint,
  n: jwk.n,
  e: jwk.e,
}, null, 2)}\n`);
