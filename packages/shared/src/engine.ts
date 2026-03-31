import {
  DEFAULT_GAME_CONFIG,
  PLAYER_IDS,
  type Direction,
  type GameConfig,
  type GameState,
  type GameStatus,
  type GridPosition,
  type SnakeId,
  type SnakeState,
  type Winner,
} from "./game-types.js";

export type RandomFn = () => number;

export interface InputBuffers {
  readonly player1: readonly Direction[];
  readonly player2: readonly Direction[];
}

export interface EngineRuntime {
  readonly tick: number;
  readonly game: GameState;
  readonly inputBuffers: InputBuffers;
  readonly lastTickEvent: TickEvent | null;
}

export interface CreateRuntimeOptions {
  readonly config?: Partial<GameConfig>;
  readonly random?: RandomFn;
  readonly initialStatus?: GameStatus;
}

export interface QueueInputOptions {
  readonly maxBufferSize?: number;
}

export interface QueueInputResult {
  readonly runtime: EngineRuntime;
  readonly accepted: boolean;
}

export interface SnakeGameEngineOptions extends CreateRuntimeOptions {
  readonly inputBufferSize?: number;
}

export interface TickEvent {
  readonly tick: number;
  readonly consumedFoodPosition: GridPosition | null;
  readonly eliminatedSnakeIds: readonly SnakeId[];
}

interface PlannedMove {
  readonly snakeId: SnakeId;
  readonly previousHead: GridPosition;
  readonly nextHead: GridPosition;
  readonly nextDirection: Direction;
}

const MIN_GRID_WIDTH = 8;
const MIN_GRID_HEIGHT = 2;
const DEFAULT_INPUT_BUFFER_SIZE = 3;

const DIRECTION_VECTORS: Readonly<Record<Direction, GridPosition>> = Object.freeze({
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
});

const OPPOSITE_DIRECTION: Readonly<Record<Direction, Direction>> = Object.freeze({
  up: "down",
  down: "up",
  left: "right",
  right: "left",
});

export function isDirection(value: unknown): value is Direction {
  return value === "up" || value === "down" || value === "left" || value === "right";
}

export function areOppositeDirections(a: Direction, b: Direction): boolean {
  return OPPOSITE_DIRECTION[a] === b;
}

export function normalizeGameConfig(config?: Partial<GameConfig>): GameConfig {
  const width = config?.width ?? DEFAULT_GAME_CONFIG.width;
  const height = config?.height ?? DEFAULT_GAME_CONFIG.height;
  const tickRateMs = config?.tickRateMs ?? DEFAULT_GAME_CONFIG.tickRateMs;

  if (!Number.isInteger(width) || width < MIN_GRID_WIDTH) {
    throw new Error(`Grid width must be an integer >= ${MIN_GRID_WIDTH}.`);
  }

  if (!Number.isInteger(height) || height < MIN_GRID_HEIGHT) {
    throw new Error(`Grid height must be an integer >= ${MIN_GRID_HEIGHT}.`);
  }

  if (!Number.isInteger(tickRateMs) || tickRateMs <= 0) {
    throw new Error("tickRateMs must be a positive integer.");
  }

  return { width, height, tickRateMs };
}

export function createInitialSnakes(config: GameConfig): SnakeState[] {
  const spawnY = Math.floor(config.height / 2);
  const player1HeadX = wrapCoordinate(2, config.width);
  const player2HeadX = wrapCoordinate(config.width - 3, config.width);

  return [
    {
      id: "player1",
      body: [
        { x: player1HeadX, y: spawnY },
        { x: wrapCoordinate(player1HeadX - 1, config.width), y: spawnY },
        { x: wrapCoordinate(player1HeadX - 2, config.width), y: spawnY },
      ],
      direction: "right",
      alive: true,
      score: 0,
    },
    {
      id: "player2",
      body: [
        { x: player2HeadX, y: spawnY },
        { x: wrapCoordinate(player2HeadX + 1, config.width), y: spawnY },
        { x: wrapCoordinate(player2HeadX + 2, config.width), y: spawnY },
      ],
      direction: "left",
      alive: true,
      score: 0,
    },
  ];
}

