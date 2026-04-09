import { useEffect, useMemo, useState } from "react";
import type { Direction, SnakeId } from "@snake-duel/shared";
import { useLocalGameStore } from "../game/localGameStore.js";

interface DirectionIntent {
  readonly snakeId: SnakeId;
  readonly direction: Direction;
}

const KEY_TO_INTENT: Record<string, DirectionIntent> = {
  w: { snakeId: "player1", direction: "up" },
  a: { snakeId: "player1", direction: "left" },
  s: { snakeId: "player1", direction: "down" },
  d: { snakeId: "player1", direction: "right" },
  ArrowUp: { snakeId: "player2", direction: "up" },
  ArrowLeft: { snakeId: "player2", direction: "left" },
  ArrowDown: { snakeId: "player2", direction: "down" },
  ArrowRight: { snakeId: "player2", direction: "right" },
};

const KEY_TO_DIRECTION: Record<string, Direction> = {
  w: "up",
  a: "left",
  s: "down",
  d: "right",
  ArrowUp: "up",
  ArrowLeft: "left",
  ArrowDown: "down",
  ArrowRight: "right",
};

const PREVENT_DEFAULT_KEYS = new Set<string>([
  " ",
  "Spacebar",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

export function useKeyboardControls(): void {
  const mode = useLocalGameStore((state) => state.mode);
  const enqueueLocalInput = useLocalGameStore((state) => state.enqueueLocalInput);
  const enqueueOnlineInput = useLocalGameStore((state) => state.enqueueOnlineInput);
  const togglePause = useLocalGameStore((state) => state.togglePause);

  useEffect(() => {
    if (mode !== "local" && mode !== "online") {
      return;
    }

    const handler = (event: KeyboardEvent) => {
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      if (PREVENT_DEFAULT_KEYS.has(event.key)) {
        event.preventDefault();
      }

      if (key === " ") {
        if (mode === "local") {
          togglePause();
        }
        return;
      }

      if (mode === "local") {
        const intent = KEY_TO_INTENT[key];
        if (!intent) {
          return;
        }
        event.preventDefault();
        enqueueLocalInput(intent.snakeId, intent.direction);
        return;
      }

      const direction = KEY_TO_DIRECTION[key];
      if (!direction) {
        return;
      }
      event.preventDefault();
      enqueueOnlineInput(direction);
    };

    window.addEventListener("keydown", handler, { passive: false });
    return () => window.removeEventListener("keydown", handler);
  }, [enqueueLocalInput, enqueueOnlineInput, mode, togglePause]);
}

export function useIsCoarsePointer(): boolean {
  const [isCoarse, setIsCoarse] = useState(false);

  useEffect(() => {
    const coarsePointerMedia = window.matchMedia("(pointer: coarse)");
    const anyCoarsePointerMedia = window.matchMedia("(any-pointer: coarse)");
    const noHoverMedia = window.matchMedia("(hover: none)");

    const sync = () => setIsCoarse(readTouchUiCapability());
    const cleanup = [
      observeMediaQuery(coarsePointerMedia, sync),
      observeMediaQuery(anyCoarsePointerMedia, sync),
      observeMediaQuery(noHoverMedia, sync),
    ];

    sync();
    return () => cleanup.forEach((dispose) => dispose());
  }, []);

  return isCoarse;
}

export type ViewportOrientation = "portrait" | "landscape";

export function useViewportOrientation(): ViewportOrientation {
  const [orientation, setOrientation] = useState<ViewportOrientation>("portrait");

  useEffect(() => {
    const media = window.matchMedia("(orientation: landscape)");
    return observeMediaQuery(media, (matches) => {
      setOrientation(matches ? "landscape" : "portrait");
    });
  }, []);

  return orientation;
}

interface FullscreenState {
  readonly supported: boolean;
  readonly active: boolean;
  readonly toggle: (target?: HTMLElement | null) => Promise<boolean>;
}

type FullscreenCapableElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FullscreenCapableDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
};

type LockableScreenOrientation = ScreenOrientation & {
  lock?: (orientation: "landscape" | "portrait") => Promise<void>;
  unlock?: () => void;
};

export function useFullscreenSession(): FullscreenState {
  const [state, setState] = useState(() => readFullscreenState());

  useEffect(() => {
    const sync = () => setState(readFullscreenState());

    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync as EventListener);

    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync as EventListener);
    };
  }, []);

  const toggle = async (target?: HTMLElement | null) => {
    const active = isFullscreenActive();

    if (active) {
      await exitFullscreen();
      setState(readFullscreenState());
      return false;
    }

    const element = target ?? document.documentElement;
    const entered = await requestFullscreen(element);
    setState(readFullscreenState());
    return entered;
  };

  return {
    supported: state.supported,
    active: state.active,
    toggle,
  };
}

