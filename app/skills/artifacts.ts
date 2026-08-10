import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type SkillBundleManifest = {
  schemaVersion: number;
  generatedFor: string;
  version: string;
  bundledSkills: Array<{ name: string; version: string; archivePath: string }>;
  archive: { file: string; path: string; sizeBytes: number; sha256: string };
  latestPath: string;
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
};

const artifactRoot = join(process.cwd(), ".artifacts", "skills");

export async function readSkillArtifact(file: string): Promise<Buffer | null> {
  if (file.includes("..") || file.includes("\\") || file.includes("/")) return null;
  try {
    return await readFile(join(artifactRoot, file));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function readSkillManifest(): Promise<{ bytes: Buffer; manifest: SkillBundleManifest } | null> {
  const bytes = await readSkillArtifact("manifest.json");
  if (!bytes) return null;
  try {
    const manifest = JSON.parse(bytes.toString("utf8")) as SkillBundleManifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.generatedFor !== "prism-slack" ||
      !manifest.archive ||
      typeof manifest.archive.file !== "string" ||
      typeof manifest.archive.sha256 !== "string"
    ) {
      return null;
    }
    return { bytes, manifest };
  } catch {
    return null;
  }
}

export function etagFor(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

export function revalidatingHeaders(contentType: string, etag?: string): Headers {
  const headers = new Headers({
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Content-Type": contentType
  });
  if (etag) headers.set("ETag", etag);
  return headers;
}

export function immutableHeaders(contentType: string, etag: string): Headers {
  return new Headers({
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": contentType,
    ETag: etag
  });
}

export function notFoundResponse(): Response {
  return new Response(JSON.stringify({ error: "Skill artifact not found." }), {
    status: 404,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }
  });
}

export function unavailableResponse(): Response {
  return new Response(JSON.stringify({ error: "Skill artifacts are not available." }), {
    status: 503,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }
  });
}

export function notModifiedResponse(headers: Headers): Response {
  return new Response(null, { status: 304, headers });
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