export function createInitialGameState(options: CreateRuntimeOptions = {}): GameState {
  const config = normalizeGameConfig(options.config);
  const random = options.random ?? Math.random;
  const status = options.initialStatus ?? "waiting";
  const snakes = createInitialSnakes(config);

  const gameState: GameState = {
    status,
    config,
    snakes,
    food: null,
    winner: null,
  };

  return {
    ...gameState,
    food: spawnFood(gameState, random),
  };
}

export function createEmptyInputBuffers(): InputBuffers {
  return {
    player1: [],
    player2: [],
  };
}

export function createRuntime(options: CreateRuntimeOptions = {}): EngineRuntime {
  return {
    tick: 0,
    game: createInitialGameState(options),
    inputBuffers: createEmptyInputBuffers(),
    lastTickEvent: null,
  };
}

export function queueInput(
  runtime: EngineRuntime,
  snakeId: SnakeId,
  direction: unknown,
  options: QueueInputOptions = {},
): QueueInputResult {
  if (!isDirection(direction)) {
    return { runtime, accepted: false };
  }

  const maxBufferSize = options.maxBufferSize ?? DEFAULT_INPUT_BUFFER_SIZE;
  if (!Number.isInteger(maxBufferSize) || maxBufferSize < 1) {
    throw new Error("maxBufferSize must be an integer >= 1.");
  }

  if (runtime.game.status === "game_over") {
    return { runtime, accepted: false };
  }

  const snake = runtime.game.snakes.find((candidate) => candidate.id === snakeId);
  if (!snake || !snake.alive) {
    return { runtime, accepted: false };
  }

  const currentBuffer = runtime.inputBuffers[snakeId];
  if (currentBuffer.length >= maxBufferSize) {
    return { runtime, accepted: false };
  }

  const referenceDirection =
    currentBuffer.length > 0 ? currentBuffer[currentBuffer.length - 1] : snake.direction;

  if (!referenceDirection) {
    return { runtime, accepted: false };
  }

  if (direction === referenceDirection || areOppositeDirections(referenceDirection, direction)) {
    return { runtime, accepted: false };
  }

  const nextBuffer = [...currentBuffer, direction];

  return {
    runtime: {
      ...runtime,
      inputBuffers: setInputBuffer(runtime.inputBuffers, snakeId, nextBuffer),
    },
    accepted: true,
  };
}

