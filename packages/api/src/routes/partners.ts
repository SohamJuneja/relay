import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { fills, markets, partners, statsPartner, statsPartnerHourly } from "@relay/indexer";
import type { App } from "../app.js";
import type { ApiDeps } from "../deps.js";
import { fillToApi, rowsOf } from "../format.js";
import { AddressZ, NamedFill, PartnerStats } from "../schemas.js";
import { embedSnippet } from "../snippet.js";
import { PROOF_WINDOW_MINUTES, proofMessage, verifyProof } from "../proof.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function registerPartners(app: App, deps: ApiDeps): void {
  const requireKey = async (partnerId: number, key: string | undefined): Promise<typeof partners.$inferSelect | null> => {
    if (!key) return null;
    const p = (await deps.db.select().from(partners).where(eq(partners.partnerId, partnerId)).limit(1))[0];
    if (!p) return null;
    return p.apiKeyHash === sha256(key) ? p : null;
  };

  app.post(
    "/v1/partners",
    {
      schema: {
        tags: ["partners"],
        summary: "Register a partner. The apiKey is returned ONCE and stored hashed.",
        description:
          "Open registration: anyone may claim any builder address. Send `signature` (and the `nonce` it covers) to PROVE " +
          "control of that address and be marked verified — the message is\n\n" +
          "    Relay partner registration\n    builder: <checksummed address>\n    nonce: <nonce>\n    issued: <ISO minute>\n\n" +
          `signed as a personal message. \`issued\` may be omitted, in which case every minute in the last ${PROOF_WINDOW_MINUTES} is tried. ` +
          "Registering without a signature still works; the partner is simply unverified and can verify later at /v1/partners/:id/verify.",
        body: z.object({
          name: z.string().min(1).max(80),
          builderAddress: AddressZ,
          homepage: z.string().url().max(300).optional(),
          signature: z.string().max(300).optional(),
          nonce: z.string().min(1).max(128).optional(),
          issued: z.string().max(40).optional(),
        }),
        response: {
          201: z.object({
            partnerId: z.number(),
            name: z.string(),
            builderAddress: AddressZ,
            homepage: z.string().nullable(),
            verified: z.boolean(),
            verificationError: z.string().nullable(),
            apiKey: z.string(),
            /** Ready to paste: the script tag and the mount point, already filled in. */
            snippet: z.string(),
            userDataHint: z.object({ partnerId: z.number(), example: z.string(), note: z.string() }),
          }),
        },
      },
    },
    async (req, reply) => {
      const apiKey = `rk_${randomBytes(24).toString("hex")}`;
      // Stored lowercase so every join against `fills.taker_builder` matches, but
      // handed BACK in EIP-55 checksum form: the partner pasted a checksummed
      // address and a lowercased echo reads as though we mangled it — and the
      // checksum is the one protection against a mistyped character.
      const { getAddress } = await import("viem");
      const checksummed = getAddress(req.body.builderAddress);

      // A bad signature does not fail the registration — the partner still gets an id
      // and a working snippet, just without the badge. Refusing the whole request
      // would punish a wallet quirk by throwing away the account.
      let verified = false;
      let verificationError: string | null = null;
      if (req.body.signature) {
        if (!req.body.nonce) {
          verificationError = "a signature needs the nonce it covers";
        } else {
          const proof = await verifyProof({
            builderAddress: checksummed,
            nonce: req.body.nonce,
            signature: req.body.signature,
            ...(req.body.issued ? { issued: req.body.issued } : {}),
          });
          verified = proof.ok;
          verificationError = proof.ok ? null : proof.reason;
        }
      }
      const [row] = await deps.db
        .insert(partners)
        .values({
          name: req.body.name,
          builderAddress: req.body.builderAddress.toLowerCase(),
          apiKeyHash: sha256(apiKey),
          verified,
          ...(verified ? { verifiedAt: new Date() } : {}),
          ...(req.body.homepage ? { homepage: req.body.homepage } : {}),
        })
        .returning();
      const { encodeUserData, SURFACE } = await import("@relay/core");
      const example = encodeUserData({ partnerId: row!.partnerId, surfaceId: SURFACE.WEB }).toString();
      return reply.status(201).send({
        partnerId: row!.partnerId,
        name: row!.name,
        builderAddress: checksummed,
        homepage: row!.homepage ?? null,
        verified,
        verificationError,
        apiKey,
        // Handed back at registration because this is the one moment the partner has
        // both numbers in front of them; the console shows the same string.
        snippet: embedSnippet({
          partnerId: row!.partnerId,
          builderAddress: checksummed,
          ...(process.env.EMBED_SCRIPT_URL ? { scriptUrl: process.env.EMBED_SCRIPT_URL } : {}),
          ...(process.env.PUBLIC_API_URL ? { api: process.env.PUBLIC_API_URL } : {}),
        }),
        userDataHint: { partnerId: row!.partnerId, example, note: "userData = [8b version=1][32b partnerId][16b surfaceId][8b reserved]; example is surface WEB" },
      });
    },
  );

  app.get(
    "/v1/partners/:partnerId/public",
    {
      schema: {
        tags: ["partners"],
        summary: "Public partner card: name, fills, notional (no key)",
        params: z.object({ partnerId: z.coerce.number().int() }),
        response: { 200: z.object({ partnerId: z.number(), name: z.string(), homepage: z.string().nullable(), verified: z.boolean(), fills: z.number(), notional: z.number(), marketsTouched: z.number(), since: z.string() }), 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const p = (await deps.db.select().from(partners).where(eq(partners.partnerId, req.params.partnerId)).limit(1))[0];
      if (!p) return reply.status(404).send({ error: "partner_not_found" });
      const s = (await deps.db.select().from(statsPartner).where(eq(statsPartner.partnerId, p.partnerId)).limit(1))[0];
      return { partnerId: p.partnerId, name: p.name, homepage: p.homepage ?? null, verified: p.verified, fills: s?.fills ?? 0, notional: Number(s?.notional ?? 0) / 10 ** deps.cfg.decimals, marketsTouched: s?.marketsTouched ?? 0, since: p.createdAt.toISOString() };
    },
  );

  app.get(
    "/v1/partners/:partnerId/stats",
    {
      schema: {
        tags: ["partners"],
        summary: "Partner stats (x-api-key). Builder fee is a PROJECTION at BUILDER_FEE_BPS, taker side only.",
        description:
          "Scoped to the configured venue and the `hours` window, so these totals match /breakdown over the same window. " +
          "`live=true` recomputes from `fills` instead of reading the once-a-minute rollup.",
        security: [{ apiKey: [] }],
        params: z.object({ partnerId: z.coerce.number().int() }),
        querystring: z.object({ hours: z.coerce.number().int().min(1).max(24 * 14).default(48), live: z.enum(["true", "false"]).default("true") }),
        response: { 200: PartnerStats, 401: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const p = await requireKey(req.params.partnerId, req.headers["x-api-key"] as string | undefined);
      if (!p) return reply.status(401).send({ error: "unauthorized" });
      const one = 10 ** deps.cfg.decimals;
      const since = BigInt(Math.floor(Date.now() / 1000) - req.query.hours * 3600);
      let s = (await deps.db.select().from(statsPartner).where(eq(statsPartner.partnerId, p.partnerId)).limit(1))[0] ?? null;
      let computedAt = s?.computedAt?.toISOString() ?? null;
      if (req.query.live === "true") {
        // Live recompute so a fresh fill shows without waiting for the 60 s job — and
        // scoped to the SAME window and venue as /breakdown, because the dashboard puts
        // these numbers next to that endpoint's chart. Counting all time and all venues
        // here produced a KPI reading "1 fill" above a chart reading "no fills in this
        // window", which is a headline and a graph disagreeing about one fact.
        const venueId = deps.cfg.defaultVenueId.toLowerCase();
        const r = rowsOf(
          await deps.db.execute(sql`
            select count(*)::int as fills,
                   coalesce(sum(f.notional),0)::text as notional,
                   count(distinct f.taker_owner)::int as wallets,
                   count(distinct f.market_id)::int as markets
            from fills f join markets m on m.market_id = f.market_id
            where f.taker_partner_id = ${p.partnerId}
              and f.block_ts >= ${since.toString()}::bigint
              and m.venue_id = ${venueId}`),
        )[0];
        const notional = BigInt(String(r?.notional ?? "0"));
        s = {
          partnerId: p.partnerId,
          fills: Number(r?.fills ?? 0),
          notional: notional.toString(),
          uniqueWallets: Number(r?.wallets ?? 0),
          marketsTouched: Number(r?.markets ?? 0),
          projectedBuilderFee: ((notional * BigInt(deps.cfg.builderFeeBps)) / 10_000n).toString(),
          feeBps: deps.cfg.builderFeeBps,
          computedAt: new Date(),
        };
        computedAt = new Date().toISOString();
      }
      // The materialised hourly table refreshes once a minute, which is fine for a
      // sparkline but not for "did my first fill land". /breakdown carries a live
      // hourly series computed from the same rows as the KPIs above; this one stays
      // for API consumers that want the cheap, cached version.
      const hourly = await deps.db.select().from(statsPartnerHourly).where(sql`${statsPartnerHourly.partnerId} = ${p.partnerId} and ${statsPartnerHourly.hourTs} >= ${since.toString()}::bigint`).orderBy(statsPartnerHourly.hourTs);
      return {
        partnerId: p.partnerId,
        name: p.name,
        builderAddress: p.builderAddress,
        verified: p.verified,
        fills: s?.fills ?? 0,
        notional: Number(s?.notional ?? 0) / one,
        uniqueWallets: s?.uniqueWallets ?? 0,
        marketsTouched: s?.marketsTouched ?? 0,
        projectedBuilderFee: Number(s?.projectedBuilderFee ?? 0) / one,
        projectedBuilderFeeBps: s?.feeBps ?? deps.cfg.builderFeeBps,
        projectionNote: `projection: taker-side notional × ${s?.feeBps ?? deps.cfg.builderFeeBps} bps; testnet pools charge 0 (cap 0); whether mainnet charges maker side too is an open question`,
        hourly: hourly.map((h) => ({ hourTs: Number(h.hourTs), fills: h.fills, notional: Number(h.notional) / one, uniqueWallets: h.uniqueWallets })),
        computedAt,
      };
    },
  );

  app.post(
    "/v1/partners/:partnerId/verify",
    {
      schema: {
        tags: ["partners"],
        summary: "Prove control of the registered builder address after the fact (x-api-key)",
        description:
          "For partners who registered without a signature. Sign the same message registration accepts — " +
          "`Relay partner registration` / `builder:` / `nonce:` / `issued:` — with the builder address's key. " +
          "Verifying an already-verified partner is a no-op that returns success.",
        security: [{ apiKey: [] }],
        params: z.object({ partnerId: z.coerce.number().int() }),
        body: z.object({ signature: z.string().max(300), nonce: z.string().min(1).max(128), issued: z.string().max(40).optional() }),
        response: {
          200: z.object({ partnerId: z.number(), verified: z.boolean(), builderAddress: AddressZ, verifiedAt: z.string().nullable() }),
          400: z.object({ error: z.string(), message: z.string() }),
          401: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const p = await requireKey(req.params.partnerId, req.headers["x-api-key"] as string | undefined);
      if (!p) return reply.status(401).send({ error: "unauthorized" });
      if (p.verified) return { partnerId: p.partnerId, verified: true, builderAddress: p.builderAddress, verifiedAt: p.verifiedAt?.toISOString() ?? null };
      const proof = await verifyProof({
        builderAddress: p.builderAddress,
        nonce: req.body.nonce,
        signature: req.body.signature,
        ...(req.body.issued ? { issued: req.body.issued } : {}),
      });
      if (!proof.ok) return reply.status(400).send({ error: "verification_failed", message: proof.reason });
      const at = new Date();
      await deps.db.update(partners).set({ verified: true, verifiedAt: at }).where(eq(partners.partnerId, p.partnerId));
      return { partnerId: p.partnerId, verified: true, builderAddress: p.builderAddress, verifiedAt: at.toISOString() };
    },
  );

  app.get(
    "/v1/partners/:partnerId/verification-message",
    {
      schema: {
        tags: ["partners"],
        summary: "The exact string to sign, so a client never has to reconstruct it",
        description: "Returns the message and the `nonce`/`issued` it embeds. Post the signature back with the same two values.",
        params: z.object({ partnerId: z.coerce.number().int() }),
        response: { 200: z.object({ message: z.string(), nonce: z.string(), issued: z.string(), builderAddress: AddressZ }), 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const p = (await deps.db.select().from(partners).where(eq(partners.partnerId, req.params.partnerId)).limit(1))[0];
      if (!p) return reply.status(404).send({ error: "partner_not_found" });
      const { getAddress } = await import("viem");
      const builderAddress = getAddress(p.builderAddress);
      const nonce = randomBytes(12).toString("hex");
      const issued = `${new Date().toISOString().slice(0, 16)}Z`;
      return { message: proofMessage({ builderAddress, nonce, issued }), nonce, issued, builderAddress };
    },
  );

  app.get(
    "/v1/partners/:partnerId/fills",
    {
      schema: {
        tags: ["partners"],
        summary: "Fills attributed to the partner on the TAKER side (x-api-key), newest first",
        security: [{ apiKey: [] }],
        params: z.object({ partnerId: z.coerce.number().int() }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }),
        response: { 200: z.array(NamedFill), 401: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const p = await requireKey(req.params.partnerId, req.headers["x-api-key"] as string | undefined);
      if (!p) return reply.status(401).send({ error: "unauthorized" });
      const rows = await deps.db.select().from(fills).where(eq(fills.takerPartnerId, p.partnerId)).orderBy(desc(fills.block), desc(fills.logIndex)).limit(req.query.limit);
      // Name the market. A fill row that says "0x0000…81ad" makes the reader open a
      // block explorer to learn it was a BTC 15-minute window, which the API already
      // knows. One extra query for the whole page, not one per row.
      const ids = [...new Set(rows.map((f) => f.marketId).filter((m): m is string => m !== null))];
      const named = new Map<string, { asset: string; intervalSec: number }>();
      if (ids.length) {
        const ms = await deps.db.select({ marketId: markets.marketId, asset: markets.asset, intervalSec: markets.intervalSec }).from(markets).where(inArray(markets.marketId, ids));
        for (const m of ms) named.set(m.marketId, { asset: m.asset, intervalSec: m.intervalSec });
      }
      return rows.map((f) => {
        const m = f.marketId ? named.get(f.marketId) : undefined;
        return { ...fillToApi(f, deps.cfg.decimals), asset: m?.asset ?? null, intervalSec: m?.intervalSec ?? null };
      });
    },
  );
}
