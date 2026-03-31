import type { GameState, GridPosition, SnakeState } from "@snake-duel/shared";
import Phaser from "phaser";
import { useLocalGameStore } from "../localGameStore.js";
import {
  CELL_SIZE_PX,
  FOOD_PARTICLE_TEXTURE,
  GRID_HEIGHT,
  GRID_WIDTH,
  WORLD_HEIGHT_PX,
  WORLD_WIDTH_PX,
} from "./constants.js";

type SegmentNode = Phaser.GameObjects.Rectangle;

const PALETTE = {
  board: 0x0b1220,
  boardBorder: 0x1f2937,
  gridLine: 0x233041,
  player1: 0x2dd4bf,
  player1Head: 0x5eead4,
  player2: 0xfb923c,
  player2Head: 0xfdba74,
  dead: 0x4b5563,
  food: 0xf59e0b,
} as const;

export class SnakeArenaScene extends Phaser.Scene {
  private readonly segments = new Map<string, SegmentNode>();
  private foodNode: Phaser.GameObjects.Arc | null = null;
  private foodPulseTween: Phaser.Tweens.Tween | null = null;
  private renderVersion = -1;

  public constructor() {
    super({ key: "SnakeArenaScene" });
  }

  public create(): void {
    this.drawBoardBackground();
    this.ensureParticleTexture();
    this.renderFromStore(true);
  }

  public override update(): void {
    this.renderFromStore(false);
  }

  private renderFromStore(force: boolean): void {
    const storeState = useLocalGameStore.getState();
    if (!force && storeState.renderVersion === this.renderVersion) {
      return;
    }

    this.renderVersion = storeState.renderVersion;
    const state = storeState.gameState;
    const transition = storeState.transition;
    const previous = transition?.previous;

    this.syncFood(state, previous);
    this.syncSnakes(state, previous);

    if (transition?.foodEatenAt) {
      this.playEatBurst(transition.foodEatenAt);
    }
    if (transition?.fatalCollision) {
      this.time.delayedCall(state.config.tickRateMs, () => {
        this.cameras.main.shake(200, 0.01);
      });
    }
  }

  private drawBoardBackground(): void {
    const graphics = this.add.graphics();
    graphics.fillStyle(PALETTE.board, 1);
    graphics.fillRoundedRect(0, 0, WORLD_WIDTH_PX, WORLD_HEIGHT_PX, 18);
    graphics.lineStyle(3, PALETTE.boardBorder, 0.9);
    graphics.strokeRoundedRect(0, 0, WORLD_WIDTH_PX, WORLD_HEIGHT_PX, 18);
    graphics.lineStyle(1, PALETTE.gridLine, 0.35);

    for (let x = 1; x < GRID_WIDTH; x += 1) {
      graphics.lineBetween(x * CELL_SIZE_PX, 0, x * CELL_SIZE_PX, WORLD_HEIGHT_PX);
    }
    for (let y = 1; y < GRID_HEIGHT; y += 1) {
      graphics.lineBetween(0, y * CELL_SIZE_PX, WORLD_WIDTH_PX, y * CELL_SIZE_PX);
    }
  }

  private syncFood(state: GameState, previous: GameState | undefined): void {
    const food = state.food;
    if (!food) {
      this.foodNode?.destroy();
      this.foodNode = null;
      this.foodPulseTween?.stop();
      this.foodPulseTween = null;
      return;
    }

    const target = toWorldPosition(food);
    if (!this.foodNode) {
      this.foodNode = this.add.circle(target.x, target.y, CELL_SIZE_PX * 0.22, PALETTE.food);
      this.startFoodPulse();
      return;
    }

    const previousFood = previous?.food;
    const moved = Boolean(previousFood && (previousFood.x !== food.x || previousFood.y !== food.y));
    if (moved) {
      this.foodNode.setPosition(target.x, target.y);
      this.startFoodPulse();
    } else {
      this.foodNode.setPosition(target.x, target.y);
    }
  }

  private syncSnakes(state: GameState, previous: GameState | undefined): void {
    const previousById = new Map(previous?.snakes.map((snake) => [snake.id, snake]) ?? []);
    const activeKeys = new Set<string>();

    for (const snake of state.snakes) {
      const previousSnake = previousById.get(snake.id);
      for (let index = 0; index < snake.body.length; index += 1) {
        const segment = snake.body[index];
        if (!segment) {
          continue;
        }
        const key = `${snake.id}-${index}`;
        activeKeys.add(key);

        const visualAlive = didSnakeDieThisTick(previousSnake, snake) ? true : snake.alive;
        const node = this.ensureSegmentNode(key, snake, index, visualAlive);
        const target = toWorldPosition(segment);
        const from = previousSnake?.body[index];

        this.tweens.killTweensOf(node);
        if (!from) {
          node.setPosition(target.x, target.y);
          continue;
        }

        const wrapAnimation = getWrapAnimation(from, segment);
        if (wrapAnimation) {
          this.playWrapTween(node, wrapAnimation, state.config.tickRateMs);
          continue;
        }

        this.tweens.add({
          targets: node,
          x: target.x,
          y: target.y,
          duration: state.config.tickRateMs,
          ease: "Linear",
        });
      }
    }

    for (const [key, node] of this.segments) {
      if (activeKeys.has(key)) {
        continue;
      }
      node.destroy();
      this.segments.delete(key);
    }
  }

