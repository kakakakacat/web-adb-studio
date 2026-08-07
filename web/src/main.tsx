import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { adoptCredentialsFromUrl } from "./api";
import { bundleVersion, initDiag } from "./diag";
import { App } from "./App";
import { useStore } from "./store";
import "./styles.css";

// A deliberate handle on the store, for the verify scripts and for debugging a
// user's machine from the console. Some states — "an adb server owns this device"
// above all — cannot be reached from outside without the very setup that causes
// them, so without this they'd ship unlooked-at. It exposes nothing the page
// doesn't already have.
(window as unknown as { __adbstudio: unknown }).__adbstudio = { store: useStore };

// Start collecting before anything else runs: the interesting failures happen
// during the first connect attempt.
initDiag(bundleVersion());

// Before the app reads any config: pick up `#token=…&api=…` from a share link and
// clear it from the URL bar.
adoptCredentialsFromUrl();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
