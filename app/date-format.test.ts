import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatUtcDate, formatUtcDateTime } from "./date-format";

describe("Prism website date formatting", () => {
  it("formats dates and date-times deterministically for server and client rendering", () => {
    expect(formatUtcDate("2026-05-24T07:07:06.000Z")).toBe("2026-05-24");
    expect(formatUtcDateTime("2026-05-24T07:07:06.000Z")).toBe("2026-05-24 07:07:06 UTC");
    expect(formatUtcDate(null)).toBeNull();
    expect(formatUtcDateTime(null)).toBeNull();
  });

  it("keeps website panels off environment-dependent locale date formatting", () => {
    const panelSource = ["token-profiles-panel.tsx", "activity-audit-panel.tsx"]
      .map((file) => readFileSync(join(process.cwd(), "app", file), "utf8"))
      .join("\n");

    expect(panelSource).not.toMatch(/\.toLocale(?:Date)?String\(\s*\)/);
  });
});
