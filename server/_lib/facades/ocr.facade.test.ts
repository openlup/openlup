import { describe, expect, it } from "vitest";

import { readOpenAiApiKey } from "./ocr.facade.js";

describe("OCR OpenAI env resolution", () => {
  it("prefers the neutral OPENAI_API_KEY", () => {
    expect(
      readOpenAiApiKey({
        OPENAI_API_KEY: "neutral-key",
        openlup_openai_api_key: "legacy-key",
      }),
    ).toBe("neutral-key");
  });

  it("ignores the retired legacy openlup key", () => {
    expect(() => readOpenAiApiKey({ openlup_openai_api_key: "legacy-key" })).toThrow(
      "OPENAI_API_KEY missing",
    );
  });

  it("fails with the neutral env name when neither key is configured", () => {
    expect(() => readOpenAiApiKey({})).toThrow("OPENAI_API_KEY missing");
  });
});
