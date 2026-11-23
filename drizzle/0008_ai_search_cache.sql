CREATE TABLE "ai_search_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ix_ai_search_cache_expiry" ON "ai_search_cache" USING btree ("expires_at");