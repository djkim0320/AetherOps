interface RegisteredResource {
  name: string;
  close: () => void | Promise<void>;
}

export async function closeResourcesInOrder(resources: RegisteredResource[]): Promise<void> {
  const failures: Array<{ name: string; error: unknown }> = [];
  for (const resource of resources) {
    try {
      await resource.close();
    } catch (error) {
      failures.push({ name: resource.name, error });
    }
  }
  if (failures.length) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `Failed to close server resources: ${failures.map((failure) => failure.name).join(", ")}`
    );
  }
}

export async function rethrowAfterStartupCleanup(error: unknown, closeResources: () => Promise<void>): Promise<never> {
  try {
    await closeResources();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "Server startup failed and one or more runtime resources could not be closed.", { cause: cleanupError });
  }
  throw error;
}

export class StartupResourceRegistry {
  private controller: RegisteredResource | undefined;
  private readonly dependencies: RegisteredResource[] = [];
  private closePromise: Promise<void> | undefined;

  registerController(name: string, close: RegisteredResource["close"]): void {
    this.assertOpen();
    if (this.controller) throw new Error(`Startup controller is already registered: ${this.controller.name}`);
    this.controller = { name, close };
  }

  registerDependency(name: string, close: RegisteredResource["close"]): void {
    this.assertOpen();
    this.dependencies.push({ name, close });
  }

  readonly close = (): Promise<void> => {
    this.closePromise ??= closeResourcesInOrder([...(this.controller ? [this.controller] : []), ...[...this.dependencies].reverse()]);
    return this.closePromise;
  };

  private assertOpen(): void {
    if (this.closePromise) throw new Error("Cannot register a server resource after cleanup has started.");
  }
}

export async function initializeStartupResources<T>(registry: StartupResourceRegistry, initialize: () => Promise<T>): Promise<T> {
  try {
    return await initialize();
  } catch (error) {
    return rethrowAfterStartupCleanup(error, registry.close);
  }
}
