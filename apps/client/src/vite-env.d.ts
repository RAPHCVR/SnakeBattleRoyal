/// <reference types="vite/client" />

interface Window {
  render_game_to_text?: () => string;
  advanceTime?: (ms: number) => number;
  enqueueInput?: (
    direction: "up" | "down" | "left" | "right",
    snakeId?: "player1" | "player2",
  ) => boolean;
}
