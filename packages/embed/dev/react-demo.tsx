import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RelayMarket } from "../src/react.js";

const el = document.getElementById("w-react");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <RelayMarket
        partner={1}
        builder="0xb5eCf004491aa8589a82af91633D18867fcFF038"
        asset="ETH"
        intervalSec={900}
        surface="web"
        api="http://localhost:8787"
        onTrade={(d) => console.log("[react] relay:trade", d)}
        onFill={(d) => console.log("[react] relay:fill", d)}
        onClaim={(d) => console.log("[react] relay:claim", d)}
      />
    </StrictMode>,
  );
}