export function advanceRuntimeTick(runtime: EngineRuntime, random: RandomFn = Math.random): EngineRuntime {
  if (runtime.game.status !== "running") {
    if (runtime.lastTickEvent === null) {
      return runtime;
    }

    return {
      ...runtime,
      lastTickEvent: null,
    };
  }

  const plannedMoves: Partial<Record<SnakeId, PlannedMove>> = {};
  let nextInputBuffers = cloneInputBuffers(runtime.inputBuffers);

  for (const snake of runtime.game.snakes) {
    if (!snake.alive) {
      nextInputBuffers = setInputBuffer(nextInputBuffers, snake.id, []);
      continue;
    }

    const consumed = consumeQueuedDirection(snake.direction, nextInputBuffers[snake.id]);
    nextInputBuffers = setInputBuffer(nextInputBuffers, snake.id, consumed.remaining);

    plannedMoves[snake.id] = {
      snakeId: snake.id,
      previousHead: snake.body[0] ?? { x: 0, y: 0 },
      nextHead: moveWithWrap(snake.body[0] ?? { x: 0, y: 0 }, consumed.direction, runtime.game.config),
      nextDirection: consumed.direction,
    };
  }

  const eliminated = evaluateEliminations(runtime.game, plannedMoves);
  const eatenBy = evaluateFoodEaten(runtime.game, plannedMoves, eliminated);
  const nextSnakes = buildNextSnakes(runtime.game, plannedMoves, eliminated, eatenBy);

  const nextGameWithoutFood: GameState = {
    status: runtime.game.status,
    config: runtime.game.config,
    snakes: nextSnakes,
    food: runtime.game.food ? clonePosition(runtime.game.food) : null,
    winner: null,
  };

  const nextFood =
    runtime.game.food === null || eatenBy.size > 0
      ? spawnFood(nextGameWithoutFood, random)
      : runtime.game.food;

  const aliveSnakes = nextSnakes.filter((snake) => snake.alive);
  const nextStatus = aliveSnakes.length <= 1 ? "game_over" : runtime.game.status;
  const nextWinner = computeWinner(aliveSnakes);

  const nextRuntime: EngineRuntime = {
    tick: runtime.tick + 1,
    game: {
      status: nextStatus,
      config: runtime.game.config,
      snakes: nextSnakes,
      food: nextFood,
      winner: nextStatus === "game_over" ? nextWinner : null,
    },
    inputBuffers: nextStatus === "game_over" ? createEmptyInputBuffers() : nextInputBuffers,
    lastTickEvent: {
      tick: runtime.tick + 1,
      consumedFoodPosition: eatenBy.size > 0 && runtime.game.food ? clonePosition(runtime.game.food) : null,
      eliminatedSnakeIds: [...eliminated],
    },
  };

  return nextRuntime;
}

export class SnakeGameEngine {
  private runtime: EngineRuntime;
  private readonly random: RandomFn;
  private readonly inputBufferSize: number;
  private readonly config: Partial<GameConfig>;
  private readonly initialStatus: GameStatus;

  public constructor(options: SnakeGameEngineOptions = {}) {
    this.random = options.random ?? Math.random;
    this.inputBufferSize = options.inputBufferSize ?? DEFAULT_INPUT_BUFFER_SIZE;
    this.config = options.config ?? {};
    this.initialStatus = options.initialStatus ?? "waiting";
    this.runtime = createRuntime({
      config: this.config,
      random: this.random,
      initialStatus: this.initialStatus,
    });
  }

  public getRuntime(): EngineRuntime {
    return cloneRuntime(this.runtime);
  }

  public getState(): GameState {
    return cloneGameState(this.runtime.game);
  }

  public getTick(): number {
    return this.runtime.tick;
  }

  public getLastTickEvent(): TickEvent | null {
    return this.runtime.lastTickEvent
      ? {
          tick: this.runtime.lastTickEvent.tick,
          consumedFoodPosition: this.runtime.lastTickEvent.consumedFoodPosition
            ? clonePosition(this.runtime.lastTickEvent.consumedFoodPosition)
            : null,
          eliminatedSnakeIds: [...this.runtime.lastTickEvent.eliminatedSnakeIds],
        }
      : null;
  }

  public enqueueInput(snakeId: SnakeId, direction: unknown): boolean {
    const result = queueInput(this.runtime, snakeId, direction, {
      maxBufferSize: this.inputBufferSize,
    });
    this.runtime = result.runtime;
    return result.accepted;
  }

  public tick(): GameState {
    this.runtime = advanceRuntimeTick(this.runtime, this.random);
    return this.getState();
  }

  public reset(status: GameStatus = this.initialStatus): GameState {
    this.runtime = createRuntime({
      config: this.config,
      random: this.random,
      initialStatus: status,
    });
    return this.getState();
  }

  public setStatus(status: GameStatus): GameState {
    this.runtime = {
      ...this.runtime,
      lastTickEvent: null,
      game: {
        ...this.runtime.game,
        status,
      },
    };
    return this.getState();
  }
}

