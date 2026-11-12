import "@fontsource-variable/geist";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { trackAppStarted } from "./lib/usage";
import { applyTheme, savedColorTheme } from "./lib/themes";
import "./styles.css";

// Set before the first paint so a light theme does not flash dark on start.
const mode = localStorage.getItem("lookout.theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = mode;
applyTheme(savedColorTheme(), mode);

// The bundled Geist font is loaded before anything renders, so the interface
// does not change font once it shows.
const fonts = document.fonts.load('13px "Geist Variable"');
void Promise.race([fonts, new Promise((resolve) => setTimeout(resolve, 800))]).finally(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
trackAppStarted();
