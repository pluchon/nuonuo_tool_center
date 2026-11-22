CREATE TYPE "public"."ai_job_kind" AS ENUM('LOOK', 'DREAM', 'EMBED');--> statement-breakpoint
CREATE TYPE "public"."ai_job_status" AS ENUM('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."ai_result_origin" AS ENUM('NONO', 'EXTERNAL');--> statement-breakpoint
CREATE TYPE "public"."ai_vote" AS ENUM('UP', 'DOWN');--> statement-breakpoint
CREATE TABLE "ai_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"image_id" bigint,
	"payload" jsonb NOT NULL,
	"is_r18" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_job" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_job_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"kind" "ai_job_kind" NOT NULL,
	"status" "ai_job_status" DEFAULT 'QUEUED' NOT NULL,
	"image_id" bigint,
	"priority" smallint DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"remote_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_profile" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_profile_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"tag_vocab" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_conversation" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_conversation" ADD COLUMN "profile_version" integer;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD COLUMN "source_event_id" bigint;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD COLUMN "confidence" real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD COLUMN "valid_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD COLUMN "valid_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_message" ADD COLUMN "vote" "ai_vote";--> statement-breakpoint
ALTER TABLE "api_usage" ADD COLUMN "input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_usage" ADD COLUMN "cached_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_usage" ADD COLUMN "cache_write_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_usage" ADD COLUMN "image_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_usage" ADD COLUMN "output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_usage" ADD COLUMN "search_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_usage" ADD COLUMN "batch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_usage" ADD COLUMN "latency_ms" integer;--> statement-breakpoint
ALTER TABLE "api_usage" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "image_ai_result" ADD COLUMN "origin" "ai_result_origin" DEFAULT 'NONO' NOT NULL;--> statement-breakpoint
ALTER TABLE "image_ai_result" ADD COLUMN "field_status" jsonb;--> statement-breakpoint
ALTER TABLE "ai_event" ADD CONSTRAINT "ai_event_image_id_image_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_job" ADD CONSTRAINT "ai_job_image_id_image_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_event_kind_time" ON "ai_event" USING btree ("kind","create_time");--> statement-breakpoint
CREATE INDEX "idx_ai_job_queue" ON "ai_job" USING btree ("kind","status","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_ai_profile_version" ON "ai_profile" USING btree ("version") WHERE "ai_profile"."delete_state" = 0;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD CONSTRAINT "ai_memory_source_event_id_ai_event_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."ai_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_memory_valid" ON "ai_memory" USING btree ("valid_to");