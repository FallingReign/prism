import "server-only";

import { after } from "next/server";

export function scheduleAfterResponse(task: () => Promise<void>): void {
  after(task);
}
