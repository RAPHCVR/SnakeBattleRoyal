// @vitest-environment jsdom

import "./test/setup-component.js";

import { render, screen } from "@testing-library/react";
import { DEFAULT_GAME_CONFIG, type GameState, type SnakeState } from "@snake-duel/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  controls: {
    coarsePointer: false,
    orientation: "portrait" as "portrait" | "landscape",
    fullscreen: {
      supported: false,
      active: false,
      toggle: vi.fn(async () => false),
    },
  },
  destroyLocalGameLoop: vi.fn(),
  keyboardControls: vi.fn(),
  storeState: null as Record<string, unknown> | null,
}));

vi.mock("framer-motion", async () => {
  const React = await import("react");

  return {
    AnimatePresence: ({ children }: { readonly children: React.ReactNode }) => <>{children}</>,
    motion: new Proxy(
      {},
      {
        get: (_target, tag) =>
          ({ children, ...props }: { readonly children?: React.ReactNode } & Record<string, unknown>) =>
            React.createElement(tag as string, props, children as React.ReactNode),
      },
    ),
  };
});

vi.mock("./game/localGameStore.js", () => ({
  destroyLocalGameLoop: mocks.destroyLocalGameLoop,
  useLocalGameStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mocks.storeState ?? {}),
}));

vi.mock("./hooks/useInputControls.js", () => ({
  useKeyboardControls: mocks.keyboardControls,
  useIsCoarsePointer: () => mocks.controls.coarsePointer,
  useViewportOrientation: () => mocks.controls.orientation,
  useFullscreenSession: () => mocks.controls.fullscreen,
}));

vi.mock("./components/PhaserViewport.js", () => ({
  PhaserViewport: () => <div data-testid="phaser-viewport" />,
}));

vi.mock("./components/TouchControlsDock.js", () => ({
  TouchControlsDock: ({ mode }: { readonly mode: string }) => (
    <div data-testid="touch-controls-dock">dock:{mode}</div>
  ),
  LandscapeSplitControls: () => <div data-testid="touch-controls-landscape">landscape</div>,
}));

import { App } from "./App.js";

describe("App component states", () => {
  beforeEach(() => {
    mocks.controls.coarsePointer = false;
    mocks.controls.orientation = "portrait";
    mocks.controls.fullscreen.supported = false;
    mocks.controls.fullscreen.active = false;
    mocks.controls.fullscreen.toggle.mockClear();
    mocks.destroyLocalGameLoop.mockClear();
    mocks.keyboardControls.mockClear();
    mocks.storeState = createStoreState();
  });

  it("renders touch controls during a running local match on touch devices", async () => {
    mocks.controls.coarsePointer = true;
    mocks.storeState = createStoreState({
      mode: "local",
      gameState: createGameState("running"),
    });

    render(<App />);

    expect(await screen.findByTestId("touch-controls-dock")).toHaveTextContent("dock:local");
    expect(screen.getByText("Chargement du rendu Phaser...")).toBeInTheDocument();
  });

  it("hides touch controls after local game over while keeping the end screen visible", () => {
    mocks.controls.coarsePointer = true;
    mocks.storeState = createStoreState({
      mode: "local",
      gameState: createGameState("game_over", { winner: "draw" }),
    });

    render(<App />);

    expect(screen.queryByTestId("touch-controls-dock")).not.toBeInTheDocument();
    expect(screen.getByText("Game Over")).toBeInTheDocument();
    expect(screen.getByText("Match nul")).toBeInTheDocument();
  });

  it("shows the waiting overlay without touch controls for a solo online room", () => {
    mocks.controls.coarsePointer = true;
    mocks.storeState = createStoreState({
      mode: "online",
      gameState: createGameState("waiting"),
      online: {
        connectedPlayers: 1,
        ownSnakeId: "player1",
        roomId: "ABCD",
        roomStatus: "waiting",
        waitingForOpponent: true,
      },
    });

    render(<App />);

    expect(screen.queryByTestId("touch-controls-dock")).not.toBeInTheDocument();
    expect(screen.getAllByText("Room en attente")).not.toHaveLength(0);
    expect(screen.getByText(/En attente d'un adversaire/i)).toBeInTheDocument();
  });

  it("exposes compact network telemetry during online play", () => {
    mocks.storeState = createStoreState({
      mode: "online",
      gameState: createGameState("running"),
      online: {
        ownSnakeId: "player1",
        roomId: "ABCD",
        roomStatus: "running",
        network: {
          latencyMs: 38,
          jitterMs: 7,
          quality: "excellent",
          pendingInputs: 1,
          lastSentSequence: 4,
          lastProcessedSequence: 3,
          correctionCount: 0,
          lastCorrectionDistance: 0,
          predictionLeadTicks: 1,
        },
      },
    });

    render(<App />);

    expect(screen.getByText("Ping 38ms")).toBeInTheDocument();
    expect(screen.getByText("Jitter 7ms")).toBeInTheDocument();
    expect(screen.getByText("Queue 1")).toBeInTheDocument();
  });
});

function createStoreState(
  overrides: Partial<{
    mode: string;
    gameState: GameState;
    online: Partial<Record<string, unknown>>;
  }> = {},
): Record<string, unknown> {
  return {
    mode: overrides.mode ?? "menu",
    gameState: overrides.gameState ?? createGameState("waiting"),
    transition: null,
    session: {
      roundNumber: 0,
      player1Wins: 0,
      player2Wins: 0,
    },
    online: {
      connecting: false,
      roomId: null,
      ownSnakeId: null,
      connectedPlayers: 0,
      roomStatus: null,
      waitingForOpponent: false,
      rematchVotes: { player1: false, player2: false },
      rematchVoted: false,
      waitingOpponentRematch: false,
      lastError: null,
      authoritativeTick: 0,
      displayTick: 0,
      network: {
        latencyMs: null,
        jitterMs: null,
        quality: "unknown",
        pendingInputs: 0,
        lastSentSequence: 0,
        lastProcessedSequence: 0,
        correctionCount: 0,
        lastCorrectionDistance: 0,
        predictionLeadTicks: 0,
      },
      ...(overrides.online ?? {}),
    },
    startLocalGame: vi.fn(),
    restartLocalGame: vi.fn(),
    startOnlineMatchmaking: vi.fn(),
    cancelMatchmaking: vi.fn(),
    voteRematch: vi.fn(),
    returnToMenu: vi.fn(),
    togglePause: vi.fn(),
  };
}

function createGameState(
  status: GameState["status"],
  overrides: Partial<GameState> = {},
): GameState {
  return {
    status,
    config: DEFAULT_GAME_CONFIG,
    snakes: [createSnake("player1"), createSnake("player2")],
    food: { x: 10, y: 10 },
    winner: null,
    ...overrides,
  };
}

function createSnake(id: SnakeState["id"]): SnakeState {
  if (id === "player1") {
    return {
      id,
      body: [
        { x: 2, y: 10 },
        { x: 1, y: 10 },
        { x: 0, y: 10 },
      ],
      direction: "right",
      alive: true,
      score: 0,
    };
  }

  return {
    id,
    body: [
      { x: 17, y: 10 },
      { x: 18, y: 10 },
      { x: 19, y: 10 },
    ],
    direction: "left",
    alive: true,
    score: 0,
  };
}
