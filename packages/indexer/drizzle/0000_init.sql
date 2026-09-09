CREATE TABLE "blocks" (
	"number" bigint PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"parent_hash" text NOT NULL,
	"timestamp" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builder_fee_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool" text NOT NULL,
	"market_id" text,
	"order_id" numeric(78, 0) NOT NULL,
	"builder" text NOT NULL,
	"token" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"block" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cursor" (
	"network" text PRIMARY KEY NOT NULL,
	"last_block" bigint NOT NULL,
	"last_block_hash" text,
	"start_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool" text NOT NULL,
	"market_id" text,
	"taker_order_id" numeric(78, 0) NOT NULL,
	"maker_order_id" numeric(78, 0) NOT NULL,
	"fill_price" numeric(78, 0) NOT NULL,
	"quantity" numeric(78, 0) NOT NULL,
	"notional" numeric(78, 0) NOT NULL,
	"block" bigint NOT NULL,
	"block_ts" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"taker_owner" text,
	"maker_owner" text,
	"taker_kind" smallint,
	"maker_kind" smallint,
	"taker_partner_id" integer,
	"taker_surface_id" integer,
	"maker_partner_id" integer,
	"taker_builder" text,
	"maker_builder" text
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"market_id" text PRIMARY KEY NOT NULL,
	"market_address" text NOT NULL,
	"pool" text NOT NULL,
	"venue_id" text NOT NULL,
	"operator_id" integer NOT NULL,
	"creator" text NOT NULL,
	"collateral" text NOT NULL,
	"yes_id" numeric(78, 0) NOT NULL,
	"no_id" numeric(78, 0) NOT NULL,
	"nonce" bigint NOT NULL,
	"asset" text NOT NULL,
	"interval_sec" integer NOT NULL,
	"window_sec" integer NOT NULL,
	"trading_start" bigint NOT NULL,
	"expiry" bigint NOT NULL,
	"strike_raw" numeric(78, 0) NOT NULL,
	"question" text NOT NULL,
	"void_policy" smallint NOT NULL,
	"oracle_question_id" numeric(78, 0) NOT NULL,
	"reference_question_id" numeric(78, 0),
	"status" smallint DEFAULT 1 NOT NULL,
	"resolved_at" bigint,
	"resolved_block" bigint,
	"payout_numerators" jsonb,
	"payout_denominator" numeric(78, 0),
	"winner" smallint,
	"voided" boolean DEFAULT false NOT NULL,
	"finalized" boolean DEFAULT false NOT NULL,
	"opening_price_raw" numeric(78, 0),
	"closing_price_raw" numeric(78, 0),
	"created_block" bigint NOT NULL,
	"created_block_hash" text NOT NULL,
	"created_tx" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"pool" text NOT NULL,
	"order_id" numeric(78, 0) NOT NULL,
	"market_id" text,
	"owner" text NOT NULL,
	"is_bid" boolean NOT NULL,
	"kind" smallint,
	"price" numeric(78, 0) NOT NULL,
	"quantity" numeric(78, 0) NOT NULL,
	"order_type" smallint,
	"user_data" numeric(78, 0) NOT NULL,
	"tag_version" smallint NOT NULL,
	"partner_id" integer,
	"surface_id" integer,
	"builder" text,
	"expire_ns" numeric(78, 0) NOT NULL,
	"placed_block" bigint NOT NULL,
	"placed_ts" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"rested_qty" numeric(78, 0),
	"filled_qty" numeric(78, 0) DEFAULT '0' NOT NULL,
	"cancelled" boolean DEFAULT false NOT NULL,
	"expired" boolean DEFAULT false NOT NULL,
	CONSTRAINT "orders_pool_order_id_pk" PRIMARY KEY("pool","order_id")
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"partner_id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"builder_address" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_epochs" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool" text NOT NULL,
	"market_id" text NOT NULL,
	"nonce" bigint NOT NULL,
	"from_block" bigint NOT NULL,
	"to_block" bigint
);
--> statement-breakpoint
CREATE TABLE "price_candles" (
	"asset" text NOT NULL,
	"minute_ts" bigint NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"samples" integer NOT NULL,
	CONSTRAINT "price_candles_asset_minute_ts_pk" PRIMARY KEY("asset","minute_ts")
);
--> statement-breakpoint
CREATE TABLE "protocol_fee_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool" text NOT NULL,
	"market_id" text,
	"order_id" numeric(78, 0) NOT NULL,
	"payer" text NOT NULL,
	"token" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"is_taker_side" boolean NOT NULL,
	"block" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"topic0" text NOT NULL,
	"name" text,
	"market_id" text,
	"topics" jsonb NOT NULL,
	"data" text NOT NULL,
	"args" jsonb,
	"block" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"market_key" numeric(78, 0) NOT NULL,
	"pool" text,
	"nonce" bigint,
	"market_id" text,
	"holder" text NOT NULL,
	"to" text NOT NULL,
	"outcome_idx" smallint NOT NULL,
	"amount_burned" numeric(78, 0) NOT NULL,
	"collateral_out" numeric(78, 0) NOT NULL,
	"block" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stats_partner" (
	"partner_id" integer PRIMARY KEY NOT NULL,
	"fills" integer NOT NULL,
	"notional" numeric(78, 0) NOT NULL,
	"unique_wallets" integer NOT NULL,
	"markets_touched" integer NOT NULL,
	"projected_builder_fee" numeric(78, 0) NOT NULL,
	"fee_bps" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stats_partner_hourly" (
	"partner_id" integer NOT NULL,
	"hour_ts" bigint NOT NULL,
	"fills" integer NOT NULL,
	"notional" numeric(78, 0) NOT NULL,
	"unique_wallets" integer NOT NULL,
	CONSTRAINT "stats_partner_hourly_partner_id_hour_ts_pk" PRIMARY KEY("partner_id","hour_ts")
);
--> statement-breakpoint
CREATE TABLE "stats_venue_daily" (
	"venue_id" text NOT NULL,
	"asset" text NOT NULL,
	"interval_sec" integer NOT NULL,
	"day" date NOT NULL,
	"windows" integer NOT NULL,
	"zero_fill_windows" integer NOT NULL,
	"quoted_but_untaken_windows" integer NOT NULL,
	"fills" integer NOT NULL,
	"notional" numeric(78, 0) NOT NULL,
	"unique_takers" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stats_venue_daily_venue_id_asset_interval_sec_day_pk" PRIMARY KEY("venue_id","asset","interval_sec","day")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bfe_tx_log_uq" ON "builder_fee_events" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "bfe_builder_block_idx" ON "builder_fee_events" USING btree ("builder","block");--> statement-breakpoint
CREATE UNIQUE INDEX "fills_tx_log_uq" ON "fills" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "fills_market_idx" ON "fills" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "fills_taker_partner_block_idx" ON "fills" USING btree ("taker_partner_id","block");--> statement-breakpoint
CREATE INDEX "fills_block_idx" ON "fills" USING btree ("block");--> statement-breakpoint
CREATE INDEX "fills_block_ts_idx" ON "fills" USING btree ("block_ts");--> statement-breakpoint
CREATE INDEX "fills_taker_owner_idx" ON "fills" USING btree ("taker_owner");--> statement-breakpoint
CREATE INDEX "markets_venue_expiry_idx" ON "markets" USING btree ("venue_id","expiry");--> statement-breakpoint
CREATE INDEX "markets_expiry_idx" ON "markets" USING btree ("expiry");--> statement-breakpoint
CREATE INDEX "markets_pool_idx" ON "markets" USING btree ("pool");--> statement-breakpoint
CREATE INDEX "markets_status_idx" ON "markets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_market_idx" ON "orders" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "orders_owner_idx" ON "orders" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "orders_partner_block_idx" ON "orders" USING btree ("partner_id","placed_block");--> statement-breakpoint
CREATE INDEX "orders_block_idx" ON "orders" USING btree ("placed_block");--> statement-breakpoint
CREATE INDEX "pool_epochs_pool_from_idx" ON "pool_epochs" USING btree ("pool","from_block");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_epochs_market_uq" ON "pool_epochs" USING btree ("market_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pfe_tx_log_uq" ON "protocol_fee_events" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "pfe_block_idx" ON "protocol_fee_events" USING btree ("block");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_events_tx_log_uq" ON "raw_events" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "raw_events_topic_block_idx" ON "raw_events" USING btree ("topic0","block");--> statement-breakpoint
CREATE UNIQUE INDEX "redemptions_tx_log_uq" ON "redemptions" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "redemptions_holder_idx" ON "redemptions" USING btree ("holder");--> statement-breakpoint
CREATE INDEX "redemptions_market_idx" ON "redemptions" USING btree ("market_id");