function consumeQueuedDirection(
  currentDirection: Direction,
  queue: readonly Direction[],
): { direction: Direction; remaining: readonly Direction[] } {
  const remaining = [...queue];

  while (remaining.length > 0) {
    const candidate = remaining.shift();
    if (!candidate) {
      break;
    }

    if (!areOppositeDirections(currentDirection, candidate)) {
      return {
        direction: candidate,
        remaining,
      };
    }
  }

  return {
    direction: currentDirection,
    remaining,
  };
}

function evaluateEliminations(
  game: GameState,
  plannedMoves: Partial<Record<SnakeId, PlannedMove>>,
): Set<SnakeId> {
  const eliminated = new Set<SnakeId>();
  const player1Move = plannedMoves.player1;
  const player2Move = plannedMoves.player2;

  if (player1Move && player2Move) {
    if (isSamePosition(player1Move.nextHead, player2Move.nextHead)) {
      eliminated.add("player1");
      eliminated.add("player2");
    } else if (
      isSamePosition(player1Move.nextHead, player2Move.previousHead) &&
      isSamePosition(player2Move.nextHead, player1Move.previousHead)
    ) {
      eliminated.add("player1");
      eliminated.add("player2");
    } else if (
      isSamePosition(player1Move.nextHead, player2Move.previousHead) ||
      isSamePosition(player2Move.nextHead, player1Move.previousHead)
    ) {
      eliminated.add("player1");
      eliminated.add("player2");
    }
  }

  for (const snake of game.snakes) {
    if (!snake.alive) {
      continue;
    }

    const move = plannedMoves[snake.id];
    if (!move) {
      continue;
    }

    if (containsPosition(snake.body.slice(1), move.nextHead)) {
      eliminated.add(snake.id);
    }

    for (const otherSnake of game.snakes) {
      if (otherSnake.id === snake.id) {
        continue;
      }

      const obstacleSegments = otherSnake.alive ? otherSnake.body.slice(1) : otherSnake.body;
      if (containsPosition(obstacleSegments, move.nextHead)) {
        eliminated.add(snake.id);
      }
    }
  }

  return eliminated;
}

function evaluateFoodEaten(
  game: GameState,
  plannedMoves: Partial<Record<SnakeId, PlannedMove>>,
  eliminated: Set<SnakeId>,
): Set<SnakeId> {
  const eatenBy = new Set<SnakeId>();
  if (!game.food) {
    return eatenBy;
  }

  for (const snake of game.snakes) {
    if (!snake.alive || eliminated.has(snake.id)) {
      continue;
    }

    const move = plannedMoves[snake.id];
    if (!move) {
      continue;
    }

    if (isSamePosition(move.nextHead, game.food)) {
      eatenBy.add(snake.id);
    }
  }

  return eatenBy;
}

function buildNextSnakes(
  game: GameState,
  plannedMoves: Partial<Record<SnakeId, PlannedMove>>,
  eliminated: Set<SnakeId>,
  eatenBy: Set<SnakeId>,
): SnakeState[] {
  return game.snakes.map((snake) => {
    if (!snake.alive) {
      return cloneSnake(snake);
    }

    const move = plannedMoves[snake.id];
    if (!move) {
      return cloneSnake(snake);
    }

    const eliminatedNow = eliminated.has(snake.id);
    const grows = !eliminatedNow && eatenBy.has(snake.id);
    const bodyWithoutTail = snake.body.slice(0, Math.max(snake.body.length - 1, 0)).map(clonePosition);
    const nextBody = grows
      ? [clonePosition(move.nextHead), ...snake.body.map(clonePosition)]
      : [clonePosition(move.nextHead), ...bodyWithoutTail];

    return {
      id: snake.id,
      body: nextBody,
      direction: move.nextDirection,
      alive: !eliminatedNow,
      score: snake.score + (grows ? 1 : 0),
    };
  });
}

function computeWinner(aliveSnakes: SnakeState[]): Winner {
  if (aliveSnakes.length === 0) {
    return "draw";
  }

  const winner = aliveSnakes[0];
  return winner?.id ?? "draw";
}

