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

export interface QueuedDirectionInput {
  readonly direction: Direction;
  readonly sequence?: number;
}

export interface InputBuffers {
  readonly player1: readonly QueuedDirectionInput[];
  readonly player2: readonly QueuedDirectionInput[];
}

export interface ProcessedInputSequences {
  readonly player1: number;
  readonly player2: number;
}

export interface EngineRuntime {
  readonly tick: number;
  readonly game: GameState;
  readonly inputBuffers: InputBuffers;
  readonly processedInputSequences: ProcessedInputSequences;
  readonly rngSeed: number;
  readonly lastTickEvent: TickEvent | null;
}

export interface CreateRuntimeOptions {
  readonly config?: Partial<GameConfig>;
  readonly random?: RandomFn;
  readonly initialStatus?: GameStatus;
  readonly seed?: number;
}

export interface CreateRuntimeFromGameStateOptions {
  readonly tick?: number;
  readonly inputBuffers?: InputBuffers;
  readonly processedInputSequences?: ProcessedInputSequences;
  readonly rngSeed?: number;
  readonly lastTickEvent?: TickEvent | null;
}

export interface QueueInputOptions {
  readonly maxBufferSize?: number;
}

export type QueueInputRejectReason =
  | "invalid_direction"
  | "game_over"
  | "snake_unavailable"
  | "buffer_full"
  | "invalid_direction_change";

export interface QueueInputResult {
  readonly runtime: EngineRuntime;
  readonly accepted: boolean;
  readonly reason: QueueInputRejectReason | null;
  readonly queuedInput: QueuedDirectionInput | null;
}

export interface SnakeGameEngineOptions extends CreateRuntimeOptions {
  readonly inputBufferSize?: number;
}

