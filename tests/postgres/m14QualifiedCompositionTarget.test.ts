import { beforeAll, describe } from "vitest";
import { dockerAvailable, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import {
  createQualifiedCompositionRegistrar,
  qualifiedCompositionProfiles,
  qualifiedCompositionShapes,
} from "./m14QualifiedComposition.fixture.js";

const registerCase = createQualifiedCompositionRegistrar();

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Qualified production composition requires Docker PostgreSQL");
}, postgresSetupTimeoutMs);

// Target separate-restore cases run sequentially, including the independently installed two-cluster checkout proof.
describe.sequential("target separate-restore shapes (max 2 containers)", () => {
  describe(qualifiedCompositionShapes[1].name, () => registerCase(qualifiedCompositionProfiles[1], qualifiedCompositionShapes[1]));
  describe("separate-restore checkout discriminators", () => registerCase(qualifiedCompositionProfiles[1], qualifiedCompositionShapes[1], true));
});
