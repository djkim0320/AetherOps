export class DeterministicClock {
  private currentMs: number;

  constructor(
    startIso = "2026-01-01T00:00:00.000Z",
    private readonly tickMs = 1
  ) {
    this.currentMs = Date.parse(startIso);
    if (!Number.isFinite(this.currentMs)) throw new TypeError(`Invalid deterministic clock start: ${startIso}`);
    assertDuration(tickMs, "tickMs");
  }

  nowIso(): string {
    const value = new Date(this.currentMs).toISOString();
    this.currentMs += this.tickMs;
    return value;
  }

  peekIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  elapsedSince(startIso: string): number {
    const start = Date.parse(startIso);
    if (!Number.isFinite(start)) throw new TypeError(`Invalid deterministic elapsed start: ${startIso}`);
    return Math.max(0, this.currentMs - start);
  }

  advance(milliseconds: number): void {
    assertDuration(milliseconds, "milliseconds");
    this.currentMs += milliseconds;
  }

  async sleep(milliseconds: number): Promise<void> {
    this.advance(milliseconds);
  }
}

export class DeterministicIdGenerator {
  private state: number;
  private stableCounter = 0;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError("Deterministic ID seed must be a non-negative safe integer.");
    this.state = (seed || 0x9e3779b9) >>> 0;
  }

  nextUuid(): string {
    const bytes = Array.from({ length: 16 }, () => this.nextUint32() & 0xff);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  nextStableId(prefix: string): string {
    if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(prefix)) throw new TypeError(`Invalid deterministic ID prefix: ${prefix}`);
    this.stableCounter += 1;
    return `${prefix}-${this.stableCounter.toString().padStart(4, "0")}`;
  }

  private nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }
}

function assertDuration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`);
}
