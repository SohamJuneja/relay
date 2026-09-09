// Relay attribution tag — the uint64 `userData` field on placeBinaryOrder.
//
// Why userData is the PRIMARY channel (docs/ATTRIBUTION.md has the full case):
//   - it is echoed verbatim in `OrderPlaced.placedOrder.userData`, so an indexer
//     decodes it from the log alone — no tx fetch, no fee event, no ABI guess;
//   - `builder` is NOT in OrderPlaced, `approveBuilder` is per pool (and pools are
//     recycled per window), and the testnet builder-fee cap is 0.
// `builder` stays the SECONDARY channel: it is what pays the partner on mainnet.
//
// Layout (big-endian, MSB first):
//   bits 63..56  version   (8)   0 = untagged / not Relay; 1 = this layout
//   bits 55..24  partnerId (32)  Relay partner id (1..2^32-1); 0 = reserved
//   bits 23..8   surfaceId (16)  where the order came from (web, telegram, …)
//   bits  7..0   reserved  (8)   must be 0 in v1 (future: A/B bucket, flags)
//
// Version 0 covers every pre-Relay order on the chain (the kit and the DreamDEX
// app send userData = 0) and any foreign tag whose top byte happens to be 0.

export const USERDATA_VERSION_UNTAGGED = 0;
export const USERDATA_VERSION_V1 = 1;

export const SURFACE = {
  UNKNOWN: 0,
  WEB: 1,
  TELEGRAM: 2,
  FARCASTER: 3,
  DISCORD: 4,
  MOBILE: 5,
  API: 6,
} as const;
export type SurfaceName = keyof typeof SURFACE;

const SURFACE_NAMES: Record<number, SurfaceName> = Object.fromEntries(
  Object.entries(SURFACE).map(([k, v]) => [v, k as SurfaceName]),
) as Record<number, SurfaceName>;

export const MAX_PARTNER_ID = 0xffff_ffff; // uint32
export const MAX_SURFACE_ID = 0xffff; // uint16
export const UINT64_MAX = (1n << 64n) - 1n;

const VERSION_SHIFT = 56n;
const PARTNER_SHIFT = 24n;
const SURFACE_SHIFT = 8n;

export interface RelayTag {
  version: number;
  partnerId: number;
  surfaceId: number;
  reserved: number;
}

export interface DecodedUserData extends RelayTag {
  /** True only for a well-formed Relay v1 tag (version 1, partnerId ≠ 0, reserved 0). */
  tagged: boolean;
  /** Human name for surfaceId when it is one we define. */
  surface: SurfaceName | null;
  /** The raw uint64 as given. */
  raw: bigint;
}

export interface EncodeUserDataInput {
  partnerId: number;
  surfaceId?: number;
  reserved?: number;
}

function assertUint(name: string, v: number, max: number): void {
  if (!Number.isInteger(v) || v < 0 || v > max) {
    throw new RangeError(`${name} must be an integer in [0, ${max}], got ${v}`);
  }
}

/** Build a v1 tag. partnerId must be non-zero (0 is reserved to mean "no partner"). */
export function encodeUserData(input: EncodeUserDataInput): bigint {
  const surfaceId = input.surfaceId ?? SURFACE.UNKNOWN;
  const reserved = input.reserved ?? 0;
  assertUint("partnerId", input.partnerId, MAX_PARTNER_ID);
  assertUint("surfaceId", surfaceId, MAX_SURFACE_ID);
  assertUint("reserved", reserved, 0xff);
  if (input.partnerId === 0) throw new RangeError("partnerId 0 is reserved (means untagged)");
  return (
    (BigInt(USERDATA_VERSION_V1) << VERSION_SHIFT) |
    (BigInt(input.partnerId) << PARTNER_SHIFT) |
    (BigInt(surfaceId) << SURFACE_SHIFT) |
    BigInt(reserved)
  );
}

/** Decode any uint64. Never throws on foreign data — `tagged` says whether it is ours. */
export function decodeUserData(userData: bigint | number | string): DecodedUserData {
  const raw = BigInt(userData);
  if (raw < 0n || raw > UINT64_MAX) throw new RangeError(`userData out of uint64 range: ${raw}`);
  const version = Number((raw >> VERSION_SHIFT) & 0xffn);
  const partnerId = Number((raw >> PARTNER_SHIFT) & 0xffff_ffffn);
  const surfaceId = Number((raw >> SURFACE_SHIFT) & 0xffffn);
  const reserved = Number(raw & 0xffn);
  const tagged = version === USERDATA_VERSION_V1 && partnerId !== 0 && reserved === 0;
  return { version, partnerId, surfaceId, reserved, tagged, surface: SURFACE_NAMES[surfaceId] ?? null, raw };
}

export const isRelayTagged = (userData: bigint | number | string): boolean => decodeUserData(userData).tagged;

/** "relay:v1 partner=42 surface=WEB" — for logs and the console. */
export function formatUserData(userData: bigint | number | string): string {
  const d = decodeUserData(userData);
  if (!d.tagged) return d.raw === 0n ? "untagged (0)" : `untagged (raw ${d.raw})`;
  return `relay:v${d.version} partner=${d.partnerId} surface=${d.surface ?? d.surfaceId}`;
}

/**
 * Mainnet fee projection the console uses. Builder fee is `bps × 1000` on the
 * pool (100000 = 1 %). Applied to fill notional (fillPrice × qty / one).
 * OPEN: whether the pool charges the builder fee on the taker side only or on
 * both sides (ProtocolFeeCharged carries `isTakerSide`; BuilderFeeCharged is
 * presumed to mirror it). `sides` lets the caller model either.
 */
export function projectBuilderFee(args: {
  notionalRaw: bigint;
  builderFeeBpsTimes1k: bigint;
  /** 1 = taker only (default assumption), 2 = both sides. */
  sides?: 1 | 2;
}): bigint {
  const sides = BigInt(args.sides ?? 1);
  // bps×1000 → fraction = x / (10_000 × 1000)
  return (args.notionalRaw * args.builderFeeBpsTimes1k * sides) / 10_000_000n;
}
