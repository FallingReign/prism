export function formatUtcDate(value: string | null): string | null {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

export function formatUtcDateTime(value: string | null): string | null {
  if (!value) return null;
  const iso = new Date(value).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}
