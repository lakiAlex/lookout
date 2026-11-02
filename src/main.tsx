import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Set before the first paint so a light theme does not flash dark on start.
document.documentElement.dataset.theme = localStorage.getItem("lookout.theme") === "light" ? "light" : "dark";

// Terminals measure their font once when they open, so the bundled Geist
// fonts are loaded before anything renders.
const fonts = Promise.all(['13px "Geist Mono Variable"', '13px "Geist Variable"'].map((font) => document.fonts.load(font)));
void Promise.race([fonts, new Promise((resolve) => setTimeout(resolve, 800))]).finally(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
