import Phaser from "phaser";
import { SnakeArenaScene } from "./SnakeArenaScene.js";
import { WORLD_HEIGHT_PX, WORLD_WIDTH_PX } from "./constants.js";

export function createPhaserGame(parent: HTMLElement): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: "#050a16",
    audio: {
      noAudio: true,
    },
    banner: false,
    scene: [SnakeArenaScene],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: WORLD_WIDTH_PX,
      height: WORLD_HEIGHT_PX,
    },
    render: {
      antialias: true,
      pixelArt: false,
      roundPixels: false,
    },
    fps: {
      target: 120,
      forceSetTimeOut: false,
    },
  });
}
