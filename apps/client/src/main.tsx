import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

await loadRuntimeConfig();

const { App } = await import("./App.js");

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element '#root' is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

function loadRuntimeConfig(): Promise<void> {
  if (typeof document === "undefined") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[data-runtime-config="snake-duel"]',
    );

    if (existingScript) {
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.src = "/runtime-config.js";
    script.async = false;
    script.dataset.runtimeConfig = "snake-duel";
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.append(script);
  });
}
