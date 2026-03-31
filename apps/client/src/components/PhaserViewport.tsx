import { useEffect, useRef } from "react";
import Phaser from "phaser";
import { createPhaserGame } from "../game/phaser/createPhaserGame.js";

export function PhaserViewport() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!mountRef.current || gameRef.current) {
      return;
    }

    const mountNode = mountRef.current;
    const game = createPhaserGame(mountNode);
    gameRef.current = game;

    let frameHandle = 0;
    const refreshScale = () => {
      if (frameHandle) {
        window.cancelAnimationFrame(frameHandle);
      }

      frameHandle = window.requestAnimationFrame(() => {
        game.scale.refresh();
      });
    };

    const resizeObserver = new ResizeObserver(() => refreshScale());
    resizeObserver.observe(mountNode);

    window.addEventListener("resize", refreshScale);
    document.addEventListener("fullscreenchange", refreshScale);
    document.addEventListener("webkitfullscreenchange", refreshScale as EventListener);
    refreshScale();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", refreshScale);
      document.removeEventListener("fullscreenchange", refreshScale);
      document.removeEventListener("webkitfullscreenchange", refreshScale as EventListener);
      if (frameHandle) {
        window.cancelAnimationFrame(frameHandle);
      }
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return <div ref={mountRef} className="h-full w-full" />;
}
