ALTER TABLE "markets" ADD COLUMN "had_bid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "had_ask" boolean DEFAULT false NOT NULL;