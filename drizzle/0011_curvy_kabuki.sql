CREATE TABLE "ai_compaction" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_compaction_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"conversation_id" bigint NOT NULL,
	"up_to_message_id" bigint NOT NULL,
	"summary" text NOT NULL,
	"token_bound" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_image_exclusion" (
	"image_id" bigint PRIMARY KEY NOT NULL,
	"source_message_id" bigint,
	"create_time" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_workflow" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_workflow_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"key" text DEFAULT 'default' NOT NULL,
	"status" text DEFAULT 'IDLE' NOT NULL,
	"phase" text DEFAULT 'IDLE' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "ai_conversation" ADD COLUMN "draft" jsonb;--> statement-breakpoint
ALTER TABLE "ai_compaction" ADD CONSTRAINT "ai_compaction_conversation_id_ai_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_compaction" ADD CONSTRAINT "ai_compaction_up_to_message_id_ai_message_id_fk" FOREIGN KEY ("up_to_message_id") REFERENCES "public"."ai_message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_image_exclusion" ADD CONSTRAINT "ai_image_exclusion_image_id_image_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_image_exclusion" ADD CONSTRAINT "ai_image_exclusion_source_message_id_ai_message_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."ai_message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_compaction_conv_msg" ON "ai_compaction" USING btree ("conversation_id","up_to_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_ai_workflow_kind_key" ON "ai_workflow" USING btree ("kind","key") WHERE "ai_workflow"."delete_state" = 0;--> statement-breakpoint
UPDATE "ai_conversation" c
SET "draft" = sub."draft"
FROM (
  SELECT DISTINCT ON (m."conversation_id")
    m."conversation_id",
    jsonb_build_object('messageId', m."id", 'content', m."content") AS "draft"
  FROM "ai_message" m
  WHERE m."delete_state" = 2 AND m."role" = 'USER'
  ORDER BY m."conversation_id", m."id" DESC
) sub
WHERE c."id" = sub."conversation_id" AND c."draft" IS NULL;--> statement-breakpoint
UPDATE "ai_message" SET "delete_state" = 1 WHERE "delete_state" = 2;--> statement-breakpoint
INSERT INTO "ai_compaction" ("conversation_id", "up_to_message_id", "summary", "token_bound")
SELECT m."conversation_id", m."id", m."content"->>'compactSummary', 0
FROM "ai_message" m
WHERE m."delete_state" = 0
  AND m."role" = 'ASSISTANT'
  AND m."content" ? 'compactSummary'
  AND length(trim(coalesce(m."content"->>'compactSummary', ''))) > 0
  AND NOT EXISTS (
    SELECT 1 FROM "ai_compaction" ac
    WHERE ac."conversation_id" = m."conversation_id"
      AND ac."up_to_message_id" = m."id"
      AND ac."delete_state" = 0
  );--> statement-breakpoint
INSERT INTO "ai_image_exclusion" ("image_id", "source_message_id")
SELECT i."id", m."source_message_id"
FROM "ai_memory" m
JOIN "image" i ON i."id" = substring(m."content" FROM '^以后检索时排除图片 #([0-9]+)$')::bigint
WHERE m."kind" = 'preference'
  AND m."delete_state" = 0
  AND m."valid_to" IS NULL
  AND m."content" ~ '^以后检索时排除图片 #[0-9]+$'
ON CONFLICT ("image_id") DO NOTHING;--> statement-breakpoint
UPDATE "ai_memory"
SET "valid_to" = now()
WHERE "kind" = 'preference'
  AND "delete_state" = 0
  AND "valid_to" IS NULL
  AND starts_with("content", '以后检索时排除图片 #');