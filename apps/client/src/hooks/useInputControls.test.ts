import { describe, expect, it } from "vitest";
import { shouldUseTouchUi } from "./useInputControls.js";

describe("shouldUseTouchUi", () => {
  it("enables touch UI when the primary pointer is coarse", () => {
    expect(
      shouldUseTouchUi({
        hasTouchPoints: true,
        primaryCoarsePointer: true,
        anyCoarsePointer: true,
        primaryFinePointer: false,
        noHover: true,
      }),
    ).toBe(true);
  });

  it("keeps the desktop UI on hybrid devices with a fine primary pointer", () => {
    expect(
      shouldUseTouchUi({
        hasTouchPoints: true,
        primaryCoarsePointer: false,
        anyCoarsePointer: true,
        primaryFinePointer: true,
        noHover: false,
      }),
    ).toBe(false);
  });

  it("enables touch UI on touch-only browsers without a fine primary pointer", () => {
    expect(
      shouldUseTouchUi({
        hasTouchPoints: true,
        primaryCoarsePointer: false,
        anyCoarsePointer: false,
        primaryFinePointer: false,
        noHover: true,
      }),
    ).toBe(true);
  });
});
