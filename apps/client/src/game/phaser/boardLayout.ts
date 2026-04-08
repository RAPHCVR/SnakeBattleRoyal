import type { GridPosition } from "@snake-duel/shared";
import { GRID_HEIGHT, GRID_WIDTH } from "./constants.js";

const MIN_BOARD_RADIUS_PX = 12;
const MAX_BOARD_RADIUS_PX = 24;
const MIN_BORDER_WIDTH_PX = 2;
const MIN_SEGMENT_SIZE_PX = 6;
const MIN_FOOD_RADIUS_PX = 3;

export interface ArenaBoardLayout {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly cellSize: number;
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly borderRadius: number;
  readonly borderWidth: number;
  readonly gridLineWidth: number;
  readonly foodRadius: number;
  readonly wrapPadding: number;
}

interface ArenaBoardLayoutInput {
  readonly width: number;
  readonly height: number;
}

export function computeArenaBoardLayout({
  width,
  height,
}: ArenaBoardLayoutInput): ArenaBoardLayout {
  const viewportWidth = Math.max(GRID_WIDTH, Math.round(width));
  const viewportHeight = Math.max(GRID_HEIGHT, Math.round(height));
  const cellSize = Math.max(1, Math.floor(Math.min(viewportWidth / GRID_WIDTH, viewportHeight / GRID_HEIGHT)));
  const boardWidth = cellSize * GRID_WIDTH;
  const boardHeight = cellSize * GRID_HEIGHT;
  const offsetX = Math.floor((viewportWidth - boardWidth) / 2);
  const offsetY = Math.floor((viewportHeight - boardHeight) / 2);

  return {
    viewportWidth,
    viewportHeight,
    cellSize,
    boardWidth,
    boardHeight,
    offsetX,
    offsetY,
    borderRadius: clamp(Math.round(cellSize * 0.55), MIN_BOARD_RADIUS_PX, MAX_BOARD_RADIUS_PX),
    borderWidth: Math.max(MIN_BORDER_WIDTH_PX, Math.round(cellSize * 0.09)),
    gridLineWidth: 1,
    foodRadius: Math.max(MIN_FOOD_RADIUS_PX, Math.round(cellSize * 0.22)),
    wrapPadding: cellSize / 2,
  };
}

export function toBoardPosition(
  layout: ArenaBoardLayout,
  position: GridPosition,
): { x: number; y: number } {
  return {
    x: layout.offsetX + position.x * layout.cellSize + layout.cellSize / 2,
    y: layout.offsetY + position.y * layout.cellSize + layout.cellSize / 2,
  };
}

export function getBoardSegmentSize(layout: ArenaBoardLayout, index: number): number {
  const scale = index === 0 ? 0.86 : 0.74;
  return Math.max(MIN_SEGMENT_SIZE_PX, Math.round(layout.cellSize * scale));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
