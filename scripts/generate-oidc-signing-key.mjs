import { existsSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";

const outputPath = resolve(process.argv[2] || ".env.oidc.local");
if (existsSync(outputPath) && !process.argv.includes("--force")) {
  throw new Error(`Refusing to overwrite existing OIDC key file: ${outputPath}`);
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const keyBase64 = Buffer.from(privateKeyPem, "utf8").toString("base64");
const keyId = `local-rs256-${Date.now().toString(36)}`;
const contents = [
  `PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64=${keyBase64}`,
  `PRISM_OIDC_SIGNING_KEY_ID=${keyId}`,
  ""
].join("\n");

writeFileSync(outputPath, contents, { encoding: "utf8", mode: 0o600 });
console.log(`Generated OIDC signing configuration at ${outputPath}`);
