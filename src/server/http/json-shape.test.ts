import { describe, expect, it } from "vitest";

import { hasDuplicateJsonObjectKeys } from "./json-shape";

describe("strict JSON object shape", () => {
  it("rejects duplicate keys at any nesting depth", () => {
    expect(hasDuplicateJsonObjectKeys('{"clientId":"one","clientId":"two"}')).toBe(true);
    expect(hasDuplicateJsonObjectKeys('{"outer":{"code":"one","code":"two"}}')).toBe(true);
  });

  it("accepts valid JSON with keys reused only in separate objects", () => {
    expect(hasDuplicateJsonObjectKeys('[{"id":1},{"id":2}]')).toBe(false);
  });
});
