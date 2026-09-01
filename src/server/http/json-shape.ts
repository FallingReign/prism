/** Reject malformed JSON and duplicate object keys before JSON.parse can apply last-key wins. */
export function hasDuplicateJsonObjectKeys(raw: string): boolean {
  let index = 0;
  const skipWhitespace = () => { while (/\s/.test(raw[index] ?? "")) index += 1; };
  const stringToken = (): string | null => {
    if (raw[index] !== '"') return null;
    const start = index;
    index += 1;
    while (index < raw.length) {
      if (raw[index] === "\\") { index += 2; continue; }
      if (raw[index] === '"') {
        index += 1;
        try { return JSON.parse(raw.slice(start, index)); } catch { return null; }
      }
      index += 1;
    }
    return null;
  };
  const value = (): boolean => {
    skipWhitespace();
    if (raw[index] === "{") {
      index += 1;
      const seen = new Set<string>();
      skipWhitespace();
      if (raw[index] === "}") { index += 1; return false; }
      while (index < raw.length) {
        skipWhitespace();
        const key = stringToken();
        if (key === null || seen.has(key)) return true;
        seen.add(key);
        skipWhitespace();
        if (raw[index++] !== ":" || value()) return true;
        skipWhitespace();
        if (raw[index] === "}") { index += 1; return false; }
        if (raw[index++] !== ",") return true;
      }
      return true;
    }
    if (raw[index] === "[") {
      index += 1;
      skipWhitespace();
      if (raw[index] === "]") { index += 1; return false; }
      while (index < raw.length) {
        if (value()) return true;
        skipWhitespace();
        if (raw[index] === "]") { index += 1; return false; }
        if (raw[index++] !== ",") return true;
      }
      return true;
    }
    if (raw[index] === '"') return stringToken() === null;
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(index));
    if (!match) return true;
    index += match[0].length;
    return false;
  };
  const invalidOrDuplicate = value();
  skipWhitespace();
  return invalidOrDuplicate || index !== raw.length;
}
