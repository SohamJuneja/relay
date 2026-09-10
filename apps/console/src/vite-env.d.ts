/// <reference types="vite/client" />

// The widget README is imported as raw text so /docs/embed and the repo file can
// never disagree.
declare module "*.md?raw" {
  const content: string;
  export default content;
}

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_CDN_URL?: string;
  readonly VITE_CONSOLE_URL?: string;
  readonly VITE_EXPLORER_URL?: string;
  /** The partner the landing page's live widget mounts with. */
  readonly VITE_DEMO_PARTNER_ID?: string;
  /** That partner's builder address. The two must belong together — see config.ts. */
  readonly VITE_DEMO_BUILDER?: string;
  /** The demo publication that embeds the widget. */
  readonly VITE_DEMO_SITE_URL?: string;
  /** The Telegram bot, e.g. https://t.me/RelaySomniaBot */
  readonly VITE_TELEGRAM_URL?: string;
  /** The public source repository. */
  readonly VITE_REPO_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
