import { describe, expect, it } from "vitest";
import { shouldPushEngineStateUpdate } from "./SnakeRoom.js";

describe("shouldPushEngineStateUpdate", () => {
  it("publishes when the simulation tick advances", () => {
    expect(shouldPushEngineStateUpdate(10, null, 11, null)).toBe(true);
  });

  it("publishes when a stale tick event is cleared without a new simulation tick", () => {
    expect(
      shouldPushEngineStateUpdate(
        12,
        {
          tick: 12,
          consumedFoodPosition: { x: 4, y: 6 },
          eliminatedSnakeIds: ["player2"],
        },
        12,
        null,
      ),
    ).toBe(true);
  });

  it("skips publishing when neither tick nor event state changed", () => {
    expect(
      shouldPushEngineStateUpdate(
        5,
        null,
        5,
        null,
      ),
    ).toBe(false);
  });
});
