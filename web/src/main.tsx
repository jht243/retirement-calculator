import React from "react";
import { createRoot } from "react-dom/client";

import MortgageHelloWorld from "./component";

const container = document.getElementById("mortgage-calculator-root");

if (!container) {
  throw new Error("mortgage-calculator-root element not found");
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <MortgageHelloWorld />
  </React.StrictMode>
);
