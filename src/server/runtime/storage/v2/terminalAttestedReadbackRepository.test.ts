import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalAttestationRepository } from "./terminalAttestationRepository.js";
import type { TerminalResultReadbackRepository } from "./terminalResultReadbackRepository.js";

let database: DatabaseSync | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("terminal attested readback bounds", () => {
  it("rejects 513 attestation metadata rows before mapping or CAS I/O", () => {
    database = new DatabaseSync(":memory:");
    database.exec(`
      create table canonical_terminal_result_attestations (
        id text primary key,
        job_id text not null,
        subject_kind text not null,
        subject_id text not null
      )
    `);
    const insert = database.prepare("insert into canonical_terminal_result_attestations (id,job_id,subject_kind,subject_id) values (?,?,?,?)");
    for (let index = 0; index < 513; index += 1) {
      insert.run(`attestation-${index}`, "job-bounded-attestations", "artifact", `artifact-${index}`);
    }
    const repository = new TerminalAttestationRepository(database, undefined, undefined as unknown as TerminalResultReadbackRepository);
    expect(() => repository.listByJob("job-bounded-attestations")).toThrow(/bounded limit/i);
  });
});
