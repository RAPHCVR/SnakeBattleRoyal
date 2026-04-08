import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { Direction } from "@snake-duel/shared";
import { useLocalGameStore } from "../game/localGameStore.js";
import { useTouchPadActions } from "../hooks/useInputControls.js";

type TouchMode = "local" | "online";
type Accent = "teal" | "orange" | "cyan";

interface TouchControlsDockProps {
  readonly mode: TouchMode;
  readonly suggestLandscape?: boolean;
  readonly fullscreenSupported?: boolean;
  readonly fullscreenActive?: boolean;
  readonly onToggleFullscreen?: () => void;
  readonly primaryActionLabel?: string;
  readonly onPrimaryAction?: () => void;
  readonly secondaryActionLabel?: string;
  readonly onSecondaryAction?: () => void;
  readonly floating?: boolean;
  readonly compact?: boolean;
}

interface DirectionalPadProps {
  readonly title: string;
  readonly subtitle: string;
  readonly accent: Accent;
  readonly onInput: (direction: Direction) => boolean;
  readonly compact?: boolean;
  readonly hideMeta?: boolean;
}

const DIRECTION_LABELS: Readonly<Record<Direction, string>> = {
  up: "Haut",
  left: "Gauche",
  right: "Droite",
  down: "Bas",
};

