#!/usr/bin/env node

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const defaultSourceRoot = join(repositoryRoot, ".agents", "skills", "prism-slack");
const defaultOutputRoot = join(repositoryRoot, ".artifacts", "skills");

const installInstructions = `# Install the Prism agent skill

You are installing the public Prism agent skill bundle. This document contains
the complete procedure. The bundle contains skill instructions and helper code
only; it never contains Prism developer tokens, Slack credentials, or user data.

## 1. Resolve the Prism origin

Use the origin that you fetched this document from. Resolve the root-relative
URLs below against that same origin:

- \`/skills/manifest.json\`
- \`/skills/latest.zip\`

If the origin is not available from the fetch context, use the origin included
in the user's install prompt. Only when neither source is available, inspect
an existing \`prism-slack/config.json\` and use its \`origin\` after checking
it. Otherwise ask the user for the Prism origin. Never let stale local
configuration override the fetched or prompted origin, guess a host, or assume
localhost.

## 2. Read and verify the manifest

Fetch \`/skills/manifest.json\` and read its \`version\`, \`archive\`, and
\`files\` fields. Download the archive at \`/skills/latest.zip\` or the
immutable path in \`archive.path\`. Compute its SHA-256 and stop if it does not
match \`archive.sha256\`. The archive is public and contains no secrets.

## 3. Choose the installation scope

Ask the user whether to install the skill project-locally or globally:

- Project-local: the current project’s \`.agents/skills/prism-slack\`, when the
  receiving agent supports the Agent Skills layout.
- Global: the receiving agent’s documented user-level skill folder.

Use \`.agents/skills\` when it is compatible with the receiving agent. If it is
not compatible, use that agent’s own documented skill folder. Never guess a
client-specific directory; ask the user when the convention is unknown.

## 4. Stage and validate the archive

Extract into a staging directory on the same volume as the target. Reject any
archive entry that is absolute, contains \`..\`, a drive letter, a backslash, a
symlink, or is outside the top-level \`prism-slack/\` directory. Verify every
file hash against the manifest’s \`files\` list. On any failure, remove only
the staging directory and leave an existing installation untouched.

## 5. Replace only after approval

If the target already exists, show its installed version and the new manifest
version, warn that the existing skill will be replaced, and ask for approval.
Do not silently no-op or overwrite. On approval, copy the existing
\`config.json\` byte-for-byte into staging, then rename the old target to a
timestamped backup sibling and rename staging to the target. Verify the new
target's \`SKILL.md\`, \`VERSION\`, manifest hashes, and preserved
\`config.json\` before deleting the backup. If either rename or any
post-swap verification fails, remove only the incomplete new target, rename
the backup back to the target, and remove staging/backup residue. Never leave
the old target moved away without restoring it.

The skill-local \`config.json\` contains only \`origin\`, \`configured\`, and
\`verifiedAt\`. If its origin differs from the origin used for this install,
show both origins and ask before changing it. Use the helper's normalized
origin comparison for any existing \`PRISM_BASE_URL\` without modifying the
environment; ask before using a different value. Do not migrate or delete
unrelated legacy marker files.

If a stored credential is already present, verify it without asking for the
copy-once token again. If it is not ready, fix the Prism connection or ask for
approval before rerunning the helper with \`--replace\` to enter a replacement
token.

## 6. Continue with Prism onboarding

Reload the installed \`prism-slack\` skill and follow its normal onboarding
flow. It checks health before requesting a secret, uses the Prism website for
Slack OAuth and copy-once developer-token creation, stores that token in the
local Windows Credential Manager helper, and keeps all Slack sends
confirmation-gated. HTTP is acceptable for an explicitly configured internal
pilot; HTTPS is recommended for public deployments.
`;

const fixedDosTime = 0;
const fixedDosDate = 33;

