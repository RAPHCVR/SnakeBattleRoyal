import { describe, expect, it } from "vitest";
import { computeArenaBoardLayout } from "./boardLayout.js";
import {
  alignWorldPosition,
  interpolateTimedWorld,
  resolveWrappedWorld,
  sampleBufferedWorld,
} from "./segmentMotion.js";

describe("segmentMotion", () => {
  const layout = computeArenaBoardLayout({
    width: 800,
    height: 800,
  });

  it("aligns a wrapped target to the closest world position", () => {
    expect(
      alignWorldPosition(layout, { x: 780, y: 220 }, { x: 0, y: 5 }),
    ).toEqual({ x: 820, y: 220 });

    expect(
      alignWorldPosition(layout, { x: 20, y: 220 }, { x: 19, y: 5 }),
    ).toEqual({ x: -20, y: 220 });
  });

  it("interpolates timed motion with clamped progress", () => {
    expect(
      interpolateTimedWorld(
        { x: 20, y: 220 },
        { x: 60, y: 220 },
        50,
        100,
      ),
    ).toEqual({ x: 40, y: 220 });

    expect(
      interpolateTimedWorld(
        { x: 20, y: 220 },
        { x: 60, y: 220 },
        150,
        100,
      ),
    ).toEqual({ x: 60, y: 220 });
  });

  it("samples buffered snapshots around the render timestamp", () => {
    expect(
      sampleBufferedWorld(
        [
          { atMs: 1_000, world: { x: 20, y: 220 } },
          { atMs: 1_100, world: { x: 60, y: 220 } },
        ],
        1_050,
      ),
    ).toEqual({ x: 40, y: 220 });

    expect(
      sampleBufferedWorld(
        [
          { atMs: 1_000, world: { x: 20, y: 220 } },
          { atMs: 1_100, world: { x: 60, y: 220 } },
        ],
        1_140,
      ),
    ).toEqual({ x: 60, y: 220 });
  });

  it("returns a ghost render when the segment moves outside the board", () => {
    expect(
      resolveWrappedWorld(layout, { x: -20, y: 220 }),
    ).toEqual({
      primary: { x: -20, y: 220 },
      ghost: { x: 780, y: 220 },
    });

    expect(
      resolveWrappedWorld(layout, { x: 300, y: 220 }),
    ).toEqual({
      primary: { x: 300, y: 220 },
      ghost: null,
    });
  });
});
