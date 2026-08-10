import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it, beforeAll } from "vitest";

import { GET as getInstall } from "./install.md/route";
import { GET as getManifest } from "./manifest.json/route";
import { GET as getLatest } from "./latest.zip/route";
import { GET as getArchive } from "./archive/[file]/route";

describe("hosted Prism skill artifacts", () => {
  beforeAll(() => {
    execFileSync(process.execPath, ["scripts/build-skill-bundle.mjs"], { stdio: "ignore" });
  });

  it("serves human- and agent-readable installation instructions", async () => {
    const response = await getInstall(new Request("http://prism.test/skills/install.md"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(body).toContain("/skills/manifest.json");
    expect(body).toContain("/skills/latest.zip");
    expect(body).not.toMatch(/https?:\/\//);
  });

  it("serves a manifest matching the generated archive", async () => {
    const response = await getManifest(new Request("http://prism.test/skills/manifest.json"));
    const body = await response.json();
    const archive = await readFile(".artifacts/skills/latest.zip");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(body.archive.sizeBytes).toBe(archive.length);
    expect(body.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("revalidates latest and serves immutable versioned archives", async () => {
    const latest = await getLatest(new Request("http://prism.test/skills/latest.zip"));
    const etag = latest.headers.get("etag");
    const notModified = await getLatest(new Request("http://prism.test/skills/latest.zip", { headers: { "if-none-match": etag ?? "" } }));
    const manifest = JSON.parse(await (await getManifest(new Request("http://prism.test/skills/manifest.json"))).text());
    const versioned = await getArchive(new Request("http://prism.test/skills/archive/file"), { params: { file: manifest.archive.file } });

    expect(latest.status).toBe(200);
    expect(latest.headers.get("content-type")).toBe("application/zip");
    expect(latest.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(notModified.status).toBe(304);
    expect(versioned.status).toBe(200);
    expect(versioned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("does not expose unknown archive paths", async () => {
    const unknown = await getArchive(new Request("http://prism.test/skills/archive/unknown.zip"), { params: { file: "unknown.zip" } });

    expect(unknown.status).toBe(404);
  });
});
