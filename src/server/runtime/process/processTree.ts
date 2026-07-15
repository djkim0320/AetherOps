import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessTreeTerminationOptions {
  graceMs?: number;
  forceWaitMs?: number;
  platform?: NodeJS.Platform;
}

export async function terminateProcessTree(child: ChildProcess, options: ProcessTreeTerminationOptions = {}): Promise<void> {
  if (!child.pid || childExited(child)) return;
  const graceMs = positiveDuration(options.graceMs, 5_000);
  const forceWaitMs = positiveDuration(options.forceWaitMs, 1_000);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    // Windows has no reliable non-forcing process-group signal for detached
    // console children. Force the complete tree immediately rather than
    // leaving descendants able to mutate outputs during a nominal grace wait.
    try {
      await runTaskkill(child.pid, true);
    } catch (error) {
      // taskkill can race with a process that exits after the initial state
      // check. Only suppress that failure after observing the child exit.
      if (await waitForExit(child, forceWaitMs)) return;
      throw error;
    }
  } else {
    signalProcessGroup(child, "SIGTERM");
    if (await waitForExit(child, graceMs)) return;
    signalProcessGroup(child, "SIGKILL");
  }
  if (!(await waitForExit(child, forceWaitMs)) && !childExited(child)) {
    throw new Error(`Process tree ${child.pid} did not terminate after forced shutdown.`);
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-(child.pid as number), signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between the state check and the signal.
    }
  }
}

function runTaskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])];
    const killer = spawn("taskkill.exe", args, { stdio: "ignore", windowsHide: true });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      killer.kill();
      finish(new Error(`taskkill timed out while terminating process tree ${pid}.`));
    }, 5_000);
    timeout.unref();
    killer.once("error", (error) => finish(error));
    killer.once("close", (code) => finish(code === 0 ? undefined : new Error(`taskkill failed for process tree ${pid} with exit code ${code ?? "none"}.`)));
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("close", onClose);
      resolve(exited || childExited(child));
    };
    const onClose = (): void => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref();
    child.once("close", onClose);
  });
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
