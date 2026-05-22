import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const envPath = ".env.local";
if (!existsSync(envPath)) process.exit(0);
const text = readFileSync(envPath, "utf8");
const keyMatch = text.match(/^PRISM_CREDENTIAL_ENCRYPTION_KEY=(.*)$/m);
const idMatch = text.match(/^PRISM_CREDENTIAL_ENCRYPTION_KEY_ID=(.*)$/m);
const needsKey = !keyMatch || !keyMatch[1] || keyMatch[1].includes("replace-with");
const needsId = !idMatch || !idMatch[1] || idMatch[1].includes("replace-with");
if (!needsKey && !needsId) process.exit(0);
let next = text;
if (needsKey) {
  const line = `PRISM_CREDENTIAL_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`;
  next = keyMatch ? next.replace(/^PRISM_CREDENTIAL_ENCRYPTION_KEY=.*$/m, line) : `${next.replace(/\s*$/, "\n")}${line}\n`;
}
if (needsId) {
  const line = "PRISM_CREDENTIAL_ENCRYPTION_KEY_ID=local-dev-aes-gcm-v1";
  next = idMatch ? next.replace(/^PRISM_CREDENTIAL_ENCRYPTION_KEY_ID=.*$/m, line) : `${next.replace(/\s*$/, "\n")}${line}\n`;
}
writeFileSync(envPath, next, { mode: 0o600 });
console.log("Local credential encryption config is ready.");
