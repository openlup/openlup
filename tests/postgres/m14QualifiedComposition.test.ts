import { once } from "node:events";
import { beforeAll, describe, expect, it } from "vitest";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import {
  createQualifiedCompositionRegistrar,
  qualifiedCompositionProfiles,
  qualifiedCompositionShapes,
  startProof,
} from "./m14QualifiedComposition.fixture.js";

const registerCase = createQualifiedCompositionRegistrar();

it("joins an aborted proof child before returning ownership to the fixture", async () => {
  const controller = new AbortController();
  // Exit naturally in the baseline so a missing cancellation cannot leak the child.
  const { child, result } = startProof(["--eval", "setTimeout(() => {}, 1000)"], controller.signal);
  let closed = false;
  child.once("close", () => { closed = true; });
  await once(child, "spawn");
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(closed).toBe(true);
});

it("keeps the last sanitized proof phase at the child watchdog deadline", async () => {
  const controller = new AbortController();
  const { child, result } = startProof(["--eval",
    'console.error("untrusted test diagnostic"); console.error("qualification-phase issued-prefix start 0"); setTimeout(() => {}, 4000)'],
  controller.signal, "controlled-watchdog", 1_500);
  let closed = false;
  child.once("close", () => { closed = true; });
  const failure = await result.catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ message: expect.stringMatching(/cause=timeout phase=issued-prefix phaseMs=\d+ proofMs=\d+/u) });
  expect((failure as Error).message).not.toContain("untrusted test diagnostic");
  let owned = true;
  const container: PostgresContainer = {
    port: 5432,
    connectionString: "postgres://127.0.0.1/postgres",
    connectionStringFor: () => "postgres://127.0.0.1/postgres",
    async remove() {
      expect(closed).toBe(true);
      owned = false;
    },
  };
  await closePostgres(container);
  expect(owned).toBe(false);
});

it("keeps a proof assertion failure distinct from a watchdog", async () => {
  const { result } = startProof(["--eval",
    'console.error("qualification-phase current-suffix start 0\\nqualification-phase current-suffix assertion 1"); process.exitCode = 1'],
  new AbortController().signal);
  await expect(result).rejects.toThrow(/cause=assertion phase=current-suffix/u);
});

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Qualified production composition requires Docker PostgreSQL");
}, postgresSetupTimeoutMs);

// The reference shapes share the two-container ceiling; target bootstrap-restore runs sequentially after.
describe.sequential("reference shapes (max 2 containers)", () => {
  for (const shape of qualifiedCompositionShapes) {
    describe.concurrent(shape.name, () => registerCase(qualifiedCompositionProfiles[0], shape));
  }
});

describe.sequential("target bootstrap-restore shape (max 2 containers)", () => {
  describe(qualifiedCompositionShapes[0].name, () => registerCase(qualifiedCompositionProfiles[1], qualifiedCompositionShapes[0]));
});
