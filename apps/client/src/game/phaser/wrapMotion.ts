import type { GridPosition } from "@snake-duel/shared";
import { toBoardPosition, type ArenaBoardLayout } from "./boardLayout.js";
import { GRID_HEIGHT, GRID_WIDTH } from "./constants.js";

interface WrapOffset {
  readonly x: number;
  readonly y: number;
}

export interface WrapTweenPlan {
  readonly primaryStart: { x: number; y: number };
  readonly primaryTarget: { x: number; y: number };
  readonly ghostStart: { x: number; y: number };
  readonly ghostTarget: { x: number; y: number };
}

export function computeWrapTweenPlan(
  layout: ArenaBoardLayout,
  from: GridPosition,
  to: GridPosition,
): WrapTweenPlan | null {
  const wrapOffset = getWrapOffset(layout, from, to);
  if (!wrapOffset) {
    return null;
  }

  const fromWorld = toBoardPosition(layout, from);
  const toWorld = toBoardPosition(layout, to);

  return {
    primaryStart: {
      x: fromWorld.x + wrapOffset.x,
      y: fromWorld.y + wrapOffset.y,
    },
    primaryTarget: toWorld,
    ghostStart: fromWorld,
    ghostTarget: {
      x: toWorld.x - wrapOffset.x,
      y: toWorld.y - wrapOffset.y,
    },
  };
}

function getWrapOffset(
  layout: ArenaBoardLayout,
  from: GridPosition,
  to: GridPosition,
): WrapOffset | null {
  if (from.y === to.y) {
    if (from.x === GRID_WIDTH - 1 && to.x === 0) {
      return { x: -layout.boardWidth, y: 0 };
    }

    if (from.x === 0 && to.x === GRID_WIDTH - 1) {
      return { x: layout.boardWidth, y: 0 };
    }
  }

  if (from.x === to.x) {
    if (from.y === GRID_HEIGHT - 1 && to.y === 0) {
      return { x: 0, y: -layout.boardHeight };
    }

    if (from.y === 0 && to.y === GRID_HEIGHT - 1) {
      return { x: 0, y: layout.boardHeight };
    }
  }

  return null;
}
