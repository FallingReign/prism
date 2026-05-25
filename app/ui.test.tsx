import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LinkButton, Notice, Panel, StatusBadge, SummaryMetric } from "./ui";

describe("Prism website UI primitives", () => {
  it("renders shadcn-backed primitives without secret material", () => {
    const html = renderToStaticMarkup(
      <Panel title="Slack custody" eyebrow="Trust boundary" accent="primary">
        <StatusBadge tone="success">Linked and healthy</StatusBadge>
        <Notice tone="info" title="Server custody">
          Slack credentials stay with Prism.
        </Notice>
        <SummaryMetric label="Token profiles" value="2 active" detail="Least-privilege Local tool access" />
        <LinkButton href="/v1/slack/oauth/start">Reconnect Slack</LinkButton>
      </Panel>
    );

    expect(html).toContain('data-slot="card"');
    expect(html).toContain('data-slot="badge"');
    expect(html).toContain('data-slot="alert"');
    expect(html).toContain('data-slot="button"');
    expect(html).toContain("Linked and healthy");
    expect(html).toContain('href="/v1/slack/oauth/start"');
    expect(html).not.toMatch(/style=|xox[bp]-|refresh-secret|client_secret|access_token|prism_dev_/i);
  });
});
