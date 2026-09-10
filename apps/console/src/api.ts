// Every call the console makes, in one typed place.
//
// Two kinds of route: public ones anybody can read, and partner-scoped ones behind
// an `x-api-key`. The key lives in sessionStorage and never in localStorage — it is
// a bearer credential, and a tab close should end the session that holds it.
//
// A 401 is not an error to retry: it means the key is wrong or gone, and the caller
// should send the reader back to the key prompt. `Unauthorized` exists so the
// dashboard can tell that case apart from a network blip.

import { API_URL } from "./config";

export class Unauthorized extends Error {
  constructor() {
    super("unauthorized");
    this.name = "Unauthorized";
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(body.message ?? body.error ?? `${path} → ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

const withKey = (key: string): RequestInit => ({ headers: { "x-api-key": key } });

// ── shapes ────────────────────────────────────────────────────────────────

export interface Overview {
  venueId: string;
  markets24h: number;
  fills24h: number;
  notional24h: number;
  uniqueTakers24h: number;
  zeroFillPct24h: number | null;
  quotedButUntakenPct24h: number | null;
  liveMarkets: number;
  cursorBlock: number | null;
  headBlock: number;
  lagBlocks: number | null;
  /** Hours of the claimed 24 h that are actually indexed. */
  historyCoveredHours: number;
  historyComplete: boolean;
  computedAt: string;
}

export interface BuilderRow {
  builder: string;
  fills: number;
  notional: number;
  wallets: number;
  firstSeen: number;
  lastSeen: number;
  partnerName: string | null;
  partnerId: number | null;
  verified: boolean;
}

export interface HourlyRow {
  hourTs: number;
  fills: number;
  notional: number;
  uniqueTakers: number;
  quotedButUntakenWindows: number;
}

export interface VenueSeriesRow {
  asset: string;
  intervalSec: number;
  windows: number;
  zeroFillWindows: number;
  quotedButUntakenWindows: number;
  fills: number;
  notional: number;
  uniqueTakers: number;
  zeroFillPct: number | null;
  quotedButUntakenPct: number | null;
}

export interface PartnerStats {
  partnerId: number;
  name: string;
  builderAddress: string;
  verified: boolean;
  fills: number;
  notional: number;
  uniqueWallets: number;
  marketsTouched: number;
  projectedBuilderFee: number;
  projectedBuilderFeeBps: number;
  projectionNote: string;
  hourly: { hourTs: number; fills: number; notional: number; uniqueWallets: number }[];
  computedAt: string | null;
}

export interface Breakdown {
  partnerId: number;
  hours: number;
  since: number;
  bySurface: { surfaceId: number; name: string; fills: number; notional: number }[];
  bySeries: { asset: string; intervalSec: number; fills: number; notional: number }[];
  byDay: { day: string; fills: number; notional: number; uniqueWallets: number }[];
  byHour: { hourTs: number; fills: number; notional: number; uniqueWallets: number }[];
}

export interface Share {
  partnerId: number;
  venueId: string;
  hours: number;
  partnerNotional: number;
  venueNotional: number;
  sharePct: number | null;
  partnerFills: number;
  venueFills: number;
}

export interface Fill {
  id: number;
  marketId: string | null;
  txHash: string;
  block: number;
  blockTs: number;
  price: number;
  quantity: number;
  notional: number;
  takerOwner: string | null;
  takerSide: string | null;
  takerPartnerId: number | null;
  takerSurfaceId: number | null;
  takerBuilder: string | null;
  asset?: string | null;
  intervalSec?: number | null;
}

export interface Market {
  marketId: string;
  asset: string;
  intervalSec: number;
  expiry: number;
  secondsToExpiry: number;
  status: number;
  statusName: string;
  winner: "UP" | "DOWN" | null;
  voided: boolean;
  closingPriceRaw: string | null;
  openingPriceRaw: string | null;
  book?: {
    bestBid: number | null;
    bestAsk: number | null;
    spread: number | null;
    yesBids: { quantity: number }[];
    yesAsks: { quantity: number }[];
  } | null;
}

export interface RegisterResult {
  partnerId: number;
  name: string;
  builderAddress: string;
  homepage: string | null;
  verified: boolean;
  verificationError: string | null;
  apiKey: string;
  snippet: string;
  userDataHint: { partnerId: number; example: string; note: string };
}

export interface Health {
  ok: boolean;
  network: string;
  cursorBlock: number | null;
  headBlock: number;
  lagBlocks: number | null;
  lagSeconds: number | null;
  dbOk: boolean;
}

// ── calls ─────────────────────────────────────────────────────────────────

export const api = {
  health: () => request<Health>("/health"),
  overview: () => request<Overview>("/v1/stats/overview"),
  builders: (hours: number) => request<{ hours: number; venueId: string; builders: BuilderRow[] }>(`/v1/stats/builders?hours=${hours}`),
  hourly: (venueId: string, hours: number) => request<{ rows: HourlyRow[] }>(`/v1/stats/venue/${venueId}/hourly?hours=${hours}`),
  venueWindow: (venueId: string, hours: number) =>
    request<{ rows: VenueSeriesRow[]; total: Omit<VenueSeriesRow, "asset" | "intervalSec"> }>(`/v1/stats/venue/${venueId}/window?hours=${hours}`),
  liveMarkets: (limit = 12) => request<Market[]>(`/v1/markets/live?book=true&limit=${limit}`),
  recentMarkets: (limit = 8) => request<Market[]>(`/v1/markets/recent?limit=${limit}`),

  register: (body: { name: string; builderAddress: string; homepage?: string; signature?: string; nonce?: string; issued?: string }) =>
    request<RegisterResult>("/v1/partners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),

  verificationMessage: (id: number) => request<{ message: string; nonce: string; issued: string; builderAddress: string }>(`/v1/partners/${id}/verification-message`),
  verify: (id: number, key: string, body: { signature: string; nonce: string; issued: string }) =>
    request<{ partnerId: number; verified: boolean; verifiedAt: string | null }>(`/v1/partners/${id}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify(body),
    }),

  partnerStats: (id: number, key: string, hours: number) => request<PartnerStats>(`/v1/partners/${id}/stats?hours=${hours}`, withKey(key)),
  breakdown: (id: number, key: string, hours: number) => request<Breakdown>(`/v1/partners/${id}/breakdown?hours=${hours}`, withKey(key)),
  share: (id: number, key: string, hours: number) => request<Share>(`/v1/partners/${id}/share?hours=${hours}`, withKey(key)),
  partnerFills: (id: number, key: string, limit = 50) => request<Fill[]>(`/v1/partners/${id}/fills?limit=${limit}`, withKey(key)),
};

export const wsUrl = (): string => `${API_URL.replace(/^http/, "ws")}/v1/stream`;
