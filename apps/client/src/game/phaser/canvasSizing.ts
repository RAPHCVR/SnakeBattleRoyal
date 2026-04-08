const MAX_RENDER_SCALE = 2;
const MAX_BACKING_EDGE_PX = 2_560;
const MAX_BACKING_AREA_PX = 6_250_000;

export interface PhaserCanvasSize {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly renderScale: number;
  readonly backingWidth: number;
  readonly backingHeight: number;
}

interface PhaserCanvasSizeInput {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
}

export function computePhaserCanvasSize({
  cssWidth,
  cssHeight,
  devicePixelRatio,
}: PhaserCanvasSizeInput): PhaserCanvasSize {
  const safeCssWidth = Math.max(1, Math.round(cssWidth));
  const safeCssHeight = Math.max(1, Math.round(cssHeight));
  const safeDevicePixelRatio = Number.isFinite(devicePixelRatio)
    ? Math.max(1, devicePixelRatio)
    : 1;

  let renderScale = Math.min(safeDevicePixelRatio, MAX_RENDER_SCALE);
  renderScale = Math.min(renderScale, MAX_BACKING_EDGE_PX / Math.max(safeCssWidth, safeCssHeight));
  renderScale = Math.min(
    renderScale,
    Math.sqrt(MAX_BACKING_AREA_PX / (safeCssWidth * safeCssHeight)),
  );
  renderScale = Math.max(1, renderScale);

  const roundedScale = Number(renderScale.toFixed(2));

  return {
    cssWidth: safeCssWidth,
    cssHeight: safeCssHeight,
    renderScale: roundedScale,
    backingWidth: Math.max(1, Math.round(safeCssWidth * roundedScale)),
    backingHeight: Math.max(1, Math.round(safeCssHeight * roundedScale)),
  };
}
