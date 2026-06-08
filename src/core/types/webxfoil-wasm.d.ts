declare module "webxfoil-wasm" {
  export interface XfoilRunRawOutput {
    stdout: string;
    stderr: string;
    exitCode: number;
  }

  export interface XfoilRunOutput {
    text: string;
    lines: string[];
    scalars: Record<string, { raw: string; value: number }>;
    hasNaN: boolean;
    hasFortranError: boolean;
    hasConvergenceFail: boolean;
  }

  export interface XfoilRunResult {
    raw: XfoilRunRawOutput;
    output: XfoilRunOutput;
  }

  export interface XfoilInput {
    readonly files: Array<{ path: string; data: string | Uint8Array }>;
    add(line: string | string[]): this;
    blank(count?: number): this;
    loadAirfoilText(text: string, options?: { path?: string; name?: string }): { name: string; format: string; path: string };
    naca(code: string): this;
    oper(): this;
    quit(): this;
    toString(): string;
  }

  export class WebXFOIL {
    static load(options?: Record<string, unknown>): Promise<WebXFOIL>;
    static input(lines?: string[]): XfoilInput;
    input(lines?: string[]): XfoilInput;
    run(sessionText: string, options?: { workDir?: string; files?: Array<{ path: string; data: string | Uint8Array }>; scalarKeys?: string[] }): XfoilRunResult;
    readFile(path: string, encoding?: "utf8" | "binary"): string | Uint8Array;
    destroy(): void;
  }
}
