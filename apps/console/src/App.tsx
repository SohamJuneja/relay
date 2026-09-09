import { NavLink, Route, Routes } from "react-router-dom";
import { ThemeToggle, useTheme } from "./components/ui";
import { version as widgetVersion } from "@relay/embed";
import { API_URL, CDN_URL } from "./config";
import { Landing } from "./routes/Landing";
import { Register } from "./routes/Register";
import { Dashboard } from "./routes/Dashboard";
import { Ecosystem } from "./routes/Ecosystem";
import { DocsEmbed } from "./routes/DocsEmbed";

export function App() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="wordmark">
          Relay
          <span>DreamDEX Event Contracts</span>
        </NavLink>
        <nav className="nav" aria-label="Main">
          <NavLink to="/">Overview</NavLink>
          <NavLink to="/ecosystem">Ecosystem</NavLink>
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/docs/embed">Docs</NavLink>
        </nav>
        <span className="grow" />
        <ThemeToggle theme={theme} onChange={setTheme} />
      </header>

      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/register" element={<Register />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/ecosystem" element={<Ecosystem />} />
        <Route path="/docs/embed" element={<DocsEmbed />} />
        <Route
          path="*"
          element={
            <main>
              <h1>Not found</h1>
              <p className="lede" style={{ marginTop: 12 }}>
                That page does not exist. <NavLink to="/">Back to the overview.</NavLink>
              </p>
            </main>
          }
        />
      </Routes>

      <footer className="site">
        <span>Relay · testnet (Somnia Shannon, chain 50312)</span>
        <a href={`${API_URL}/docs`} target="_blank" rel="noreferrer noopener">
          API reference
        </a>
        <a href={`${API_URL}/health`} target="_blank" rel="noreferrer noopener">
          Indexer health
        </a>
        <a href={`${CDN_URL}/relay.iife.js`} target="_blank" rel="noreferrer noopener">
          widget v{widgetVersion}
        </a>
        <span className="muted">Attribution is recorded on chain; every number here is derived from Somnia logs.</span>
      </footer>
    </div>
  );
}
