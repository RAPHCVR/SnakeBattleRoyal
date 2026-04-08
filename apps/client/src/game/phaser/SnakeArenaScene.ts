import type { GameState, GridPosition, SnakeState } from "@snake-duel/shared";
import Phaser from "phaser";
import { useLocalGameStore } from "../localGameStore.js";
import { resolveRemoteInterpolationDelayMs } from "../localGameStore.helpers.js";
import { FOOD_PARTICLE_TEXTURE, GRID_HEIGHT, GRID_WIDTH } from "./constants.js";
import {
  computeArenaBoardLayout,
  getBoardSegmentSize,
  toBoardPosition,
  type ArenaBoardLayout,
} from "./boardLayout.js";
import {
  alignWorldPosition,
  interpolateTimedWorld,
  resolveWrappedWorld,
  sampleBufferedWorld,
  type BufferedWorldSample,
  type WorldPoint,
} from "./segmentMotion.js";

type SegmentNode = Phaser.GameObjects.Rectangle;

interface TimedSegmentMotion {
  readonly kind: "timed";
  currentWorld: WorldPoint;
  startWorld: WorldPoint;
  targetWorld: WorldPoint;
  startedAtMs: number;
  durationMs: number;
}

interface BufferedSegmentMotion {
  readonly kind: "buffered";
  currentWorld: WorldPoint;
  snapshots: BufferedWorldSample[];
  interpolationDelayMs: number;
}

type SegmentMotion = TimedSegmentMotion | BufferedSegmentMotion;

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
  private readonly segmentMotion = new Map<string, SegmentMotion>();
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

  public override update(_time: number, delta: number): void {
    this.renderFromStore(false);
    this.advanceSegmentMotion(delta, this.time.now);
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
    this.segmentMotion.clear();
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
    const remoteInterpolationDelayMs =
      storeState.mode === "online" ? state.config.tickRateMs : transitionDurationMs;
    const onlineRemoteInterpolationDelayMs =
      storeState.mode === "online"
        ? resolveRemoteInterpolationDelayMs({
            tickRateMs: state.config.tickRateMs,
            latencyMs: storeState.online.network.latencyMs,
            jitterMs: storeState.online.network.jitterMs,
          })
        : remoteInterpolationDelayMs;
    const snapPositions =
      force ||
      this.snapNextRender ||
      !previous ||
      previous.status !== state.status ||
      state.status !== "running";
    const nowMs = this.time.now;

    this.syncFood(state, previous, layout, snapPositions);
    this.syncSnakes(
      state,
      previous,
      layout,
      snapPositions,
      transitionDurationMs,
      onlineRemoteInterpolationDelayMs,
      ownSnakeId,
      nowMs,
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
    remoteInterpolationDelayMs: number,
    ownSnakeId: SnakeState["id"] | null,
    nowMs: number,
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
        const ghost = this.ensureWrapGhostNode(ghostKey, snake, index, visualAlive, layout);
        activeGhostKeys.add(ghostKey);
        const target = toBoardPosition(layout, segment);
        const from = previousSnake?.body[index];
        const motion = this.segmentMotion.get(key);
        const remoteSnake = ownSnakeId !== null && snake.id !== ownSnakeId;

        if (snapPositions || !from || !motion) {
          const snappedWorld = { ...target };
          this.segmentMotion.set(
            key,
            remoteSnake
              ? {
                  kind: "buffered",
                  currentWorld: snappedWorld,
                  snapshots: [{ atMs: nowMs, world: snappedWorld }],
                  interpolationDelayMs: remoteInterpolationDelayMs,
                }
              : {
                  kind: "timed",
                  currentWorld: snappedWorld,
                  startWorld: snappedWorld,
                  targetWorld: snappedWorld,
                  startedAtMs: nowMs,
                  durationMs: 0,
                },
          );
          this.renderSegmentWorld(node, ghost, layout, snappedWorld);
          continue;
        }

        if (remoteSnake) {
          const lastWorld =
            motion.kind === "buffered"
              ? (motion.snapshots.at(-1)?.world ?? motion.currentWorld)
              : motion.currentWorld;
          const alignedTarget = alignWorldPosition(layout, lastWorld, segment);
          const previousSnapshot = motion.kind === "buffered" ? motion.snapshots.at(-1) : null;
          const nextSnapshots =
            previousSnapshot &&
            areSameWorldPoint(previousSnapshot.world, alignedTarget)
              ? motion.kind === "buffered"
                ? motion.snapshots
                : [{ atMs: nowMs, world: alignedTarget }]
              : [
                  ...(motion.kind === "buffered" ? motion.snapshots : []),
                  { atMs: nowMs, world: alignedTarget },
                ].slice(-4);

          this.segmentMotion.set(key, {
            kind: "buffered",
            currentWorld: motion.currentWorld,
            snapshots: nextSnapshots,
            interpolationDelayMs: remoteInterpolationDelayMs,
          });
          continue;
        }

        const alignedTarget = alignWorldPosition(layout, motion.currentWorld, segment);
        this.segmentMotion.set(key, {
          kind: "timed",
          currentWorld: motion.currentWorld,
          startWorld: motion.currentWorld,
          targetWorld: alignedTarget,
          startedAtMs: nowMs,
          durationMs: transitionDurationMs,
        });
      }
    }

    for (const [key, node] of this.segments) {
      if (activeKeys.has(key)) {
        continue;
      }
      node.destroy();
      this.segments.delete(key);
      this.segmentMotion.delete(key);
    }

    for (const [key, node] of this.wrapGhosts) {
      if (activeGhostKeys.has(key)) {
        continue;
      }
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

  private advanceSegmentMotion(deltaMs: number, nowMs: number): void {
    const layout = this.layout;
    if (!layout) {
      return;
    }

    for (const [key, motion] of this.segmentMotion) {
      const node = this.segments.get(key);
      const ghost = this.wrapGhosts.get(`${key}::wrap`);
      if (!node || !ghost) {
        continue;
      }

      let world = motion.currentWorld;
      if (motion.kind === "timed") {
        world = interpolateTimedWorld(
          motion.startWorld,
          motion.targetWorld,
          nowMs - motion.startedAtMs,
          motion.durationMs,
        );
        motion.currentWorld = world;
      } else {
        const renderAtMs = nowMs - motion.interpolationDelayMs;
        const sampledWorld = sampleBufferedWorld(motion.snapshots, renderAtMs);
        if (sampledWorld) {
          world = sampledWorld;
          motion.currentWorld = world;
        }

        while (motion.snapshots.length > 2 && motion.snapshots[1] && motion.snapshots[1]!.atMs <= renderAtMs) {
          motion.snapshots.shift();
        }
      }

      this.renderSegmentWorld(node, ghost, layout, world);
    }
  }

  private renderSegmentWorld(
    node: SegmentNode,
    ghost: SegmentNode,
    layout: ArenaBoardLayout,
    world: WorldPoint,
  ): void {
    const wrapped = resolveWrappedWorld(layout, world);
    node.setPosition(wrapped.primary.x, wrapped.primary.y);

    if (wrapped.ghost) {
      ghost.setVisible(true);
      ghost.setPosition(wrapped.ghost.x, wrapped.ghost.y);
      return;
    }

    ghost.setVisible(false);
  }

  private clearWrapGhost(key: string): void {
    const ghost = this.wrapGhosts.get(key);
    if (!ghost) {
      return;
    }

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

function areSameWorldPoint(a: WorldPoint, b: WorldPoint): boolean {
  return a.x === b.x && a.y === b.y;
}
