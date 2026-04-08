import { useEffect, useRef } from "react";
import Phaser from "phaser";
import { createPhaserGame } from "../game/phaser/createPhaserGame.js";
import { computePhaserCanvasSize } from "../game/phaser/canvasSizing.js";

export function PhaserViewport() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!mountRef.current) {
      return;
    }

    const mountNode = mountRef.current;
    let frameHandle = 0;
    const readCanvasSize = () =>
      computePhaserCanvasSize({
        cssWidth: mountNode.clientWidth,
        cssHeight: mountNode.clientHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      });
    const game = createPhaserGame(mountNode, readCanvasSize());
    gameRef.current = game;

    const syncCanvasSize = () => {
      if (frameHandle) {
        window.cancelAnimationFrame(frameHandle);
      }

      frameHandle = window.requestAnimationFrame(() => {
        const nextSize = readCanvasSize();
        if (game.canvas.width !== nextSize.backingWidth || game.canvas.height !== nextSize.backingHeight) {
          game.scale.resize(nextSize.backingWidth, nextSize.backingHeight);
          return;
        }

        game.scale.refresh();
      });
    };

    const resizeObserver = new ResizeObserver(() => syncCanvasSize());
    const visualViewport = window.visualViewport ?? null;

    resizeObserver.observe(mountNode);
    window.addEventListener("resize", syncCanvasSize);
    window.addEventListener("orientationchange", syncCanvasSize);
    visualViewport?.addEventListener("resize", syncCanvasSize);
    document.addEventListener("fullscreenchange", syncCanvasSize);
    document.addEventListener("webkitfullscreenchange", syncCanvasSize as EventListener);
    syncCanvasSize();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncCanvasSize);
      window.removeEventListener("orientationchange", syncCanvasSize);
      visualViewport?.removeEventListener("resize", syncCanvasSize);
      document.removeEventListener("fullscreenchange", syncCanvasSize);
      document.removeEventListener("webkitfullscreenchange", syncCanvasSize as EventListener);
      if (frameHandle) {
        window.cancelAnimationFrame(frameHandle);
      }
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return <div ref={mountRef} className="phaser-viewport h-full w-full" />;
}
