import { expect, it } from "vitest";
import { createPlatformPostgresMigrationRunner, type PlatformPostgresMigrationRunnerOptions } from "@openlup/platform/migrations";
import { createPostgresMigrationRunner, type PostgresMigrationRunnerOptions } from "../../server/adapters/postgres/migrationRunner.js";

const env = { connectionString: "unused" };

it("retains null-option refusal before a migration port can be used", () => {
  expect(() => createPostgresMigrationRunner(env, null as unknown as PostgresMigrationRunnerOptions)).toThrow(TypeError);
});

it("reads inherited generation selection and guards it before deferred catalogue options", () => {
  const options = Object.create({
    installation: { generation: "unknown" },
    get root() { throw new Error("catalogue root was read before selection admission"); },
  }) as PostgresMigrationRunnerOptions;
  expect(() => createPostgresMigrationRunner(env, options)).toThrow("unknown platform migration generation");
});

it("requires a package installation selection before catalogue or pool work", () => {
  const options = {
    get catalog() { throw new Error("catalogue was read before selection admission"); },
    get poolFactory() { throw new Error("pool factory was read before selection admission"); },
  } as unknown as PlatformPostgresMigrationRunnerOptions;
  expect(() => createPlatformPostgresMigrationRunner(env, options)).toThrow("platform migration installation is required");
});
