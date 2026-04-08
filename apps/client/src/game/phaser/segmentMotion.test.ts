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

    expect(
      alignWorldPosition(layout, { x: -780, y: 220 }, { x: 19, y: 5 }),
    ).toEqual({ x: -820, y: 220 });

    expect(
      alignWorldPosition(layout, { x: 1580, y: 220 }, { x: 0, y: 5 }),
    ).toEqual({ x: 1620, y: 220 });
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
    ).toEqual({
      world: { x: 40, y: 220 },
      mode: "interpolated",
      underrunMs: 0,
    });

    expect(
      sampleBufferedWorld(
        [
          { atMs: 1_000, world: { x: 20, y: 220 } },
          { atMs: 1_100, world: { x: 60, y: 220 } },
        ],
        1_140,
      ),
    ).toEqual({
      world: { x: 60, y: 220 },
      mode: "held-latest",
      underrunMs: 40,
    });
  });

  it("uses a short capped extrapolation before holding on the latest snapshot", () => {
    expect(
      sampleBufferedWorld(
        [
          { atMs: 1_000, world: { x: 20, y: 220 } },
          { atMs: 1_100, world: { x: 60, y: 220 } },
        ],
        1_120,
        {
          maxExtrapolationMs: 30,
          maxExtrapolationDistanceRatio: 0.34,
        },
      ),
    ).toEqual({
      world: { x: 68, y: 220 },
      mode: "extrapolated",
      underrunMs: 20,
    });

    expect(
      sampleBufferedWorld(
        [
          { atMs: 1_000, world: { x: 20, y: 220 } },
          { atMs: 1_100, world: { x: 60, y: 220 } },
        ],
        1_160,
        {
          maxExtrapolationMs: 30,
          maxExtrapolationDistanceRatio: 0.34,
        },
      ),
    ).toEqual({
      world: { x: 60, y: 220 },
      mode: "held-latest",
      underrunMs: 60,
    });
  });

  it("returns a ghost render when the segment moves outside the board", () => {
    expect(
      resolveWrappedWorld(layout, { x: -20, y: 220 }),
    ).toEqual({
      primary: { x: 780, y: 220 },
      ghost: null,
    });

    expect(
      resolveWrappedWorld(layout, { x: -10, y: 220 }),
    ).toEqual({
      primary: { x: 790, y: 220 },
      ghost: { x: -10, y: 220 },
    });

    expect(
      resolveWrappedWorld(layout, { x: -790, y: 220 }),
    ).toEqual({
      primary: { x: 810, y: 220 },
      ghost: { x: 10, y: 220 },
    });

    expect(
      resolveWrappedWorld(layout, { x: 300, y: -790 }),
    ).toEqual({
      primary: { x: 300, y: 810 },
      ghost: { x: 300, y: 10 },
    });

    expect(
      resolveWrappedWorld(layout, { x: 300, y: 220 }),
    ).toEqual({
      primary: { x: 300, y: 220 },
      ghost: null,
    });
  });
});