function moveWithWrap(position: GridPosition, direction: Direction, config: GameConfig): GridPosition {
  const delta = DIRECTION_VECTORS[direction];
  const nextX = wrapCoordinate(position.x + delta.x, config.width);
  const nextY = wrapCoordinate(position.y + delta.y, config.height);
  return {
    x: nextX,
    y: nextY,
  };
}

function wrapCoordinate(value: number, max: number): number {
  const wrapped = value % max;
  return wrapped < 0 ? wrapped + max : wrapped;
}

function containsPosition(positions: readonly GridPosition[], target: GridPosition): boolean {
  return positions.some((position) => isSamePosition(position, target));
}

function isSamePosition(a: GridPosition, b: GridPosition): boolean {
  return a.x === b.x && a.y === b.y;
}

function spawnFood(game: Pick<GameState, "config" | "snakes">, random: RandomFn): GridPosition | null {
  const occupied = new Set<string>();

  for (const snake of game.snakes) {
    for (const segment of snake.body) {
      occupied.add(toCellKey(segment));
    }
  }

  const freeCells: GridPosition[] = [];
  for (let y = 0; y < game.config.height; y += 1) {
    for (let x = 0; x < game.config.width; x += 1) {
      const candidate = { x, y };
      if (!occupied.has(toCellKey(candidate))) {
        freeCells.push(candidate);
      }
    }
  }

  if (freeCells.length === 0) {
    return null;
  }

  const index = Math.min(Math.floor(clampUnit(random()) * freeCells.length), freeCells.length - 1);
  return freeCells[index] ?? null;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 0.999999999999;
  }
  return value;
}

function toCellKey(position: GridPosition): string {
  return `${position.x},${position.y}`;
}

function setInputBuffer(
  inputBuffers: InputBuffers,
  snakeId: SnakeId,
  nextBuffer: readonly Direction[],
): InputBuffers {
  if (snakeId === "player1") {
    return {
      player1: [...nextBuffer],
      player2: [...inputBuffers.player2],
    };
  }

  return {
    player1: [...inputBuffers.player1],
    player2: [...nextBuffer],
  };
}

function cloneInputBuffers(inputBuffers: InputBuffers): InputBuffers {
  return {
    player1: [...inputBuffers.player1],
    player2: [...inputBuffers.player2],
  };
}

function cloneRuntime(runtime: EngineRuntime): EngineRuntime {
  return {
    tick: runtime.tick,
    game: cloneGameState(runtime.game),
    inputBuffers: cloneInputBuffers(runtime.inputBuffers),
    lastTickEvent: runtime.lastTickEvent
      ? {
          tick: runtime.lastTickEvent.tick,
          consumedFoodPosition: runtime.lastTickEvent.consumedFoodPosition
            ? clonePosition(runtime.lastTickEvent.consumedFoodPosition)
            : null,
          eliminatedSnakeIds: [...runtime.lastTickEvent.eliminatedSnakeIds],
        }
      : null,
  };
}

function cloneGameState(game: GameState): GameState {
  return {
    status: game.status,
    config: {
      width: game.config.width,
      height: game.config.height,
      tickRateMs: game.config.tickRateMs,
    },
    snakes: game.snakes.map(cloneSnake),
    food: game.food ? clonePosition(game.food) : null,
    winner: game.winner,
  };
}

function cloneSnake(snake: SnakeState): SnakeState {
  return {
    id: snake.id,
    body: snake.body.map(clonePosition),
    direction: snake.direction,
    alive: snake.alive,
    score: snake.score,
  };
}

function clonePosition(position: GridPosition): GridPosition {
  return {
    x: position.x,
    y: position.y,
  };
}

export const PLAYER_ID_SET: ReadonlySet<SnakeId> = new Set(PLAYER_IDS);