  private ensureSegmentNode(
    key: string,
    snake: SnakeState,
    index: number,
    visualAlive: boolean,
  ): SegmentNode {
    const existing = this.segments.get(key);
    const size = index === 0 ? CELL_SIZE_PX * 0.86 : CELL_SIZE_PX * 0.74;
    const color = getSnakeColor(snake, index, visualAlive);
    if (existing) {
      existing
        .setSize(size, size)
        .setDisplaySize(size, size)
        .setFillStyle(color)
        .setAlpha(visualAlive ? 1 : 0.72);
      return existing;
    }

    const node = this.add.rectangle(0, 0, size, size, color).setDepth(10);
    node.setAlpha(visualAlive ? 1 : 0.72);
    this.segments.set(key, node);
    return node;
  }

  private playWrapTween(
    node: SegmentNode,
    animation: WrapAnimation,
    duration: number,
  ): void {
    const halfDuration = Math.max(1, Math.floor(duration / 2));
    this.tweens.add({
      targets: node,
      x: animation.exit.x,
      y: animation.exit.y,
      duration: halfDuration,
      ease: "Linear",
      onComplete: () => {
        node.setPosition(animation.entry.x, animation.entry.y);
        this.tweens.add({
          targets: node,
          x: animation.target.x,
          y: animation.target.y,
          duration: duration - halfDuration,
          ease: "Linear",
        });
      },
    });
  }

  private startFoodPulse(): void {
    if (!this.foodNode) {
      return;
    }
    this.foodPulseTween?.stop();
    this.foodNode.setScale(1);
    this.foodPulseTween = this.tweens.add({
      targets: this.foodNode,
      scale: { from: 0.86, to: 1.14 },
      duration: 380,
      ease: "Sine.easeInOut",
      yoyo: true,
      repeat: -1,
    });
  }

  private ensureParticleTexture(): void {
    if (this.textures.exists(FOOD_PARTICLE_TEXTURE)) {
      return;
    }
    const painter = this.add.graphics();
    painter.fillStyle(0xffffff, 1);
    painter.fillCircle(4, 4, 4);
    painter.generateTexture(FOOD_PARTICLE_TEXTURE, 8, 8);
    painter.destroy();
  }

  private playEatBurst(cell: GridPosition): void {
    const world = toWorldPosition(cell);
    const emitter = this.add
      .particles(world.x, world.y, FOOD_PARTICLE_TEXTURE, {
      emitting: false,
      lifespan: 260,
      speed: { min: 30, max: 180 },
      scale: { start: 0.65, end: 0 },
      quantity: 18,
      angle: { min: 0, max: 360 },
      tint: [0xfcd34d, 0xf59e0b, 0xfbbf24],
      blendMode: "ADD",
      })
      .setDepth(14);

    // The emitter is already positioned on the consumed cell.
    // Passing x/y again to explode would offset particles a second time.
    emitter.explode(18);
    this.time.delayedCall(360, () => emitter.destroy());
  }
}

function toWorldPosition(position: GridPosition): { x: number; y: number } {
  return {
    x: position.x * CELL_SIZE_PX + CELL_SIZE_PX / 2,
    y: position.y * CELL_SIZE_PX + CELL_SIZE_PX / 2,
  };
}

function getSnakeColor(snake: SnakeState, index: number, alive: boolean): number {
  if (!alive) {
    return PALETTE.dead;
  }
  if (snake.id === "player1") {
    return index === 0 ? PALETTE.player1Head : PALETTE.player1;
  }
  return index === 0 ? PALETTE.player2Head : PALETTE.player2;
}

function didSnakeDieThisTick(previous: SnakeState | undefined, next: SnakeState): boolean {
  return Boolean(previous?.alive && !next.alive);
}

interface WrapAnimation {
  readonly exit: { x: number; y: number };
  readonly entry: { x: number; y: number };
  readonly target: { x: number; y: number };
}

function getWrapAnimation(from: GridPosition, to: GridPosition): WrapAnimation | null {
  const target = toWorldPosition(to);

  if (from.x === GRID_WIDTH - 1 && to.x === 0 && from.y === to.y) {
    return {
      exit: { x: WORLD_WIDTH_PX + CELL_SIZE_PX / 2, y: target.y },
      entry: { x: -CELL_SIZE_PX / 2, y: target.y },
      target,
    };
  }

  if (from.x === 0 && to.x === GRID_WIDTH - 1 && from.y === to.y) {
    return {
      exit: { x: -CELL_SIZE_PX / 2, y: target.y },
      entry: { x: WORLD_WIDTH_PX + CELL_SIZE_PX / 2, y: target.y },
      target,
    };
  }

  if (from.y === GRID_HEIGHT - 1 && to.y === 0 && from.x === to.x) {
    return {
      exit: { x: target.x, y: WORLD_HEIGHT_PX + CELL_SIZE_PX / 2 },
      entry: { x: target.x, y: -CELL_SIZE_PX / 2 },
      target,
    };
  }

  if (from.y === 0 && to.y === GRID_HEIGHT - 1 && from.x === to.x) {
    return {
      exit: { x: target.x, y: -CELL_SIZE_PX / 2 },
      entry: { x: target.x, y: WORLD_HEIGHT_PX + CELL_SIZE_PX / 2 },
      target,
    };
  }

  return null;
}
