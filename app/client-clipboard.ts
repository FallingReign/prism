"use client";

const clipboardWriteTimeoutMs = 1500;

export function copyTextToClipboard(text: string): Promise<void> {
  return copyText(text);
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("clipboard-write-timeout")), clipboardWriteTimeoutMs))
      ]);
      return;
    } catch {
      // Fall through to the selectable DOM fallback for insecure contexts and denied permissions.
    }
  }

  if (copyUsingSelection(text)) return;
  throw new Error("clipboard-write-failed");
}

function copyUsingSelection(text: string): boolean {
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.setAttribute("aria-hidden", "true");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  input.setSelectionRange(0, input.value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    input.remove();
  }
  return copied;
}
