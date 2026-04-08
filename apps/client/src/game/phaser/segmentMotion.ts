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
  let best = base;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const xOffset of [-layout.boardWidth, 0, layout.boardWidth]) {
    for (const yOffset of [-layout.boardHeight, 0, layout.boardHeight]) {
      const candidate = {
        x: base.x + xOffset,
        y: base.y + yOffset,
      };
      const distance = Math.abs(candidate.x - anchorWorld.x) + Math.abs(candidate.y - anchorWorld.y);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }

  return best;
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
): WorldPoint | null {
  if (snapshots.length === 0) {
    return null;
  }

  if (snapshots.length === 1 || renderAtMs <= snapshots[0]!.atMs) {
    return { ...snapshots[0]!.world };
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
        x: linear(previous.world.x, next.world.x, progress),
        y: linear(previous.world.y, next.world.y, progress),
      };
    }
  }

  return { ...snapshots[snapshots.length - 1]!.world };
}

export function resolveWrappedWorld(layout: ArenaBoardLayout, world: WorldPoint): WrapRenderState {
  const halfCell = layout.cellSize / 2;
  const minX = layout.offsetX + halfCell;
  const maxX = layout.offsetX + layout.boardWidth - halfCell;
  const minY = layout.offsetY + halfCell;
  const maxY = layout.offsetY + layout.boardHeight - halfCell;

  if (world.x < minX) {
    return {
      primary: world,
      ghost: { x: world.x + layout.boardWidth, y: world.y },
    };
  }

  if (world.x > maxX) {
    return {
      primary: world,
      ghost: { x: world.x - layout.boardWidth, y: world.y },
    };
  }

  if (world.y < minY) {
    return {
      primary: world,
      ghost: { x: world.x, y: world.y + layout.boardHeight },
    };
  }

  if (world.y > maxY) {
    return {
      primary: world,
      ghost: { x: world.x, y: world.y - layout.boardHeight },
    };
  }

  return {
    primary: world,
    ghost: null,
  };
}

function linear(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
