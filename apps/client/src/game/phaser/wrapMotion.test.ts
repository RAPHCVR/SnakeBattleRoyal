import { describe, expect, it } from "vitest";
import { computeArenaBoardLayout } from "./boardLayout.js";
import { computeWrapTweenPlan } from "./wrapMotion.js";

describe("computeWrapTweenPlan", () => {
  const layout = computeArenaBoardLayout({
    width: 800,
    height: 800,
  });

  it("builds a continuous horizontal wrap tween from right to left", () => {
    const plan = computeWrapTweenPlan(layout, { x: 19, y: 5 }, { x: 0, y: 5 });

    expect(plan).toEqual({
      primaryStart: { x: -20, y: 220 },
      primaryTarget: { x: 20, y: 220 },
      ghostStart: { x: 780, y: 220 },
      ghostTarget: { x: 820, y: 220 },
    });
  });

  it("builds a continuous vertical wrap tween from top to bottom", () => {
    const plan = computeWrapTweenPlan(layout, { x: 7, y: 0 }, { x: 7, y: 19 });

    expect(plan).toEqual({
      primaryStart: { x: 300, y: 820 },
      primaryTarget: { x: 300, y: 780 },
      ghostStart: { x: 300, y: 20 },
      ghostTarget: { x: 300, y: -20 },
    });
  });

  it("returns null for a non-wrapped move", () => {
    expect(computeWrapTweenPlan(layout, { x: 8, y: 5 }, { x: 9, y: 5 })).toBeNull();
  });
});
