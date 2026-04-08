import type { GridPosition } from "@snake-duel/shared";
import { toBoardPosition, type ArenaBoardLayout } from "./boardLayout.js";

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

export interface BufferedWorldSample {
  readonly atMs: number;
  readonly world: WorldPoint;
}

export type BufferedWorldSampleMode =
  | "clamped-start"
  | "interpolated"
  | "extrapolated"
  | "held-latest";

export interface BufferedWorldResult {
  readonly world: WorldPoint;
  readonly mode: BufferedWorldSampleMode;
  readonly underrunMs: number;
}

export interface WrapRenderState {
  readonly primary: WorldPoint;
  readonly ghost: WorldPoint | null;
}

export function alignWorldPosition(
  layout: ArenaBoardLayout,
  anchorWorld: WorldPoint,
  target: GridPosition,
): WorldPoint {
  const base = toBoardPosition(layout, target);
  return {
    x: alignWrappedAxis(anchorWorld.x, base.x, layout.boardWidth),
    y: alignWrappedAxis(anchorWorld.y, base.y, layout.boardHeight),
  };
}

export function interpolateTimedWorld(
  start: WorldPoint,
  target: WorldPoint,
  elapsedMs: number,
  durationMs: number,
): WorldPoint {
  if (durationMs <= 0) {
    return { ...target };
  }

  const progress = clamp(elapsedMs / durationMs, 0, 1);
  return {
    x: linear(start.x, target.x, progress),
    y: linear(start.y, target.y, progress),
  };
}

export function sampleBufferedWorld(
  snapshots: readonly BufferedWorldSample[],
  renderAtMs: number,
  options: {
    readonly maxExtrapolationMs?: number;
    readonly maxExtrapolationDistanceRatio?: number;
  } = {},
): BufferedWorldResult | null {
  if (snapshots.length === 0) {
    return null;
  }

  if (snapshots.length === 1 || renderAtMs <= snapshots[0]!.atMs) {
    return {
      world: { ...snapshots[0]!.world },
      mode: "clamped-start",
      underrunMs: 0,
    };
  }

  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const next = snapshots[index];
    if (!previous || !next) {
      continue;
    }

    if (renderAtMs <= next.atMs) {
      const spanMs = Math.max(1, next.atMs - previous.atMs);
      const progress = clamp((renderAtMs - previous.atMs) / spanMs, 0, 1);
      return {
        world: {
          x: linear(previous.world.x, next.world.x, progress),
          y: linear(previous.world.y, next.world.y, progress),
        },
        mode: "interpolated",
        underrunMs: 0,
      };
    }
  }

  const latest = snapshots[snapshots.length - 1]!;
  const underrunMs = Math.max(0, renderAtMs - latest.atMs);
  const maxExtrapolationMs = Math.max(0, Math.round(options.maxExtrapolationMs ?? 0));
  const maxExtrapolationDistanceRatio = clamp(
    options.maxExtrapolationDistanceRatio ?? 0.34,
    0,
    1,
  );
  const previous = snapshots.length > 1 ? snapshots[snapshots.length - 2]! : null;

  if (previous && underrunMs > 0 && maxExtrapolationMs > 0) {
    if (underrunMs <= maxExtrapolationMs) {
      const spanMs = Math.max(1, latest.atMs - previous.atMs);
      const extrapolationRatio = Math.min(
        underrunMs / spanMs,
        maxExtrapolationDistanceRatio,
      );

      if (extrapolationRatio > 0) {
        return {
          world: {
            x: latest.world.x + (latest.world.x - previous.world.x) * extrapolationRatio,
            y: latest.world.y + (latest.world.y - previous.world.y) * extrapolationRatio,
          },
          mode: "extrapolated",
          underrunMs,
        };
      }
    }
  }

  return {
    world: { ...latest.world },
    mode: "held-latest",
    underrunMs,
  };
}

export function resolveWrappedWorld(layout: ArenaBoardLayout, world: WorldPoint): WrapRenderState {
  const halfCell = layout.cellSize / 2;
  const minX = layout.offsetX + halfCell;
  const maxX = layout.offsetX + layout.boardWidth - halfCell;
  const minY = layout.offsetY + halfCell;
  const maxY = layout.offsetY + layout.boardHeight - halfCell;
  const wrappedX = normalizeWrappedAxis(world.x, minX, layout.boardWidth);
  const wrappedY = normalizeWrappedAxis(world.y, minY, layout.boardHeight);

  if (wrappedX > maxX) {
    return {
      primary: { x: wrappedX, y: wrappedY },
      ghost: { x: wrappedX - layout.boardWidth, y: wrappedY },
    };
  }

  if (wrappedY > maxY) {
    return {
      primary: { x: wrappedX, y: wrappedY },
      ghost: { x: wrappedX, y: wrappedY - layout.boardHeight },
    };
  }

  return {
    primary: { x: wrappedX, y: wrappedY },
    ghost: null,
  };
}

function alignWrappedAxis(anchor: number, base: number, span: number): number {
  if (!Number.isFinite(span) || span <= 0) {
    return base;
  }

  const wraps = Math.round((anchor - base) / span);
  return base + wraps * span;
}

function normalizeWrappedAxis(value: number, min: number, span: number): number {
  if (!Number.isFinite(span) || span <= 0) {
    return value;
  }

  return min + modulo(value - min, span);
}

function linear(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function modulo(value: number, span: number): number {
  const wrapped = value % span;
  return wrapped < 0 ? wrapped + span : wrapped;
}
