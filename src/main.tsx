import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppWithSettlementHistory } from "./app/AppWithSettlementHistory";
import { CreatorContact } from "./app/CreatorContact";
import "./app/LanguagePreferences.css";
import { PwaVersionStatus } from "./app/PwaVersionStatus";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppWithSettlementHistory />
    <PwaVersionStatus />
    <CreatorContact />
  </StrictMode>,
);
