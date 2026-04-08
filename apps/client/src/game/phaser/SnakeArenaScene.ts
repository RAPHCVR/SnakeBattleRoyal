import type { GameState, GridPosition, SnakeState } from "@snake-duel/shared";
import Phaser from "phaser";
import { useLocalGameStore } from "../localGameStore.js";
import { FOOD_PARTICLE_TEXTURE, GRID_HEIGHT, GRID_WIDTH } from "./constants.js";
import {
  computeArenaBoardLayout,
  getBoardSegmentSize,
  toBoardPosition,
  type ArenaBoardLayout,
} from "./boardLayout.js";
import { computeWrapTweenPlan } from "./wrapMotion.js";

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
  private readonly wrapGhosts = new Map<string, SegmentNode>();
  private boardGraphics: Phaser.GameObjects.Graphics | null = null;
  private foodNode: Phaser.GameObjects.Arc | null = null;
  private foodPulseTween: Phaser.Tweens.Tween | null = null;
  private layout: ArenaBoardLayout | null = null;
  private renderVersion = -1;
  private snapNextRender = false;

  public constructor() {
    super({ key: "SnakeArenaScene" });
  }

  public create(): void {
    this.boardGraphics = this.add.graphics().setDepth(0);
    this.ensureParticleTexture();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown, this);
    this.handleResize();
  }

  public override update(): void {
    this.renderFromStore(false);
  }

  private handleResize(): void {
    this.layout = computeArenaBoardLayout({
      width: this.scale.width,
      height: this.scale.height,
    });
    this.drawBoardBackground();
    this.snapNextRender = true;
    this.renderFromStore(true);
  }

  private handleShutdown(): void {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.foodPulseTween?.stop();
    this.foodPulseTween = null;
    this.boardGraphics = null;
    this.layout = null;

    for (const node of this.wrapGhosts.values()) {
      node.destroy();
    }
    this.wrapGhosts.clear();
  }

  private renderFromStore(force: boolean): void {
    const layout = this.layout;
    if (!layout) {
      return;
    }

    const storeState = useLocalGameStore.getState();
    if (!force && storeState.renderVersion === this.renderVersion) {
      return;
    }

    this.renderVersion = storeState.renderVersion;
    const state = storeState.gameState;
    const ownSnakeId = storeState.mode === "online" ? storeState.online.ownSnakeId : null;
    const transition = storeState.transition;
    const previous = transition?.previous;
    const transitionDurationMs = Math.max(1, transition?.durationMs ?? state.config.tickRateMs);
    const remoteTransitionDurationMs =
      storeState.mode === "online" ? state.config.tickRateMs : transitionDurationMs;
    const snapPositions = force || this.snapNextRender;

    this.syncFood(state, previous, layout, snapPositions);
    this.syncSnakes(
      state,
      previous,
      layout,
      snapPositions,
      transitionDurationMs,
      remoteTransitionDurationMs,
      ownSnakeId,
    );
    this.snapNextRender = false;

    if (!force && transition?.foodEatenAt) {
      this.playEatBurst(transition.foodEatenAt);
    }
    if (!force && transition?.fatalCollision) {
      this.time.delayedCall(transitionDurationMs, () => {
        this.cameras.main.shake(200, 0.01);
      });
    }
  }

  private drawBoardBackground(): void {
    if (!this.boardGraphics || !this.layout) {
      return;
    }

    const graphics = this.boardGraphics;
    const layout = this.layout;
    const borderOffset = layout.borderWidth % 2 === 1 ? 0.5 : 0;
    const gridOffset = layout.gridLineWidth % 2 === 1 ? 0.5 : 0;

    graphics.clear();
    graphics.fillStyle(PALETTE.board, 1);
    graphics.fillRoundedRect(
      layout.offsetX,
      layout.offsetY,
      layout.boardWidth,
      layout.boardHeight,
      layout.borderRadius,
    );
    graphics.lineStyle(layout.borderWidth, PALETTE.boardBorder, 0.9);
    graphics.strokeRoundedRect(
      layout.offsetX + borderOffset,
      layout.offsetY + borderOffset,
      layout.boardWidth - borderOffset * 2,
      layout.boardHeight - borderOffset * 2,
      layout.borderRadius,
    );
    graphics.lineStyle(layout.gridLineWidth, PALETTE.gridLine, 0.35);
    for (let x = 1; x < GRID_WIDTH; x += 1) {
      const lineX = layout.offsetX + x * layout.cellSize + gridOffset;
      graphics.lineBetween(lineX, layout.offsetY, lineX, layout.offsetY + layout.boardHeight);
    }
    for (let y = 1; y < GRID_HEIGHT; y += 1) {
      const lineY = layout.offsetY + y * layout.cellSize + gridOffset;
      graphics.lineBetween(layout.offsetX, lineY, layout.offsetX + layout.boardWidth, lineY);
    }
  }

  private syncFood(
    state: GameState,
    previous: GameState | undefined,
    layout: ArenaBoardLayout,
    snapPositions: boolean,
  ): void {
    const food = state.food;
    if (!food) {
      this.foodNode?.destroy();
      this.foodNode = null;
      this.foodPulseTween?.stop();
      this.foodPulseTween = null;
      return;
    }

    const target = toBoardPosition(layout, food);
    if (!this.foodNode) {
      this.foodNode = this.add
        .circle(target.x, target.y, layout.foodRadius, PALETTE.food)
        .setDepth(12);
      this.startFoodPulse();
      return;
    }

    this.foodNode.setRadius(layout.foodRadius);
    const previousFood = previous?.food;
    const moved = Boolean(previousFood && (previousFood.x !== food.x || previousFood.y !== food.y));
    if (snapPositions || moved) {
      this.foodNode.setPosition(target.x, target.y);
      this.startFoodPulse();
    } else {
      this.foodNode.setPosition(target.x, target.y);
    }
  }

  private syncSnakes(
    state: GameState,
    previous: GameState | undefined,
    layout: ArenaBoardLayout,
    snapPositions: boolean,
    transitionDurationMs: number,
    remoteTransitionDurationMs: number,
    ownSnakeId: SnakeState["id"] | null,
  ): void {
    const previousById = new Map(previous?.snakes.map((snake) => [snake.id, snake]) ?? []);
    const activeKeys = new Set<string>();
    const activeGhostKeys = new Set<string>();

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
        const node = this.ensureSegmentNode(key, snake, index, visualAlive, layout);
        const ghostKey = `${key}::wrap`;
        const target = toBoardPosition(layout, segment);
        const from = previousSnake?.body[index];

        this.tweens.killTweensOf(node);
        if (snapPositions || !from) {
          node.setPosition(target.x, target.y);
          this.clearWrapGhost(ghostKey);
          continue;
        }

        if (areSameGridPosition(from, segment)) {
          node.setPosition(target.x, target.y);
          this.clearWrapGhost(ghostKey);
          continue;
        }

        const wrapTweenPlan = computeWrapTweenPlan(layout, from, segment);
        if (wrapTweenPlan) {
          const snakeTransitionDurationMs =
            ownSnakeId && snake.id !== ownSnakeId ? remoteTransitionDurationMs : transitionDurationMs;
          const ghost = this.ensureWrapGhostNode(ghostKey, snake, index, visualAlive, layout);
          activeGhostKeys.add(ghostKey);
          this.tweens.killTweensOf(ghost);
          node.setPosition(wrapTweenPlan.primaryStart.x, wrapTweenPlan.primaryStart.y);
          ghost.setPosition(wrapTweenPlan.ghostStart.x, wrapTweenPlan.ghostStart.y);

          this.tweens.add({
            targets: node,
            x: wrapTweenPlan.primaryTarget.x,
            y: wrapTweenPlan.primaryTarget.y,
            duration: snakeTransitionDurationMs,
            ease: "Linear",
          });
          this.tweens.add({
            targets: ghost,
            x: wrapTweenPlan.ghostTarget.x,
            y: wrapTweenPlan.ghostTarget.y,
            duration: snakeTransitionDurationMs,
            ease: "Linear",
            onComplete: () => {
              const activeGhost = this.wrapGhosts.get(ghostKey);
              if (activeGhost === ghost) {
                ghost.destroy();
                this.wrapGhosts.delete(ghostKey);
              }
            },
          });
          continue;
        }

        this.clearWrapGhost(ghostKey);
        const snakeTransitionDurationMs =
          ownSnakeId && snake.id !== ownSnakeId ? remoteTransitionDurationMs : transitionDurationMs;
        this.tweens.add({
          targets: node,
          x: target.x,
          y: target.y,
          duration: snakeTransitionDurationMs,
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

    for (const [key, node] of this.wrapGhosts) {
      if (activeGhostKeys.has(key)) {
        continue;
      }

      this.tweens.killTweensOf(node);
      node.destroy();
      this.wrapGhosts.delete(key);
    }
  }

  private ensureSegmentNode(
    key: string,
    snake: SnakeState,
    index: number,
    visualAlive: boolean,
    layout: ArenaBoardLayout,
  ): SegmentNode {
    const existing = this.segments.get(key);
    const alpha = visualAlive ? 1 : 0.72;
    const size = getBoardSegmentSize(layout, index);
    const color = getSnakeColor(snake, index, visualAlive);
    if (existing) {
      existing
        .setSize(size, size)
        .setDisplaySize(size, size)
        .setFillStyle(color)
        .setAlpha(alpha);
      return existing;
    }

    const node = this.add.rectangle(0, 0, size, size, color).setDepth(10);
    node.setAlpha(alpha);
    this.segments.set(key, node);
    return node;
  }

  private ensureWrapGhostNode(
    key: string,
    snake: SnakeState,
    index: number,
    visualAlive: boolean,
    layout: ArenaBoardLayout,
  ): SegmentNode {
    const existing = this.wrapGhosts.get(key);
    const alpha = visualAlive ? 1 : 0.72;
    const size = getBoardSegmentSize(layout, index);
    const color = getSnakeColor(snake, index, visualAlive);
    if (existing) {
      existing
        .setVisible(true)
        .setSize(size, size)
        .setDisplaySize(size, size)
        .setFillStyle(color)
        .setAlpha(alpha);
      return existing;
    }

    const node = this.add.rectangle(0, 0, size, size, color).setDepth(10);
    node.setAlpha(alpha);
    this.wrapGhosts.set(key, node);
    return node;
  }

  private clearWrapGhost(key: string): void {
    const ghost = this.wrapGhosts.get(key);
    if (!ghost) {
      return;
    }

    this.tweens.killTweensOf(ghost);
    ghost.destroy();
    this.wrapGhosts.delete(key);
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
    const layout = this.layout;
    if (!layout) {
      return;
    }

    const world = toBoardPosition(layout, cell);
    const emitter = this.add
      .particles(world.x, world.y, FOOD_PARTICLE_TEXTURE, {
        emitting: false,
        lifespan: 260,
        speed: { min: layout.cellSize * 0.9, max: layout.cellSize * 5.6 },
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

function areSameGridPosition(a: GridPosition, b: GridPosition): boolean {
  return a.x === b.x && a.y === b.y;
}
