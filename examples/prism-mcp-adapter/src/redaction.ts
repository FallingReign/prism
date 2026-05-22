const secretPatterns = [
  /prism_dev_[A-Za-z0-9_-]+/g,
  /xox[baprs]-[A-Za-z0-9_-]+/gi,
  /(authorization:\s*bearer\s+)[^\s,}]+/gi,
  /(client[-_]?secret["'=:\s]+)[^"',}\s]+/gi,
  /(refresh[-_]?token["'=:\s]+)[^"',}\s]+/gi,
  /(access[-_]?token["'=:\s]+)[^"',}\s]+/gi
];

export function redactSecrets(value: unknown): string {
  let text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  for (const pattern of secretPatterns) {
    text = text.replace(pattern, "$1[redacted]");
  }
  return text;
}
