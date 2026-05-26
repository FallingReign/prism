"use client";

const clipboardWriteTimeoutMs = 1500;

export function copyTextToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("clipboard-write-timeout")), clipboardWriteTimeoutMs);
    try {
      navigator.clipboard.writeText(text).then(resolve, reject).finally(() => window.clearTimeout(timeout));
    } catch (error) {
      window.clearTimeout(timeout);
      reject(error);
    }
  });
}
