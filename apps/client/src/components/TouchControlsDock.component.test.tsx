// @vitest-environment jsdom

import "../test/setup-component.js";

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueLocalInput: vi.fn(),
  enqueueOnlineInput: vi.fn(),
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

vi.mock("../game/localGameStore.js", () => ({
  useLocalGameStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mocks.storeState ?? {}),
}));

import { TouchControlsDock } from "./TouchControlsDock.js";

describe("TouchControlsDock", () => {
  beforeEach(() => {
    mocks.enqueueLocalInput.mockReset();
    mocks.enqueueOnlineInput.mockReset();
    mocks.storeState = {
      enqueueLocalInput: mocks.enqueueLocalInput,
      enqueueOnlineInput: mocks.enqueueOnlineInput,
    };
  });

  it("routes local pointer input to the correct snake", () => {
    mocks.enqueueLocalInput.mockReturnValue(true);

    render(
      <TouchControlsDock
        mode="local"
        floating
        compact
        primaryActionLabel="Pause"
        onPrimaryAction={vi.fn()}
      />,
    );

    screen
      .getByRole("button", { name: "J2 Droite" })
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));

    expect(mocks.enqueueLocalInput).toHaveBeenCalledWith("player2", "right");
  });

  it("accepts keyboard-style click activation in online mode", () => {
    mocks.enqueueOnlineInput.mockReturnValue(true);

    render(<TouchControlsDock mode="online" secondaryActionLabel="Quitter" onSecondaryAction={vi.fn()} />);

    const upButton = screen.getByRole("button", { name: "Vous Haut" });
    upButton.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));

    expect(mocks.enqueueOnlineInput).toHaveBeenCalledWith("up");
  });
});
