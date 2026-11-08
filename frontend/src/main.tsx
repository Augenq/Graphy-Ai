import "./material";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initBackend } from "./lib/backend";
import { initSettings } from "./lib/settings";
import { initRipple } from "./lib/ripple";
import "./styles/motion.css";
import "./index.css";
import "./styles/mobile.css";

// Feature stylesheets live in src/styles/*.css. Their order against index.css is not guaranteed (the glob is bundled on its own),
// so a rule that must beat index.css wins by specificity, not by position.
import.meta.glob(["./styles/*.css", "!./styles/mobile.css"], { eager: true });


initSettings();
initBackend();
initRipple();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
