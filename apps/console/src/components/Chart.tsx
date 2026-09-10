// Charts, on uPlot.
//
// uPlot rather than a charting framework: it is ~15 KB, draws to canvas, and has no
// opinions about how a dashboard should look — which is the point, because the look
// comes from @relay/ui-tokens like everything else here. The two shapes the console
// needs are a bar series over time and a stacked bar by category; both are below,
// and neither pulls in a layout engine.
//
// Colours are read from the live CSS variables at draw time, so a theme toggle
// repaints the chart in the new palette instead of leaving it in the old one.

import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

function cssVar(name: string, fallback: string): string {
  if (typeof getComputedStyle !== "function") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Re-render on theme change so canvas colours follow the tokens. */
function useThemeKey(): string {
  const [key, setKey] = useState("light");
  useEffect(() => {
    const read = () => setKey(document.documentElement.getAttribute("data-theme") ?? (matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener("change", read);
    return () => {
      obs.disconnect();
      mq?.removeEventListener("change", read);
    };
  }, []);
  return key;
}

/** Fill the width of whatever contains it, and redraw when that width changes. */
function useWidth(ref: React.RefObject<HTMLDivElement>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}


/**
 * Hour-of-day labels in the VIEWER's timezone, with each midnight labelled by its
 * date so a multi-day range still reads as a calendar.
 *
 * uPlot's `time: true` picks a granularity from the data extent, which is right for
 * arbitrary series and wrong here: these are always hourly buckets, and when the
 * caller passed a single point (the old sparse byHour) uPlot inferred a multi-year
 * span and labelled the axis Dec 2026 … Jun 2029. The buckets are fixed now, and so
 * is the label format. Values are unix SECONDS, as uPlot expects with time: true.
 */
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function hourLabel(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  if (d.getHours() === 0) return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  return `${String(d.getHours()).padStart(2, "0")}:00`;
}

export interface BarSeries {
  label: string;
  values: number[];
  /** A CSS variable name, resolved at draw time. */
  colorVar: string;
  fallback: string;
}

/**
 * Bars over time — one series, or several stacked.
 *
 * uPlot has no bar-stacking of its own, so the series are cumulated here and drawn
 * back-to-front. Stacking in the data (rather than faking it with offsets) keeps the
 * tooltip and the y-axis honest.
 */
export function TimeBars(props: {
  xs: number[];
  series: BarSeries[];
  height?: number;
  yLabel?: string;
  /** Format for the value axis and the legend. */
  fmt?: (n: number) => string;
  stacked?: boolean;
  ariaLabel: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const width = useWidth(box);
  const themeKey = useThemeKey();
  const height = props.height ?? 190;
  const fmt = props.fmt ?? ((n: number) => String(Math.round(n)));

  useEffect(() => {
    const el = box.current;
    if (!el || width < 10) return;

    const ink3 = cssVar("--ink-3", "#767f88");
    const line = cssVar("--line", "#e3e6ea");

    // Cumulate for a stack; otherwise each series is drawn on its own baseline.
    const stacks: number[][] = [];
    for (const [i, s] of props.series.entries()) {
      const prev = props.stacked && i > 0 ? stacks[i - 1]! : null;
      stacks.push(s.values.map((v, j) => (prev ? prev[j]! + v : v)));
    }
    // Back to front, so the last series does not paint over the ones beneath it.
    const order = props.stacked ? [...props.series.keys()].reverse() : [...props.series.keys()];

    const data: uPlot.AlignedData = [props.xs, ...order.map((i) => stacks[i]!)];
    const barWidth = Math.max(1, Math.min(26, (width / Math.max(1, props.xs.length)) * 0.62));

    const opts: uPlot.Options = {
      width,
      height,
      padding: [10, 8, 0, 0],
      legend: { show: props.series.length > 1, live: true },
      cursor: { y: false, points: { show: false } },
      scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, Math.max(max, 1) * 1.08] } },
      axes: [
        {
          stroke: ink3,
          grid: { show: false },
          ticks: { show: false },
          font: "11px var(--relay-font-ui)",
          size: 28,
          values: (_u, splits) => splits.map((v) => hourLabel(v)),
        },
        { stroke: ink3, grid: { stroke: line, width: 1 }, ticks: { show: false }, font: "11px var(--relay-font-ui)", size: 52, values: (_u, vals) => vals.map((v) => fmt(v)) },
      ],
      series: [
        { label: "time" },
        ...order.map((i) => {
          const s = props.series[i]!;
          const c = cssVar(s.colorVar, s.fallback);
          return {
            label: s.label,
            stroke: c,
            fill: c,
            width: 0,
            paths: uPlot.paths.bars!({ size: [0.62, barWidth], align: 0 }),
            points: { show: false },
            value: (_u: uPlot, v: number | null) => (v === null ? "—" : fmt(v)),
          } satisfies uPlot.Series;
        }),
      ],
    };

    plot.current?.destroy();
    plot.current = new uPlot(opts, data, el);
    return () => {
      plot.current?.destroy();
      plot.current = null;
    };
  }, [width, height, themeKey, props.xs, props.series, props.stacked, fmt]);

  return (
    <>
      <div ref={box} className="chartbox" style={{ height }} role="img" aria-label={props.ariaLabel} />
      {props.series.length > 1 ? (
        <div className="legend" style={{ marginTop: 6 }}>
          {props.series.map((s) => (
            <span key={s.label}>
              <span className="sw" style={{ background: `var(${s.colorVar}, ${s.fallback})` }} />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * A horizontal bar per category — for "fills by surface" and "fills by series",
 * where there are a handful of rows and the label matters more than the axis.
 * Plain DOM: a canvas chart for six rows would be harder to read, not easier.
 */
export function CategoryBars(props: { rows: { label: string; value: number; sub?: string }[]; fmt: (n: number) => string; ariaLabel: string }) {
  const max = Math.max(1, ...props.rows.map((r) => r.value));
  if (props.rows.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 8 }} role="img" aria-label={props.ariaLabel}>
      {props.rows.map((r) => (
        <div key={r.label} style={{ display: "grid", gridTemplateColumns: "minmax(70px, 26%) 1fr auto", gap: 10, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.sub ?? r.label}>
            {r.label}
          </span>
          <span style={{ height: 8, background: "var(--bg-sunken)", borderRadius: 4, overflow: "hidden" }}>
            <span style={{ display: "block", height: "100%", width: `${(r.value / max) * 100}%`, background: "var(--up)", borderRadius: 4 }} />
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, minWidth: 64, textAlign: "right" }}>{props.fmt(r.value)}</span>
        </div>
      ))}
    </div>
  );
}
