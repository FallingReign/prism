import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildInstallPrompt, SkillInstallCta } from "./skill-install-cta";

describe("Prism skill installation CTA", () => {
  it("builds the exact prompt from the browser origin", () => {
    expect(buildInstallPrompt("https://prism.example/")).toBe(
      "Go to https://prism.example/skills/install.md and follow the setup instructions."
    );
  });

  it("rejects an unavailable browser origin", () => {
    expect(() => buildInstallPrompt("null")).toThrow("browser origin");
    expect(() => buildInstallPrompt("file://")).toThrow("browser origin");
  });

  it("renders a selectable prompt without embedding a server origin", () => {
    const html = renderToStaticMarkup(<SkillInstallCta />);

    expect(html).toContain("Install Prism skill");
    expect(html).toContain("Open Prism from an HTTP(S) browser URL");
    expect(html).not.toContain("PRISM_PUBLIC_BASE_URL");
    expect(html).not.toContain("localhost");
    expect(html).not.toContain("http://");
  });
});
