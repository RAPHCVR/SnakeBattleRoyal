import { describe, expect, it } from "vitest";
import { computeArenaBoardLayout } from "./boardLayout.js";

describe("boardLayout", () => {
  it("maximizes the square board inside a wide desktop viewport", () => {
    expect(computeArenaBoardLayout({ width: 1280, height: 720 })).toMatchObject({
      cellSize: 36,
      boardWidth: 720,
      boardHeight: 720,
      offsetX: 280,
      offsetY: 0,
    });
  });

  it("keeps integer cells and centered padding on odd mobile viewports", () => {
    expect(computeArenaBoardLayout({ width: 393, height: 393 })).toMatchObject({
      cellSize: 19,
      boardWidth: 380,
      boardHeight: 380,
      offsetX: 6,
      offsetY: 6,
    });
  });
});
