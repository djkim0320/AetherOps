import { rethrowAfterStartupCleanup } from "../composition/runtimeResourceCleanup.js";

export interface ListenServer {
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  listen(port: number, host: string, listener: () => void): unknown;
  close(listener: (error?: Error) => void): unknown;
}

interface ServerListenOptions<T> {
  server: ListenServer;
  port: number;
  host: string;
  beforeCleanup(): void;
  closeResources(): Promise<void>;
  onListening(): T;
}

interface ServerTransportInitializationOptions<T> {
  initialize(): T;
  beforeCleanup(): void;
  closeResources(): Promise<void>;
}

export async function initializeServerTransport<T>(options: ServerTransportInitializationOptions<T>): Promise<T> {
  try {
    return options.initialize();
  } catch (error) {
    return rethrowAfterStartupCleanup(prepareCleanup(toError(error), options.beforeCleanup), options.closeResources);
  }
}

export function listenHttpServer<T>(options: ServerListenOptions<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const rejectStartup = (error: Error, closeListeningServer = false): void => {
      if (settled) return;
      settled = true;
      options.server.off("error", rejectStartup);
      const cleanup = closeListeningServer ? () => closeServerAndResources(options.server, options.closeResources) : options.closeResources;
      void rethrowAfterStartupCleanup(prepareCleanup(error, options.beforeCleanup), cleanup).catch(reject);
    };
    const resolveStartup = (): void => {
      if (settled) return;
      try {
        const handle = options.onListening();
        settled = true;
        options.server.off("error", rejectStartup);
        resolve(handle);
      } catch (error) {
        rejectStartup(toError(error), true);
      }
    };
    try {
      options.server.once("error", rejectStartup);
      options.server.listen(options.port, options.host, resolveStartup);
    } catch (error) {
      rejectStartup(toError(error));
    }
  });
}

async function closeServerAndResources(server: ListenServer, closeResources: () => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  try {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    failures.push(error);
  }
  try {
    await closeResources();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, "Failed to close HTTP server startup resources.");
}

export function normalizeListenPort(value: number): number {
  if (Number.isSafeInteger(value) && value >= 0 && value <= 65_535) return value;
  const error = new RangeError("Web server port must be an integer between 0 and 65535.");
  (error as NodeJS.ErrnoException).code = "ERR_SOCKET_BAD_PORT";
  throw error;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function prepareCleanup(error: Error, beforeCleanup: () => void): Error {
  try {
    beforeCleanup();
    return error;
  } catch (cleanupPreparationError) {
    return new AggregateError([error, cleanupPreparationError], "Server startup failed while preparing runtime cleanup.", { cause: error });
  }
}
