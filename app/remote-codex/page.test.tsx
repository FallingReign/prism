import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RemoteCodexSetupView } from "./page";

describe("Remote Codex setup page", () => {
  it("gives a non-technical install, connect, and share path", () => {
    const html = renderToStaticMarkup(
      <RemoteCodexSetupView installerUrl="https://downloads.example/PrismCompanionSetup.exe" />
    );
    expect(html).toContain("Use your Codex sessions in Slack");
    expect(html).toContain("Download Prism Companion");
    expect(html).toContain("Connect to Prism");
    expect(html).toContain("status only");
    expect(html).not.toMatch(/terminal|command prompt|copy.*token/i);
  });
});
