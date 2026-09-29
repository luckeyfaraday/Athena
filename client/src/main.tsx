import React from "react";
import { createRoot } from "react-dom/client";
// Fonts ship with the app: no network fetch at launch, and they work offline.
// Each @font-face only downloads when a theme actually uses that family.
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/manrope/wght.css";
import "@fontsource-variable/schibsted-grotesk/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "@fontsource-variable/bricolage-grotesque/wght.css";
import "@fontsource-variable/space-grotesk/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
// Shared styles load before App so room and component stylesheets can build on them.
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
