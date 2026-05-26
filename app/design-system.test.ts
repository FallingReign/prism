import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Prism website design-system guard", () => {
  it("keeps app components on shared classes instead of inline styles", () => {
    const source = ["page.tsx", "slack-status-panel.tsx", "token-profiles-panel.tsx", "token-profile-detail-panel.tsx", "activity-audit-panel.tsx", "ui.tsx"]
      .map((file) => readFileSync(join(process.cwd(), "app", file), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/\sstyle=\{\{/);
  });

  it("uses Tailwind and real shadcn components as the website substrate", () => {
    const root = process.cwd();
    const css = readFileSync(join(root, "app", "globals.css"), "utf8");
    const postcss = readFileSync(join(root, "postcss.config.mjs"), "utf8");
    const componentsConfig = readFileSync(join(root, "components.json"), "utf8");
    const ui = readFileSync(join(root, "app", "ui.tsx"), "utf8");

    expect(css).toContain('@import "tailwindcss"');
    expect(postcss).toContain("@tailwindcss/postcss");
    expect(componentsConfig).toContain('"ui": "@/components/ui"');
    expect(existsSync(join(root, "components", "ui", "button.tsx"))).toBe(true);
    expect(existsSync(join(root, "components", "ui", "card.tsx"))).toBe(true);
    expect(ui).toContain("@/components/ui/button");
    expect(ui).toContain("@/components/ui/card");
  });

  it("maps Prism OKLCH tokens into shadcn variables and avoids banned styling patterns", () => {
    const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

    expect(css).toContain("oklch(");
    expect(css).toContain("@theme inline");
    expect(css).toContain("--color-background: var(--background)");
    expect(css).toContain("--color-card: var(--card)");
    expect(css).toContain("--color-border: var(--border)");
    expect(css).toContain("--font-heading: var(--font-sans)");
    expect(css).toContain("--radius-lg: var(--radius)");
    expect(css).toContain("--primary:");
    expect(css).toContain("--prism-success");
    expect(css).not.toMatch(/border-left:\s*[2-9]/);
    expect(css).not.toMatch(/border-right:\s*[2-9]/);
    expect(css).not.toMatch(/background-clip:\s*text/);
    expect(css).not.toMatch(/\.button--|\.panel--|\.status-badge--|\.choice-card|\.profile-card|\.activity-card|\.hero-panel/);
  });

  it("keeps Token profile interactions accessible on long forms", () => {
    const panel = readFileSync(join(process.cwd(), "app", "token-profile-detail-panel.tsx"), "utf8");

    expect(panel).toContain("min-h-11");
    expect(panel).toContain("grid gap-4 lg:grid-cols-2");
    expect(panel).toContain('role="alert"');
    expect(panel).toContain('aria-live="polite"');
    expect(panel).toContain("Rotating...");
    expect(panel).toContain("Updating...");
    expect(panel).toContain("Removing...");
  });
});