interface TouchPadAction {
  readonly label: string;
  readonly direction: Direction;
}

const TOUCH_PAD_ACTIONS: readonly TouchPadAction[] = [
  { label: "↑", direction: "up" },
  { label: "←", direction: "left" },
  { label: "↓", direction: "down" },
  { label: "→", direction: "right" },
];

export function useTouchPadActions(): readonly TouchPadAction[] {
  return useMemo(() => TOUCH_PAD_ACTIONS, []);
}

interface TouchUiCapabilityInput {
  readonly hasTouchPoints: boolean;
  readonly primaryCoarsePointer: boolean;
  readonly anyCoarsePointer: boolean;
  readonly primaryFinePointer: boolean;
  readonly noHover: boolean;
}

export function shouldUseTouchUi(input: TouchUiCapabilityInput): boolean {
  if (input.primaryCoarsePointer) {
    return true;
  }

  if (input.primaryFinePointer) {
    return false;
  }

  return input.noHover && (input.anyCoarsePointer || input.hasTouchPoints);
}

function observeMediaQuery(
  media: MediaQueryList,
  onChange: (matches: boolean) => void,
): () => void {
  const apply = () => onChange(media.matches);

  apply();

  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }

  media.addListener(apply);
  return () => media.removeListener(apply);
}

function readTouchUiCapability(): boolean {
  const hasTouchPoints =
    typeof navigator !== "undefined" &&
    (navigator.maxTouchPoints > 0 || "ontouchstart" in window);

  const primaryCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const anyCoarsePointer = window.matchMedia("(any-pointer: coarse)").matches;
  const primaryFinePointer = window.matchMedia("(pointer: fine)").matches;
  const noHover = window.matchMedia("(hover: none)").matches;

  return shouldUseTouchUi({
    hasTouchPoints,
    primaryCoarsePointer,
    anyCoarsePointer,
    primaryFinePointer,
    noHover,
  });
}

function readFullscreenState(): Pick<FullscreenState, "supported" | "active"> {
  if (typeof document === "undefined") {
    return { supported: false, active: false };
  }

  const fullscreenDocument = document as FullscreenCapableDocument;
  return {
    supported: Boolean(
      document.fullscreenEnabled ?? fullscreenDocument.webkitFullscreenEnabled ?? false,
    ),
    active: isFullscreenActive(),
  };
}

function isFullscreenActive(): boolean {
  const fullscreenDocument = document as FullscreenCapableDocument;
  return Boolean(document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement);
}

async function requestFullscreen(target: HTMLElement): Promise<boolean> {
  const fullscreenTarget = target as FullscreenCapableElement;
  if (typeof target.requestFullscreen === "function") {
    try {
      await target.requestFullscreen({ navigationUI: "hide" });
      await lockLandscapeOrientation();
      return true;
    } catch {
      try {
        await target.requestFullscreen();
        await lockLandscapeOrientation();
        return true;
      } catch {
        return false;
      }
    }
  }

  const nativeRequest = fullscreenTarget.webkitRequestFullscreen;
  if (!nativeRequest) {
    return false;
  }

  try {
    await nativeRequest.call(target);
    await lockLandscapeOrientation();
    return true;
  } catch {
    return false;
  }
}

async function exitFullscreen(): Promise<void> {
  const fullscreenDocument = document as FullscreenCapableDocument;
  const nativeExit =
    typeof document.exitFullscreen === "function"
      ? () => document.exitFullscreen()
      : fullscreenDocument.webkitExitFullscreen;

  try {
    if (nativeExit) {
      await nativeExit.call(document);
    }
  } catch {
    // Ignore browser-specific exit failures and keep the UI usable.
  }

  try {
    const orientation = screen.orientation as LockableScreenOrientation | undefined;
    orientation?.unlock?.();
  } catch {
    // Ignore orientation unlock failures on unsupported browsers.
  }
}

async function lockLandscapeOrientation(): Promise<void> {
  try {
    const orientation = screen.orientation as LockableScreenOrientation | undefined;
    await orientation?.lock?.("landscape");
  } catch {
    // Ignore unsupported orientation lock requests.
  }
}
