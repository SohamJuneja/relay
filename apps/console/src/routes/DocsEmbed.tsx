// The widget's README, rendered.
//
// Imported as raw text from packages/embed at build time, so the page cannot drift
// from the file a developer reads in the repo — there is one copy of this document,
// not two. The renderer below handles the subset of Markdown the README actually
// uses; anything fancier belongs in the README as plain prose, not in a parser here.

import { useMemo } from "react";
import type { ReactNode } from "react";
import readme from "@relay/embed/README.md?raw";
import { API_URL, CDN_URL, embedSnippet } from "../config";

/** Inline code, bold and links — the only inline forms the README uses. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) out.push(<code className="inline" key={`${keyBase}-${i++}`}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) out.push(<b key={`${keyBase}-${i++}`}>{tok.slice(2, -2)}</b>);
    else {
      const label = tok.slice(1, tok.indexOf("]"));
      const href = tok.slice(tok.indexOf("(") + 1, -1);
      out.push(
        <a key={`${keyBase}-${i++}`} href={href} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function render(md: string): ReactNode[] {
  const lines = md.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      out.push(
        <pre className="snippet" key={key++}>
          {body.join("\n")}
        </pre>,
      );
      continue;
    }

    // A table: header row, separator, then body until a blank line.
    if (line.startsWith("|") && lines[i + 1]?.startsWith("|") && /^\|[\s:|-]+\|$/.test(lines[i + 1]!)) {
      const cells = (r: string) =>
        r
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) body.push(cells(lines[i++]!));
      out.push(
        <div className="tablewrap" key={key++} style={{ margin: "12px 0" }}>
          <table>
            <thead>
              <tr>
                {head.map((h, hi) => (
                  <th key={hi} scope="col">
                    {inline(h, `h${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={{ whiteSpace: "normal" }}>
                      {inline(c, `c${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (line.startsWith("### ")) {
      out.push(
        <h3 key={key++} style={{ marginTop: 20 }}>
          {inline(line.slice(4), `h3-${key}`)}
        </h3>,
      );
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      out.push(
        <h2 key={key++} style={{ marginTop: 28 }}>
          {inline(line.slice(3), `h2-${key}`)}
        </h2>,
      );
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      out.push(<h1 key={key++}>{inline(line.slice(2), `h1-${key}`)}</h1>);
      i++;
      continue;
    }

    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i]!)) items.push(lines[i++]!.slice(2));
      out.push(
        <ul key={key++} style={{ margin: "8px 0", paddingLeft: 20, color: "var(--ink-2)", fontSize: 13.5 }}>
          {items.map((it, ii) => (
            <li key={ii} style={{ marginBottom: 4 }}>
              {inline(it, `li${ii}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // A paragraph runs until a blank line.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("#") && !lines[i]!.startsWith("|") && !lines[i]!.startsWith("```") && !/^[-*] /.test(lines[i]!)) {
      para.push(lines[i++]!);
    }
    out.push(
      <p key={key++} style={{ margin: "10px 0", color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.6, maxWidth: "76ch" }}>
        {inline(para.join(" "), `p${key}`)}
      </p>,
    );
  }
  return out;
}

export function DocsEmbed() {
  const content = useMemo(() => render(readme), []);
  return (
    <main>
      <div className="stack">
        <div className="card">
          <header>
            <h2>The snippet for this deployment</h2>
          </header>
          <pre className="snippet" data-testid="docs-snippet">
            {embedSnippet("YOUR_PARTNER_ID", "0xYourBuilderAddress")}
          </pre>
          <p className="hint" style={{ marginTop: 8 }}>
            The bundle is served from <code className="inline">{CDN_URL}</code>.
          </p>
        </div>

        <div className="row-between">
          <p className="muted" style={{ fontSize: 12.5 }}>
            Rendered from <code className="inline">packages/embed/README.md</code>
          </p>
          <a href={`${API_URL}/docs`} target="_blank" rel="noreferrer noopener">
            API reference (Swagger)
          </a>
        </div>
        <article>{content}</article>
      </div>
    </main>
  );
}