export async function buildSkillBundle({
  sourceRoot = defaultSourceRoot,
  outputRoot = defaultOutputRoot
} = {}) {
  const version = (await readFile(join(sourceRoot, "VERSION"), "utf8")).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Skill VERSION must contain a semantic version such as 1.0.0.");
  }

  const files = await collectSkillFiles(sourceRoot);
  const entries = files.map(({ archivePath, bytes }) => ({
    name: archivePath,
    bytes,
    sha256: sha256(bytes)
  }));
  const archive = createZip([
    { name: "prism-slack/", bytes: Buffer.alloc(0), directory: true },
    ...directoryEntries(entries),
    ...entries
  ]);
  const archiveFile = `prism-slack-${version}.zip`;
  const archiveHash = sha256(archive);
  const manifest = {
    schemaVersion: 1,
    generatedFor: "prism-slack",
    version,
    bundledSkills: [
      {
        name: "prism-slack",
        version,
        archivePath: `/skills/archive/${archiveFile}`
      }
    ],
    archive: {
      file: archiveFile,
      path: `/skills/archive/${archiveFile}`,
      sizeBytes: archive.length,
      sha256: archiveHash
    },
    latestPath: "/skills/latest.zip",
    files: entries.map(({ name, bytes, sha256: fileHash }) => ({
      path: name,
      sizeBytes: bytes.length,
      sha256: fileHash
    }))
  };

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, archiveFile), archive);
  await writeFile(join(outputRoot, "latest.zip"), archive);
  await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outputRoot, "install.md"), installInstructions);
  return { archive, manifest, installInstructions };
}

async function collectSkillFiles(sourceRoot) {
  const result = [];
  await walk(sourceRoot, sourceRoot, result);
  return result.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
}

async function walk(root, current, result) {
  const children = await readdir(current, { withFileTypes: true });
  for (const child of children) {
    const absolutePath = join(current, child.name);
    const relativePath = relative(root, absolutePath);
    const pathParts = relativePath.split(sep);
    if (pathParts.some((part) => part.startsWith(".") || part === "__pycache__" || part === "config.json" || part === "credentials.json" || part.endsWith(".pyc") || part.startsWith(".env"))) {
      continue;
    }
    const fileStats = await lstat(absolutePath);
    if (fileStats.isSymbolicLink()) {
      throw new Error(`Skill bundle cannot include symlinks: ${relativePath}`);
    }
    if (fileStats.isDirectory()) {
      if (pathParts.length === 1 && !["scripts", "references"].includes(child.name)) {
        throw new Error(`Unexpected skill directory: ${relativePath}`);
      }
      await walk(root, absolutePath, result);
      continue;
    }
    if (!fileStats.isFile()) {
      throw new Error(`Skill bundle cannot include special files: ${relativePath}`);
    }
    if (pathParts.length === 1 && !["SKILL.md", "VERSION"].includes(child.name)) {
      throw new Error(`Unexpected skill file: ${relativePath}`);
    }
    if (pathParts.length > 1 && pathParts[0] === "scripts" && !child.name.endsWith(".py")) {
      throw new Error(`Only Python files are allowed under scripts/: ${relativePath}`);
    }
    if (pathParts.length > 1 && !["scripts", "references"].includes(pathParts[0])) {
      throw new Error(`Unexpected skill path: ${relativePath}`);
    }
    const bytes = await readFile(absolutePath);
    if (/\b(?:prism_dev_[A-Za-z0-9_-]{32,}|xox[abpr]-[A-Za-z0-9-]{10,})\b/i.test(bytes.toString("utf8"))) {
      throw new Error(`Skill bundle contains secret-shaped content: ${relativePath}`);
    }
    result.push({ archivePath: `prism-slack/${relativePath.split(sep).join("/")}`, bytes });
  }
}

function directoryEntries(entries) {
  const directories = new Set();
  for (const entry of entries) {
    const parts = entry.name.split("/");
    parts.pop();
    for (let index = 1; index <= parts.length; index += 1) {
      directories.add(`${parts.slice(0, index).join("/")}/`);
    }
  }
  return [...directories]
    .filter((name) => name !== "prism-slack/")
    .sort()
    .map((name) => ({ name, bytes: Buffer.alloc(0), directory: true }));
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const bytes = entry.directory ? Buffer.alloc(0) : entry.bytes;
    const compressed = entry.directory ? bytes : deflateRawSync(bytes, { level: 9 });
    const crc = crc32(bytes);
    const localHeader = Buffer.alloc(30 + name.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x800, 6);
    localHeader.writeUInt16LE(entry.directory ? 0 : 8, 8);
    localHeader.writeUInt16LE(fixedDosTime, 10);
    localHeader.writeUInt16LE(fixedDosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(bytes.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    name.copy(localHeader, 30);
    localParts.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + name.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x800, 8);
    centralHeader.writeUInt16LE(entry.directory ? 0 : 8, 10);
    centralHeader.writeUInt16LE(fixedDosTime, 12);
    centralHeader.writeUInt16LE(fixedDosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(bytes.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    name.copy(centralHeader, 46);
    centralParts.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  buildSkillBundle().catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not build the skill bundle.");
    process.exitCode = 1;
  });
}
