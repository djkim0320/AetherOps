import { existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { boundedMatchingTerminalFiles, boundedTerminalFiles, removeTerminalFile } from "./terminalCasFilesystem.js";
import type { TerminalCasJournal } from "./terminalCasJournal.js";
import type { StorageTerminalCasObject, StorageTerminalCasReconciliationResult, StorageTerminalCasReferenceSource } from "./terminalCasTypes.js";

const LOCATOR_PATTERN = /^terminal-cas\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/;

export class TerminalCasReconciler {
  constructor(
    private readonly root: string,
    private readonly journal: TerminalCasJournal,
    private readonly verify: (object: StorageTerminalCasObject) => void
  ) {}

  cleanup(
    references: ReadonlySet<string> | StorageTerminalCasReferenceSource,
    maximumEntries: number
  ): { removedTemporary: number; removedOrphaned: number; complete: boolean } {
    assertPositiveBound(maximumEntries);
    const base = join(this.root, "terminal-cas");
    if (!existsSync(base)) return { removedTemporary: 0, removedOrphaned: 0, complete: true };
    const scan = boundedMatchingTerminalFiles(base, maximumEntries, realpathSync.native(base), (path) => {
      const locator = relative(this.root, path).split(sep).join("/");
      if (locator.startsWith("terminal-cas/tmp/") || locator.startsWith("terminal-cas/locks/")) return true;
      if (!LOCATOR_PATTERN.test(locator) || hasReference(references, locator)) return false;
      return !this.journal.hasPending(locator.slice(-64));
    });
    let removedTemporary = 0;
    let removedOrphaned = 0;
    for (const path of scan.files) {
      const locator = relative(this.root, path).split(sep).join("/");
      removeTerminalFile(path);
      if (locator.startsWith("terminal-cas/tmp/") || locator.startsWith("terminal-cas/locks/")) removedTemporary += 1;
      else if (LOCATOR_PATTERN.test(locator)) removedOrphaned += 1;
    }
    return { removedTemporary, removedOrphaned, complete: scan.complete };
  }

  reconcile(
    references: readonly StorageTerminalCasObject[] | StorageTerminalCasReferenceSource,
    maximumEntries: number
  ): StorageTerminalCasReconciliationResult {
    assertPositiveBound(maximumEntries);
    this.journal.recoverInterruptedLocks();
    const source = referenceSource(references);
    let verifiedReferenced = 0;
    for (const object of source.iterate()) {
      this.verify(object);
      verifiedReferenced += 1;
    }

    let reconciledJournals = 0;
    let journalsComplete = true;
    const directory = join(this.root, "terminal-cas", "journal");
    if (existsSync(directory)) {
      const journals = boundedTerminalFiles(directory, maximumEntries + 1, realpathSync.native(directory));
      journalsComplete = journals.length <= maximumEntries;
      for (const path of journals.slice(0, maximumEntries)) {
        const pending = this.journal.read(path);
        const durable = source.find(pending.casLocator);
        if (durable && (durable.casHash !== pending.casHash || durable.byteLength !== pending.byteLength)) {
          throw new Error("Canonical terminal CAS journal conflicts with its durable database receipt.");
        }
        if (durable) this.verify(durable);
        this.journal.remove(pending);
        reconciledJournals += 1;
      }
    }
    const cleanup = this.cleanup(source, maximumEntries);
    return { verifiedReferenced, reconciledJournals, ...cleanup, complete: journalsComplete && cleanup.complete };
  }
}

function referenceSource(references: readonly StorageTerminalCasObject[] | StorageTerminalCasReferenceSource): StorageTerminalCasReferenceSource {
  if (isReferenceSource(references)) return references;
  const objects = references as readonly StorageTerminalCasObject[];
  return {
    iterate: () => objects.values(),
    find(casLocator) {
      let selected: StorageTerminalCasObject | undefined;
      for (const object of objects) {
        if (object.casLocator !== casLocator) continue;
        if (selected && (selected.casHash !== object.casHash || selected.byteLength !== object.byteLength)) {
          throw new Error("Canonical terminal CAS locator has conflicting durable receipts.");
        }
        selected = object;
      }
      return selected;
    }
  };
}

function hasReference(references: ReadonlySet<string> | StorageTerminalCasReferenceSource, casLocator: string): boolean {
  return isReferenceSource(references) ? references.find(casLocator) !== undefined : references.has(casLocator);
}

function isReferenceSource(value: unknown): value is StorageTerminalCasReferenceSource {
  return Boolean(value && typeof value === "object" && "iterate" in value && "find" in value);
}

function assertPositiveBound(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Canonical terminal CAS cleanup bound is invalid.");
}
