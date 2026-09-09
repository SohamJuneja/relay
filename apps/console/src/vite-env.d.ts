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
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
