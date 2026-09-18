import { describe, expect, it } from "vitest";

import { createPetfoodCompositionRulesPort } from "./petfoodCompositionRulesPort.js";
import { createPetfoodCompositionRulesPort as exportedCreatePetfoodCompositionRulesPort } from "./ports.js";

describe("commerce server ports surface", () => {
  it("re-exports the petfood composition adapter for cross-domain oracle tests", () => {
    expect(exportedCreatePetfoodCompositionRulesPort).toBe(createPetfoodCompositionRulesPort);
  });
});
