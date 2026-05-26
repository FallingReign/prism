import { readFileSync, writeFileSync } from "node:fs";

const path = "next-env.d.ts";
const devImport = 'import "./.next/dev/types/routes.d.ts";';
const buildImport = 'import "./.next/types/routes.d.ts";';
const content = readFileSync(path, "utf8");
const restored = content.replace(buildImport, devImport);

if (restored !== content) {
  writeFileSync(path, restored);
}
