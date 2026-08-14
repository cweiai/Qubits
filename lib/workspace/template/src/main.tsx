import React from "react";
import { createRoot } from "react-dom/client";
// Side-effect import: starts the Qubits SDK bridge handshake (system-owned file).
import "./lib/qubits";
import { App } from "./App";
import "./styles.css";

function ensureRoot(): HTMLElement {
  const existing = document.getElementById("qubits-root");
  if (existing) return existing;
  const el = document.createElement("div");
  el.id = "qubits-root";
  document.body.appendChild(el);
  return el;
}

createRoot(ensureRoot()).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
