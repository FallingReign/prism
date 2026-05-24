import { describe, expect, it, vi } from "vitest";

import { createDefaultSlackWebApiClient, FetchSlackWebApiClient, MockSlackWebApiClient } from "./web-api-client";

describe("Slack Web API client", () => {
  it("uses real Slack forwarding by default and mock only by explicit config", () => {
    expect(createDefaultSlackWebApiClient({ mockWebApi: false })).toBeInstanceOf(FetchSlackWebApiClient);
    expect(createDefaultSlackWebApiClient({ mockWebApi: true })).toBeInstanceOf(MockSlackWebApiClient);
  });

  it("calls Slack with server-held credentials and GET query payloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, channels: [] }), {
        status: 200,
        headers: { "x-slack-req-id": "slack_req_1" }
      })
    );
    const client = new FetchSlackWebApiClient({ fetchImpl });

    const result = await client.callMethod({
      method: "conversations.list",
      httpMethod: "GET",
      payloadEncoding: "query",
      payload: { limit: "2", types: ["public_channel", "private_channel"], token: "local-tool-token-must-not-forward" },
      executionMode: "user",
      accessToken: "xoxp-server-held-token-canary"
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/conversations.list?limit=2&types=public_channel&types=private_channel");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer xoxp-server-held-token-canary" });
    expect((init as RequestInit).body).toBeUndefined();
    expect(result).toMatchObject({ status: 200, body: { ok: true, channels: [] } });
    expect(result.headers).toBeInstanceOf(Headers);
  });

  it("encodes POST JSON and form calls without forwarding Local-tool token fields", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: "1700000001.000200" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new FetchSlackWebApiClient({ fetchImpl });

    await client.callMethod({
      method: "chat.postMessage",
      httpMethod: "POST",
      payloadEncoding: "json",
      payload: { channel: "C123", text: "hello", token: "local-tool-token-must-not-forward" },
      executionMode: "bot",
      accessToken: "xoxb-server-held-token-canary"
    });
    await client.callMethod({
      method: "reactions.add",
      httpMethod: "POST",
      payloadEncoding: "form",
      payload: { channel: "C123", timestamp: "1700000001.000200", name: "eyes", token: "local-tool-token-must-not-forward" },
      executionMode: "bot",
      accessToken: "xoxb-server-held-token-canary"
    });

    const [, jsonInit] = fetchImpl.mock.calls[0]!;
    const [, formInit] = fetchImpl.mock.calls[1]!;
    expect((jsonInit as RequestInit).headers).toMatchObject({ "Content-Type": "application/json; charset=utf-8" });
    expect(String((jsonInit as RequestInit).body)).toBe(JSON.stringify({ channel: "C123", text: "hello" }));
    expect((formInit as RequestInit).headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(String((formInit as RequestInit).body)).toBe("channel=C123&timestamp=1700000001.000200&name=eyes");
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("local-tool-token-must-not-forward");
  });

  it("preserves Slack error responses and maps transport failures without leaking tokens", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
          status: 429,
          headers: { "retry-after": "30", "x-slack-req-id": "slack_req_429" }
        })
      )
      .mockResolvedValueOnce(new Response("not json", { status: 502 }))
      .mockRejectedValueOnce(new Error("network exposed xoxb-server-held-token-canary"));
    const client = new FetchSlackWebApiClient({ fetchImpl });

    const rateLimited = await client.callMethod({
      method: "chat.postMessage",
      httpMethod: "POST",
      payloadEncoding: "json",
      payload: { channel: "C123" },
      executionMode: "bot",
      accessToken: "xoxb-server-held-token-canary"
    });
    const badResponse = await client.callMethod({
      method: "chat.postMessage",
      httpMethod: "POST",
      payloadEncoding: "json",
      payload: { channel: "C123" },
      executionMode: "bot",
      accessToken: "xoxb-server-held-token-canary"
    });
    const unavailable = await client.callMethod({
      method: "chat.postMessage",
      httpMethod: "POST",
      payloadEncoding: "json",
      payload: { channel: "C123" },
      executionMode: "bot",
      accessToken: "xoxb-server-held-token-canary"
    });

    expect(rateLimited).toMatchObject({ status: 429, body: { ok: false, error: "rate_limited" } });
    expect((rateLimited.headers as Headers).get("retry-after")).toBe("30");
    expect((rateLimited.headers as Headers).get("x-slack-req-id")).toBe("slack_req_429");
    expect(badResponse).toEqual({ status: 502, body: { ok: false, error: "slack_bad_response" } });
    expect(unavailable).toEqual({ status: 503, body: { ok: false, error: "slack_unavailable" } });
  });
});
