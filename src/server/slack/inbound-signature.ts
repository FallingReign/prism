import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySlackInboundRequest({
  signingSecret,
  timestamp,
  signature,
  rawBody,
  now = new Date()
}: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  now?: Date;
}): boolean {
  if (!timestamp || !signature || !/^\d{10}$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(Math.floor(now.getTime() / 1000) - timestampSeconds) > 300) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}
