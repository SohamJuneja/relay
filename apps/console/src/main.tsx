import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { Unauthorized } from "./api";
import "./styles.css";
import { assertDemoPartnerMatchesBuilder } from "./config";

// A wrong API key is not a transient failure, so it must never be retried — three
// silent 401s would just delay the key prompt the reader needs to see.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => !(error instanceof Unauthorized) && failureCount < 2,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

// Config that can be wrong without looking wrong, checked once against the API.
void assertDemoPartnerMatchesBuilder();
