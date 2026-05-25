import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Prism website design-system guard", () => {
  it("keeps app components on shared classes instead of inline styles", () => {
    const source = ["page.tsx", "slack-status-panel.tsx", "token-profiles-panel.tsx", "activity-audit-panel.tsx", "ui.tsx"]
      .map((file) => readFileSync(join(process.cwd(), "app", file), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/\sstyle=\{\{/);
  });

  it("uses OKLCH design tokens and avoids banned notice side stripes", () => {
    const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

    expect(css).toContain("oklch(");
    expect(css).toContain("--prism-primary");
    expect(css).not.toMatch(/border-left:\s*[2-9]/);
    expect(css).not.toMatch(/background-clip:\s*text/);
  });

  it("keeps Token profile interactions accessible on long forms", () => {
    const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
    const panel = readFileSync(join(process.cwd(), "app", "token-profiles-panel.tsx"), "utf8");

    expect(css).toMatch(/\.checkbox-grid label,[\s\S]*min-height:\s*44px/);
    expect(css).toMatch(/\.preset-grid,[\s\S]*grid-template-columns:\s*1fr/);
    expect(css).not.toMatch(/\.product-header\s*\{[\s\S]*position:\s*sticky/);
    expect(panel).toContain('role="alert"');
    expect(panel).toContain('aria-live="polite"');
    expect(panel).toContain("Rotating...");
    expect(panel).toContain("Updating...");
    expect(panel).toContain("Revoking...");
  });
});
