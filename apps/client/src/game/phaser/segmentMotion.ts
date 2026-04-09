import type { GridPosition } from "@snake-duel/shared";
import { toBoardPosition, type ArenaBoardLayout } from "./boardLayout.js";

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

export interface WrapRenderState {
  readonly primary: WorldPoint;
  readonly ghost: WorldPoint | null;
}

export interface InterpolatedGridMotion {
  readonly world: WorldPoint;
  readonly targetWorld: WorldPoint;
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

export function interpolateAlignedGridMotion(
  layout: ArenaBoardLayout,
  from: GridPosition,
  to: GridPosition,
  elapsedMs: number,
  durationMs: number,
): InterpolatedGridMotion {
  const startWorld = toBoardPosition(layout, from);
  const targetWorld = alignWorldPosition(layout, startWorld, to);

  return {
    world: interpolateTimedWorld(startWorld, targetWorld, elapsedMs, durationMs),
    targetWorld,
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
