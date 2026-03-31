export type GameStatus = "waiting" | "running" | "paused" | "game_over";

export type Winner = "player1" | "player2" | "draw" | null;

export type Direction = "up" | "down" | "left" | "right";
export type SnakeId = "player1" | "player2";

export interface GridPosition {
  readonly x: number;
  readonly y: number;
}

export interface SnakeState {
  readonly id: SnakeId;
  readonly body: GridPosition[];
  readonly direction: Direction;
  readonly alive: boolean;
  readonly score: number;
}

export interface GameConfig {
  readonly width: number;
  readonly height: number;
  readonly tickRateMs: number;
}

export interface GameState {
  readonly status: GameStatus;
  readonly config: GameConfig;
  readonly snakes: SnakeState[];
  readonly food: GridPosition | null;
  readonly winner: Winner;
}

export const DEFAULT_GAME_CONFIG: Readonly<GameConfig> = Object.freeze({
  width: 20,
  height: 20,
  tickRateMs: 140,
});

export const PLAYER_IDS: readonly SnakeId[] = ["player1", "player2"];
