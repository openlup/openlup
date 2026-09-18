import { describe, expect, it } from "vitest";
import { fadeUp } from "@/lib/animations";

describe("fadeUp", () => {
  it("defines the expected hidden and visible animation states", () => {
    expect(fadeUp).toEqual({
      hidden: { opacity: 0, y: 24 },
      visible: {
        opacity: 1,
        y: 0,
        transition: { duration: 0.5, ease: "easeOut" },
      },
    });
  });
});
