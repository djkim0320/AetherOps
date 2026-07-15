const NACA_SERIES_PATTERN = /^(?:NACA\s*)?(\d{4,5})$/i;

export function isNacaSeries(value: string): boolean {
  return NACA_SERIES_PATTERN.test(value.trim());
}

/** Returns the canonical digits-only series consumed by every solver adapter. */
export function normalizeNacaSeries(value: string): string {
  const match = NACA_SERIES_PATTERN.exec(value.trim());
  if (!match?.[1]) throw new Error("NACA airfoil must be a 4 or 5 digit series, optionally prefixed by NACA.");
  return match[1];
}
