import { describe, expect, it } from "vitest";
import { computePhaserCanvasSize } from "./canvasSizing.js";

describe("canvasSizing", () => {
  it("keeps a 1x backing store on standard-density desktop viewports", () => {
    expect(
      computePhaserCanvasSize({
        cssWidth: 1280,
        cssHeight: 720,
        devicePixelRatio: 1,
      }),
    ).toEqual({
      cssWidth: 1280,
      cssHeight: 720,
      renderScale: 1,
      backingWidth: 1280,
      backingHeight: 720,
    });
  });

  it("caps supersampling on high-density phones", () => {
    expect(
      computePhaserCanvasSize({
        cssWidth: 430,
        cssHeight: 932,
        devicePixelRatio: 3,
      }),
    ).toEqual({
      cssWidth: 430,
      cssHeight: 932,
      renderScale: 2,
      backingWidth: 860,
      backingHeight: 1864,
    });
  });

  it("backs off supersampling on very large fullscreen canvases", () => {
    expect(
      computePhaserCanvasSize({
        cssWidth: 1440,
        cssHeight: 1440,
        devicePixelRatio: 2,
      }),
    ).toEqual({
      cssWidth: 1440,
      cssHeight: 1440,
      renderScale: 1.74,
      backingWidth: 2506,
      backingHeight: 2506,
    });
  });
});