export interface TickEvent {
  readonly tick: number;
  readonly consumedFoodPosition: GridPosition | null;
  readonly eliminatedSnakeIds: readonly SnakeId[];
  readonly processedInputSequences: ProcessedInputSequences;
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
const DEFAULT_RNG_SEED = 1;
const RNG_MODULUS = 0x100000000;
const RNG_MULTIPLIER = 1664525;
const RNG_INCREMENT = 1013904223;

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

export function createEmptyProcessedInputSequences(): ProcessedInputSequences {
  return {
    player1: 0,
    player2: 0,
  };
}

export function createRuntime(options: CreateRuntimeOptions = {}): EngineRuntime {
  return {
    tick: 0,
    game: createInitialGameState(options),
    inputBuffers: createEmptyInputBuffers(),
    processedInputSequences: createEmptyProcessedInputSequences(),
    rngSeed: resolveSeed(options),
    lastTickEvent: null,
  };
}

export function createRuntimeFromGameState(
  game: GameState,
  options: CreateRuntimeFromGameStateOptions = {},
): EngineRuntime {
  return {
    tick: options.tick ?? 0,
    game: cloneGameState(game),
    inputBuffers: options.inputBuffers ? cloneInputBuffers(options.inputBuffers) : createEmptyInputBuffers(),
    processedInputSequences: options.processedInputSequences
      ? cloneProcessedInputSequences(options.processedInputSequences)
      : createEmptyProcessedInputSequences(),
    rngSeed: normalizeSeed(options.rngSeed),
    lastTickEvent: options.lastTickEvent ? cloneTickEvent(options.lastTickEvent) : null,
  };
}

export function queueInput(
  runtime: EngineRuntime,
  snakeId: SnakeId,
  input: unknown,
  options: QueueInputOptions = {},
): QueueInputResult {
  const normalizedInput = normalizeQueuedInput(input);
  if (!normalizedInput) {
    return {
      runtime,
      accepted: false,
      reason: "invalid_direction",
      queuedInput: null,
    };
  }

  const maxBufferSize = options.maxBufferSize ?? DEFAULT_INPUT_BUFFER_SIZE;
  if (!Number.isInteger(maxBufferSize) || maxBufferSize < 1) {
    throw new Error("maxBufferSize must be an integer >= 1.");
  }

  if (runtime.game.status === "game_over") {
    return {
      runtime,
      accepted: false,
      reason: "game_over",
      queuedInput: null,
    };
  }

  const snake = runtime.game.snakes.find((candidate) => candidate.id === snakeId);
  if (!snake || !snake.alive) {
    return {
      runtime,
      accepted: false,
      reason: "snake_unavailable",
      queuedInput: null,
    };
  }

  const currentBuffer = runtime.inputBuffers[snakeId];
  if (currentBuffer.length >= maxBufferSize) {
    return {
      runtime,
      accepted: false,
      reason: "buffer_full",
      queuedInput: null,
    };
  }

  const referenceDirection =
    currentBuffer.length > 0 ? currentBuffer[currentBuffer.length - 1]?.direction : snake.direction;

  if (!referenceDirection) {
    return {
      runtime,
      accepted: false,
      reason: "snake_unavailable",
      queuedInput: null,
    };
  }

  if (
    normalizedInput.direction === referenceDirection ||
    areOppositeDirections(referenceDirection, normalizedInput.direction)
  ) {
    return {
      runtime,
      accepted: false,
      reason: "invalid_direction_change",
      queuedInput: null,
    };
  }

  const nextBuffer = [...currentBuffer, cloneQueuedInput(normalizedInput)];

  return {
    runtime: {
      ...runtime,
      inputBuffers: setInputBuffer(runtime.inputBuffers, snakeId, nextBuffer),
    },
    accepted: true,
    reason: null,
    queuedInput: cloneQueuedInput(normalizedInput),
  };
}

export function advanceRuntimeTick(runtime: EngineRuntime, randomOverride?: RandomFn): EngineRuntime {
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
  let nextProcessedInputSequences = cloneProcessedInputSequences(runtime.processedInputSequences);

  for (const snake of runtime.game.snakes) {
    if (!snake.alive) {
      nextInputBuffers = setInputBuffer(nextInputBuffers, snake.id, []);
      continue;
    }

    const consumed = consumeQueuedDirection(snake.direction, nextInputBuffers[snake.id]);
    nextInputBuffers = setInputBuffer(nextInputBuffers, snake.id, consumed.remaining);
    if (typeof consumed.acknowledgedSequence === "number") {
      nextProcessedInputSequences = setProcessedInputSequence(
        nextProcessedInputSequences,
        snake.id,
        consumed.acknowledgedSequence,
      );
    }

    plannedMoves[snake.id] = {
      snakeId: snake.id,
      previousHead: snake.body[0] ?? { x: 0, y: 0 },
      nextHead: moveWithWrap(snake.body[0] ?? { x: 0, y: 0 }, consumed.direction, runtime.game.config),
      nextDirection: consumed.direction,
    };
  }

  const growthCandidates = evaluateFoodIntent(runtime.game, plannedMoves);
  const projectedBodies = buildProjectedBodies(runtime.game, plannedMoves, growthCandidates);
  const eliminated = evaluateEliminations(runtime.game, plannedMoves, projectedBodies);
  const eatenBy = filterGrowthCandidates(growthCandidates, eliminated);
  const nextSnakes = buildNextSnakes(runtime.game, plannedMoves, eliminated, eatenBy);

  const nextGameWithoutFood: GameState = {
    status: runtime.game.status,
    config: runtime.game.config,
    snakes: nextSnakes,
    food: runtime.game.food ? clonePosition(runtime.game.food) : null,
    winner: null,
  };

  const shouldRespawnFood = runtime.game.food === null || eatenBy.size > 0;
  const foodResult = shouldRespawnFood
    ? spawnFoodFromSeed(nextGameWithoutFood, runtime.rngSeed, randomOverride)
    : {
        food: runtime.game.food ? clonePosition(runtime.game.food) : null,
        nextSeed: runtime.rngSeed,
      };

  const aliveSnakes = nextSnakes.filter((snake) => snake.alive);
  const nextStatus = aliveSnakes.length <= 1 ? "game_over" : runtime.game.status;
  const nextWinner = computeWinner(aliveSnakes);

  const nextRuntime: EngineRuntime = {
    tick: runtime.tick + 1,
    game: {
      status: nextStatus,
      config: runtime.game.config,
      snakes: nextSnakes,
      food: foodResult.food,
      winner: nextStatus === "game_over" ? nextWinner : null,
    },
    inputBuffers: nextStatus === "game_over" ? createEmptyInputBuffers() : nextInputBuffers,
    processedInputSequences: nextProcessedInputSequences,
    rngSeed: foodResult.nextSeed,
    lastTickEvent: {
      tick: runtime.tick + 1,
      consumedFoodPosition: eatenBy.size > 0 && runtime.game.food ? clonePosition(runtime.game.food) : null,
      eliminatedSnakeIds: [...eliminated],
      processedInputSequences: cloneProcessedInputSequences(nextProcessedInputSequences),
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
  private readonly seed: number | undefined;

  public constructor(options: SnakeGameEngineOptions = {}) {
    this.random = options.random ?? Math.random;
    this.inputBufferSize = options.inputBufferSize ?? DEFAULT_INPUT_BUFFER_SIZE;
    this.config = options.config ?? {};
    this.initialStatus = options.initialStatus ?? "waiting";
    this.seed = options.seed;
    this.runtime = createRuntime({
      config: this.config,
      random: this.random,
      initialStatus: this.initialStatus,
      ...(this.seed !== undefined ? { seed: this.seed } : {}),
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
    return this.runtime.lastTickEvent ? cloneTickEvent(this.runtime.lastTickEvent) : null;
  }

  public enqueueInputWithResult(snakeId: SnakeId, input: unknown): QueueInputResult {
    const result = queueInput(this.runtime, snakeId, input, {
      maxBufferSize: this.inputBufferSize,
    });
    this.runtime = result.runtime;
    return result;
  }

  public enqueueInput(snakeId: SnakeId, input: unknown): boolean {
    return this.enqueueInputWithResult(snakeId, input).accepted;
  }

  public tick(): GameState {
    this.runtime = advanceRuntimeTick(this.runtime);
    return this.getState();
  }

  public reset(status: GameStatus = this.initialStatus): GameState {
    this.runtime = createRuntime({
      config: this.config,
      random: this.random,
      initialStatus: status,
      ...(this.seed !== undefined ? { seed: this.seed } : {}),
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
  queue: readonly QueuedDirectionInput[],
): { direction: Direction; remaining: readonly QueuedDirectionInput[]; acknowledgedSequence: number | null } {
  const remaining = queue.map(cloneQueuedInput);
  let acknowledgedSequence: number | null = null;

  while (remaining.length > 0) {
    const candidate = remaining.shift();
    if (!candidate) {
      break;
    }

    if (typeof candidate.sequence === "number") {
      acknowledgedSequence = candidate.sequence;
    }

    if (!areOppositeDirections(currentDirection, candidate.direction)) {
      return {
        direction: candidate.direction,
        remaining,
        acknowledgedSequence,
      };
    }
  }

  return {
    direction: currentDirection,
    remaining,
    acknowledgedSequence,
  };
}

function evaluateEliminations(
  game: GameState,
  plannedMoves: Partial<Record<SnakeId, PlannedMove>>,
  projectedBodies: ReadonlyMap<SnakeId, readonly GridPosition[]>,
): Set<SnakeId> {
  const eliminated = new Set<SnakeId>();
  const headOccupants = new Map<string, SnakeId[]>();

  for (const snake of game.snakes) {
    if (!snake.alive) {
      continue;
    }

    const move = plannedMoves[snake.id];
    if (!move) {
      continue;
    }

    const cellKey = toCellKey(move.nextHead);
    const occupants = headOccupants.get(cellKey) ?? [];
    occupants.push(snake.id);
    headOccupants.set(cellKey, occupants);
  }

  for (const occupants of headOccupants.values()) {
    if (occupants.length < 2) {
      continue;
    }

    for (const snakeId of occupants) {
      eliminated.add(snakeId);
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

    const projectedSelf = projectedBodies.get(snake.id) ?? [];
    if (containsPosition(projectedSelf.slice(1), move.nextHead)) {
      eliminated.add(snake.id);
      continue;
    }

    for (const otherSnake of game.snakes) {
      if (otherSnake.id === snake.id) {
        continue;
      }

      const projectedOther = projectedBodies.get(otherSnake.id) ?? [];
      if (containsPosition(projectedOther.slice(1), move.nextHead)) {
        eliminated.add(snake.id);
        break;
      }
    }
  }

  return eliminated;
}

function evaluateFoodIntent(
  game: GameState,
  plannedMoves: Partial<Record<SnakeId, PlannedMove>>,
): Set<SnakeId> {
  const eatenBy = new Set<SnakeId>();
  if (!game.food) {
    return eatenBy;
  }

  for (const snake of game.snakes) {
    if (!snake.alive) {
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

function buildProjectedBodies(
  game: GameState,
  plannedMoves: Partial<Record<SnakeId, PlannedMove>>,
  growthCandidates: ReadonlySet<SnakeId>,
): Map<SnakeId, readonly GridPosition[]> {
  const projected = new Map<SnakeId, readonly GridPosition[]>();

  for (const snake of game.snakes) {
    if (!snake.alive) {
      projected.set(snake.id, snake.body.map(clonePosition));
      continue;
    }

    const move = plannedMoves[snake.id];
    if (!move) {
      projected.set(snake.id, snake.body.map(clonePosition));
      continue;
    }

    const keepsTail = growthCandidates.has(snake.id);
    const carriedBody = keepsTail ? snake.body : snake.body.slice(0, Math.max(snake.body.length - 1, 0));
    projected.set(snake.id, [clonePosition(move.nextHead), ...carriedBody.map(clonePosition)]);
  }

  return projected;
}

function filterGrowthCandidates(
  growthCandidates: ReadonlySet<SnakeId>,
  eliminated: ReadonlySet<SnakeId>,
): Set<SnakeId> {
  const survivors = new Set<SnakeId>();
  for (const snakeId of growthCandidates) {
    if (!eliminated.has(snakeId)) {
      survivors.add(snakeId);
    }
  }
  return survivors;
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

function spawnFoodFromSeed(
  game: Pick<GameState, "config" | "snakes">,
  seed: number,
  randomOverride?: RandomFn,
): { food: GridPosition | null; nextSeed: number } {
  if (randomOverride) {
    return {
      food: spawnFood(game, randomOverride),
      nextSeed: seed,
    };
  }

  const sampled = sampleSeededRandom(seed);
  return {
    food: spawnFood(game, () => sampled.value),
    nextSeed: sampled.seed,
  };
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
  nextBuffer: readonly QueuedDirectionInput[],
): InputBuffers {
  if (snakeId === "player1") {
    return {
      player1: nextBuffer.map(cloneQueuedInput),
      player2: inputBuffers.player2.map(cloneQueuedInput),
    };
  }

  return {
    player1: inputBuffers.player1.map(cloneQueuedInput),
    player2: nextBuffer.map(cloneQueuedInput),
  };
}

function cloneInputBuffers(inputBuffers: InputBuffers): InputBuffers {
  return {
    player1: inputBuffers.player1.map(cloneQueuedInput),
    player2: inputBuffers.player2.map(cloneQueuedInput),
  };
}

function setProcessedInputSequence(
  processedInputSequences: ProcessedInputSequences,
  snakeId: SnakeId,
  sequence: number,
): ProcessedInputSequences {
  if (snakeId === "player1") {
    return {
      player1: sequence,
      player2: processedInputSequences.player2,
    };
  }

  return {
    player1: processedInputSequences.player1,
    player2: sequence,
  };
}

function cloneProcessedInputSequences(
  processedInputSequences: ProcessedInputSequences,
): ProcessedInputSequences {
  return {
    player1: processedInputSequences.player1,
    player2: processedInputSequences.player2,
  };
}

function cloneRuntime(runtime: EngineRuntime): EngineRuntime {
  return {
    tick: runtime.tick,
    game: cloneGameState(runtime.game),
    inputBuffers: cloneInputBuffers(runtime.inputBuffers),
    processedInputSequences: cloneProcessedInputSequences(runtime.processedInputSequences),
    rngSeed: runtime.rngSeed,
    lastTickEvent: runtime.lastTickEvent ? cloneTickEvent(runtime.lastTickEvent) : null,
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

function cloneTickEvent(tickEvent: TickEvent): TickEvent {
  return {
    tick: tickEvent.tick,
    consumedFoodPosition: tickEvent.consumedFoodPosition
      ? clonePosition(tickEvent.consumedFoodPosition)
      : null,
    eliminatedSnakeIds: [...tickEvent.eliminatedSnakeIds],
    processedInputSequences: cloneProcessedInputSequences(tickEvent.processedInputSequences),
  };
}

function cloneQueuedInput(input: QueuedDirectionInput): QueuedDirectionInput {
  return typeof input.sequence === "number"
    ? {
        direction: input.direction,
        sequence: input.sequence,
      }
    : {
        direction: input.direction,
      };
}

function normalizeQueuedInput(input: unknown): QueuedDirectionInput | null {
  if (isDirection(input)) {
    return { direction: input };
  }

  if (typeof input !== "object" || input === null) {
    return null;
  }

  const direction = "direction" in input ? input.direction : null;
  if (!isDirection(direction)) {
    return null;
  }

  const sequence = "sequence" in input ? input.sequence : undefined;
  if (sequence !== undefined && !isValidInputSequence(sequence)) {
    return null;
  }

  return typeof sequence === "number" ? { direction, sequence } : { direction };
}

function isValidInputSequence(sequence: unknown): sequence is number {
  return Number.isInteger(sequence) && typeof sequence === "number" && sequence > 0;
}

function resolveSeed(options: CreateRuntimeOptions): number {
  if (typeof options.seed === "number") {
    return normalizeSeed(options.seed);
  }

  const sampled = clampUnit((options.random ?? Math.random)());
  return normalizeSeed(Math.floor(sampled * (RNG_MODULUS - 1)) + 1);
}

function normalizeSeed(seed: number | undefined): number {
  if (seed === undefined || !Number.isFinite(seed)) {
    return DEFAULT_RNG_SEED;
  }

  const normalized = Math.floor(seed) >>> 0;
  return normalized === 0 ? DEFAULT_RNG_SEED : normalized;
}

function sampleSeededRandom(seed: number): { seed: number; value: number } {
  const nextSeed = (Math.imul(normalizeSeed(seed), RNG_MULTIPLIER) + RNG_INCREMENT) >>> 0;
  return {
    seed: nextSeed === 0 ? DEFAULT_RNG_SEED : nextSeed,
    value: nextSeed / RNG_MODULUS,
  };
}

export const PLAYER_ID_SET: ReadonlySet<SnakeId> = new Set(PLAYER_IDS);