export function TouchControlsDock({
  mode,
  suggestLandscape = false,
  fullscreenSupported = false,
  fullscreenActive = false,
  onToggleFullscreen,
  primaryActionLabel,
  onPrimaryAction,
  secondaryActionLabel,
  onSecondaryAction,
  floating = false,
  compact = false,
}: TouchControlsDockProps) {
  const enqueueLocalInput = useLocalGameStore((state) => state.enqueueLocalInput);
  const enqueueOnlineInput = useLocalGameStore((state) => state.enqueueOnlineInput);
  const showFullscreenToggle = fullscreenSupported && onToggleFullscreen;

  if (mode === "online") {
    return (
      <motion.aside
        key="touch-dock-online"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className={`touch-dock${floating ? " touch-dock--floating" : " touch-dock--online-inline"}`}
      >
        <div
          className={`touch-dock__inner ${
            floating ? "touch-dock__inner--floating" : "touch-dock__inner--online-inline"
          }`}
        >
          <div className="touch-dock__floating-header">
            <p className="touch-dock__floating-label">Online</p>
            <div className="touch-dock__floating-actions">
              {showFullscreenToggle ? (
                <FullscreenToggleButton
                  active={fullscreenActive}
                  onClick={onToggleFullscreen}
                  compact
                />
              ) : null}
              {secondaryActionLabel && onSecondaryAction ? (
                <button
                  type="button"
                  className="touch-pill-button touch-pill-button--compact"
                  onClick={onSecondaryAction}
                >
                  {secondaryActionLabel}
                </button>
              ) : null}
            </div>
          </div>
          <DirectionalPad
            title="Vous"
            subtitle="Tap rapide"
            accent="cyan"
            compact
            hideMeta
            onInput={enqueueOnlineInput}
          />
        </div>
      </motion.aside>
    );
  }

  if (floating) {
    return (
      <motion.aside
        key={`touch-dock-${mode}-floating`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="touch-dock touch-dock--floating"
      >
        <div className="touch-dock__inner touch-dock__inner--floating-local">
          <div className="touch-dock__floating-header">
            <p className="touch-dock__floating-label">Local</p>
            <div className="touch-dock__floating-actions">
              {primaryActionLabel && onPrimaryAction ? (
                <button
                  type="button"
                  className="touch-pill-button touch-pill-button--compact"
                  onClick={onPrimaryAction}
                >
                  {primaryActionLabel}
                </button>
              ) : null}
              {showFullscreenToggle ? (
                <FullscreenToggleButton
                  active={fullscreenActive}
                  onClick={onToggleFullscreen}
                  compact
                />
              ) : null}
            </div>
          </div>

          <div className="touch-dock__pads touch-dock__pads--local">
            <DirectionalPad
              title="J1"
              subtitle="Pouce gauche"
              accent="teal"
              compact
              hideMeta
              onInput={(direction) => enqueueLocalInput("player1", direction)}
            />
            <DirectionalPad
              title="J2"
              subtitle="Pouce droit"
              accent="orange"
              compact
              hideMeta
              onInput={(direction) => enqueueLocalInput("player2", direction)}
            />
          </div>
        </div>
      </motion.aside>
    );
  }

  return (
    <motion.aside
      key={`touch-dock-${mode}`}
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 18 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="touch-dock"
    >
      <div className="touch-dock__inner">
        <div className="touch-dock__header">
          <div>
            <p className="touch-dock__eyebrow">Commandes tactiles</p>
            <h2 className="touch-dock__title">
              {mode === "local" ? "Deux D-pads optimises pouces" : "D-pad rapide et lisible"}
            </h2>
          </div>
          <div className="touch-dock__header-copy">
            <p className="touch-dock__copy">
              {mode === "local"
                ? "Chaque joueur a sa zone. Un tap = une direction bufferisee."
                : "Tape la direction voulue. Le buffer garde les intentions rapides."}
            </p>
            {showFullscreenToggle ? (
              <FullscreenToggleButton
                active={fullscreenActive}
                onClick={onToggleFullscreen}
                compact={mode === "local"}
              />
            ) : null}
          </div>
        </div>

        {mode === "local" ? (
          <div className="touch-dock__note">
            <span className="touch-dock__note-pill">
              {suggestLandscape
                ? "Astuce mobile: passe en paysage pour un pad par joueur sur chaque cote."
                : "Deux pads separes pour bufferiser les changements de direction."}
            </span>
          </div>
        ) : null}

        <div className={`touch-dock__pads touch-dock__pads--${mode}`}>
          {mode === "local" ? (
            <>
              <DirectionalPad
                title="J1"
                subtitle="Pouce gauche"
                accent="teal"
                compact={compact}
                onInput={(direction) => enqueueLocalInput("player1", direction)}
              />
              <DirectionalPad
                title="J2"
                subtitle="Pouce droit"
                accent="orange"
                compact={compact}
                onInput={(direction) => enqueueLocalInput("player2", direction)}
              />
            </>
          ) : null}
        </div>
      </div>
    </motion.aside>
  );
}

interface LandscapeSplitControlsProps {
  readonly player1Score: number;
  readonly player1Length: number;
  readonly player2Score: number;
  readonly player2Length: number;
  readonly paused: boolean;
  readonly showPauseAction: boolean;
  readonly onTogglePause: () => void;
  readonly fullscreenSupported: boolean;
  readonly fullscreenActive: boolean;
  readonly onToggleFullscreen: () => void;
}

export function LandscapeSplitControls({
  player1Score,
  player1Length,
  player2Score,
  player2Length,
  paused,
  showPauseAction,
  onTogglePause,
  fullscreenSupported,
  fullscreenActive,
  onToggleFullscreen,
}: LandscapeSplitControlsProps) {
  const enqueueLocalInput = useLocalGameStore((state) => state.enqueueLocalInput);

  return (
    <motion.aside
      key="touch-side-controls"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="touch-side-controls"
      aria-label="Commandes tactiles paysage"
    >
      <div className="touch-side-controls__header">
        <div className="touch-side-controls__intro">
          <p className="touch-side-controls__eyebrow">Mode duel mobile</p>
          <p className="touch-side-controls__copy">
            Un pad par joueur, chacun garde son bord du telephone.
          </p>
        </div>
        <div className="touch-side-controls__actions">
          <CompactHudPill title="J1" value={`${player1Score} pts`} detail={`L${player1Length}`} accent="teal" />
          <CompactHudPill title="J2" value={`${player2Score} pts`} detail={`L${player2Length}`} accent="orange" />
          {showPauseAction ? (
            <button
              type="button"
              className="touch-pill-button touch-pill-button--compact"
              onClick={onTogglePause}
            >
              {paused ? "Reprendre" : "Pause"}
            </button>
          ) : null}
          {fullscreenSupported ? (
            <FullscreenToggleButton active={fullscreenActive} onClick={onToggleFullscreen} compact />
          ) : null}
        </div>
      </div>

      <div className="touch-side-controls__columns">
        <div className="touch-side-controls__panel touch-side-controls__panel--left">
          <DirectionalPad
            title="J1"
            subtitle="Main gauche"
            accent="teal"
            onInput={(direction) => enqueueLocalInput("player1", direction)}
          />
        </div>
        <div className="touch-side-controls__panel touch-side-controls__panel--right">
          <DirectionalPad
            title="J2"
            subtitle="Main droite"
            accent="orange"
            onInput={(direction) => enqueueLocalInput("player2", direction)}
          />
        </div>
      </div>
    </motion.aside>
  );
}

function DirectionalPad({
  title,
  subtitle,
  accent,
  onInput,
  compact = false,
  hideMeta = false,
}: DirectionalPadProps) {
  const [activeDirection, setActiveDirection] = useState<Direction | null>(null);
  const actions = useTouchPadActions();
  const actionsByDirection = useMemo(
    () => new Map(actions.map((action) => [action.direction, action])),
    [actions],
  );

  const pressDirection = (direction: Direction) => {
    setActiveDirection(direction);
    const accepted = onInput(direction);

    if (accepted) {
      triggerHapticFeedback();
    }
  };

  return (
    <section
      className={`touch-pad touch-pad--${accent}${compact ? " touch-pad--compact" : ""}`}
      aria-label={`Pad ${title}`}
    >
      {hideMeta ? null : (
        <div className="touch-pad__meta">
          <span className="touch-pad__label">{title}</span>
          <span className="touch-pad__subtitle">{subtitle}</span>
        </div>
      )}

      <div className="touch-pad__matrix">
        <div className="touch-pad__spacer" aria-hidden="true" />
        {renderButton("up")}
        <div className="touch-pad__spacer" aria-hidden="true" />

        {renderButton("left")}
        <div className="touch-pad__core" aria-hidden="true">
          <span className="touch-pad__core-title">{title}</span>
          <span className="touch-pad__core-copy">{compact ? "Ready" : "Buffer x3"}</span>
        </div>
        {renderButton("right")}

        <div className="touch-pad__spacer" aria-hidden="true" />
        {renderButton("down")}
        <div className="touch-pad__spacer" aria-hidden="true" />
      </div>
    </section>
  );

  function renderButton(direction: Direction) {
    const action = actionsByDirection.get(direction);
    if (!action) {
      return <div className="touch-pad__spacer" aria-hidden="true" />;
    }

    const isActive = activeDirection === direction;
    return (
      <button
        key={`${title}-${direction}`}
        type="button"
        className={`touch-pad__button touch-pad__button--${direction}${isActive ? " is-active" : ""}`}
        aria-label={`${title} ${DIRECTION_LABELS[direction]}`}
        onPointerDown={(event) => {
          event.preventDefault();
          pressDirection(direction);
        }}
        onClick={(event) => {
          if (event.detail === 0) {
            pressDirection(direction);
          }
        }}
        onPointerUp={() => setActiveDirection(null)}
        onPointerCancel={() => setActiveDirection(null)}
        onPointerLeave={() => setActiveDirection(null)}
        onBlur={() => setActiveDirection(null)}
        onContextMenu={(event) => event.preventDefault()}
      >
        <ArrowIcon direction={direction} />
        <span className="touch-pad__button-glyph" aria-hidden="true">
          {action.label}
        </span>
      </button>
    );
  }
}

function ArrowIcon({ direction }: { readonly direction: Direction }) {
  const rotation = getArrowRotation(direction);

  return (
    <svg
      className="touch-pad__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: `rotate(${rotation}deg)` }}
      aria-hidden="true"
    >
      <path d="M12 5v14" />
      <path d="M6 11l6-6 6 6" />
    </svg>
  );
}

function getArrowRotation(direction: Direction): number {
  if (direction === "right") {
    return 90;
  }
  if (direction === "down") {
    return 180;
  }
  if (direction === "left") {
    return -90;
  }
  return 0;
}

function triggerHapticFeedback(): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
    return;
  }

  navigator.vibrate(12);
}

interface FullscreenToggleButtonProps {
  readonly active: boolean;
  readonly onClick?: () => void;
  readonly compact?: boolean;
}

function FullscreenToggleButton({
  active,
  onClick,
  compact = false,
}: FullscreenToggleButtonProps) {
  if (!onClick) {
    return null;
  }

  return (
    <button
      type="button"
      className={`touch-pill-button touch-pill-button--fullscreen${compact ? " touch-pill-button--compact" : ""}`}
      onClick={onClick}
    >
      {active ? "Quitter plein ecran" : "Plein ecran"}
    </button>
  );
}

interface CompactHudPillProps {
  readonly title: string;
  readonly value: string;
  readonly detail: string;
  readonly accent: Exclude<Accent, "cyan">;
}

function CompactHudPill({ title, value, detail, accent }: CompactHudPillProps) {
  return (
    <div className={`touch-hud-pill touch-hud-pill--${accent}`}>
      <span className="touch-hud-pill__title">{title}</span>
      <span className="touch-hud-pill__value">{value}</span>
      <span className="touch-hud-pill__detail">{detail}</span>
    </div>
  );
}
