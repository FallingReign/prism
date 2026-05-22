import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const envPath = ".env.local";
if (!existsSync(envPath)) process.exit(0);
const text = readFileSync(envPath, "utf8");
const keyMatch = text.match(/^PRISM_CREDENTIAL_ENCRYPTION_KEY=(.*)$/m);
const idMatch = text.match(/^PRISM_CREDENTIAL_ENCRYPTION_KEY_ID=(.*)$/m);
const pepperMatch = text.match(/^PRISM_DEVELOPER_TOKEN_PEPPER=(.*)$/m);
const pepperIdMatch = text.match(/^PRISM_DEVELOPER_TOKEN_PEPPER_ID=(.*)$/m);
const needsKey = !keyMatch || !keyMatch[1] || keyMatch[1].includes("replace-with");
const needsId = !idMatch || !idMatch[1] || idMatch[1].includes("replace-with");
const needsPepper = !pepperMatch || !pepperMatch[1] || pepperMatch[1].includes("replace-with");
const needsPepperId = !pepperIdMatch || !pepperIdMatch[1] || pepperIdMatch[1].includes("replace-with");
if (!needsKey && !needsId && !needsPepper && !needsPepperId) process.exit(0);
let next = text;
if (needsKey) {
  const line = `PRISM_CREDENTIAL_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`;
  next = keyMatch ? next.replace(/^PRISM_CREDENTIAL_ENCRYPTION_KEY=.*$/m, line) : `${next.replace(/\s*$/, "\n")}${line}\n`;
}
if (needsId) {
  const line = "PRISM_CREDENTIAL_ENCRYPTION_KEY_ID=local-dev-aes-gcm-v1";
  next = idMatch ? next.replace(/^PRISM_CREDENTIAL_ENCRYPTION_KEY_ID=.*$/m, line) : `${next.replace(/\s*$/, "\n")}${line}\n`;
}
if (needsPepper) {
  const line = `PRISM_DEVELOPER_TOKEN_PEPPER=${randomBytes(32).toString("base64url")}`;
  next = pepperMatch ? next.replace(/^PRISM_DEVELOPER_TOKEN_PEPPER=.*$/m, line) : `${next.replace(/\s*$/, "\n")}${line}\n`;
}
if (needsPepperId) {
  const line = "PRISM_DEVELOPER_TOKEN_PEPPER_ID=local-dev-pepper-v1";
  next = pepperIdMatch ? next.replace(/^PRISM_DEVELOPER_TOKEN_PEPPER_ID=.*$/m, line) : `${next.replace(/\s*$/, "\n")}${line}\n`;
}
writeFileSync(envPath, next, { mode: 0o600 });
console.log("Local credential and developer token config is ready.");
