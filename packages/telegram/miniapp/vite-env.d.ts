/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RELAY_API?: string;
  readonly VITE_RELAY_PARTNER?: string;
  readonly VITE_RELAY_BUILDER?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
