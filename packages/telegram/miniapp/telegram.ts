// Telegram's WebApp surface, narrowed to the parts this app uses, plus the harness
// escape hatch.
//
// Every call is optional-chained: Telegram ships a different WebApp version to every
// client and half of these methods did not exist a year ago. A mini-app that throws
// because a phone is on an old build is a mini-app that does not open.

export interface TelegramThemeParams {
  bg_color?: string;
  secondary_bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  destructive_text_color?: string;
}

export interface TelegramWebApp {
  initData?: string;
  initDataUnsafe?: { user?: { id?: number; first_name?: string; username?: string } };
  colorScheme?: "light" | "dark";
  themeParams?: TelegramThemeParams;
  viewportHeight?: number;
  ready?: () => void;
  expand?: () => void;
  disableVerticalSwipes?: () => void;
  enableVerticalSwipes?: () => void;
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  setHeaderColor?: (c: string) => void;
  setBackgroundColor?: (c: string) => void;
  onEvent?: (name: string, cb: () => void) => void;
  HapticFeedback?: {
    impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
    notificationOccurred?: (type: "error" | "success" | "warning") => void;
  };
  /** Set by the local harness so tests can tell the stub from the real thing. */
  __harness?: boolean;
}

export const tg = (): TelegramWebApp | null => (globalThis as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp ?? null;

/** True inside a real Telegram client — the harness stub sets `__harness`. */
export function isRealTelegram(): boolean {
  const w = tg();
  return !!w && w.__harness !== true && typeof w.initData === "string" && w.initData.length > 0;
}

/** True when a WebApp object exists at all, real or stubbed. */
export const hasWebApp = (): boolean => tg() !== null;

/**
 * Map Telegram's theme onto CSS variables.
 *
 * Telegram gives the host app its palette so a mini-app can look like part of the
 * client rather than a website someone embedded. The widget keeps its own tokens
 * inside its shadow root — that is the point of the shadow root — so these drive the
 * page around it, and `data-theme` tells the widget which way to lean.
 */
export function applyTelegramTheme(root: HTMLElement): void {
  const w = tg();
  const p = w?.themeParams ?? {};
  const set = (name: string, value: string | undefined) => {
    if (value) root.style.setProperty(name, value);
  };
  set("--tg-bg", p.bg_color);
  set("--tg-bg-2", p.secondary_bg_color);
  set("--tg-text", p.text_color);
  set("--tg-hint", p.hint_color);
  set("--tg-link", p.link_color);
  set("--tg-button", p.button_color);
  set("--tg-button-text", p.button_text_color);
  root.dataset.tgScheme = w?.colorScheme ?? "light";

  try {
    if (p.secondary_bg_color) w?.setHeaderColor?.(p.secondary_bg_color);
    if (p.bg_color) w?.setBackgroundColor?.(p.bg_color);
  } catch {
    /* not supported on this client */
  }

  // Telegram can change theme while the app is open.
  w?.onEvent?.("themeChanged", () => applyTelegramTheme(root));
}

/** Full height, and ready. */
export function expandAndLock(): void {
  const w = tg();
  try {
    w?.ready?.();
    w?.expand?.();
  } catch {
    /* ignore */
  }
}

export function haptic(kind: "impact" | "success" | "error"): void {
  const h = tg()?.HapticFeedback;
  try {
    if (kind === "impact") h?.impactOccurred?.("medium");
    else h?.notificationOccurred?.(kind === "success" ? "success" : "error");
  } catch {
    /* no haptics on this device */
  }
}
