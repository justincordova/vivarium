import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// B1 scaffold placeholder — replaced in Phase 2C by the real app shell
// (worker init + store wiring + <App/>). Kept minimal so the dev server and
// build have a valid entry to boot against.
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <div className="tabular" style={{ padding: 16 }}>
      vivarium — scaffold
    </div>
  </StrictMode>,
);
