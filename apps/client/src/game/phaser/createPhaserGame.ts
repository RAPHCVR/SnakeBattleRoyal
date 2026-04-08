import Phaser from "phaser";
import { SnakeArenaScene } from "./SnakeArenaScene.js";
import type { PhaserCanvasSize } from "./canvasSizing.js";

export function createPhaserGame(parent: HTMLElement, canvasSize: PhaserCanvasSize): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: canvasSize.backingWidth,
    height: canvasSize.backingHeight,
    backgroundColor: "#050a16",
    audio: {
      noAudio: true,
    },
    banner: false,
    scene: [SnakeArenaScene],
    scale: {
      mode: Phaser.Scale.NONE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: canvasSize.backingWidth,
      height: canvasSize.backingHeight,
    },
    render: {
      antialias: true,
      pixelArt: false,
      roundPixels: true,
    },
    fps: {
      target: 120,
      forceSetTimeOut: false,
    },
  });
}
