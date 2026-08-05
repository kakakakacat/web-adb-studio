import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { adoptCredentialsFromUrl } from "./api";
import { App } from "./App";
import "./styles.css";

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
