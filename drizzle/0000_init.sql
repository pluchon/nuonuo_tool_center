CREATE TYPE "public"."ai_message_role" AS ENUM('USER', 'ASSISTANT', 'TOOL');--> statement-breakpoint
CREATE TYPE "public"."ai_result_kind" AS ENUM('IDENTIFY', 'DESCRIBE', 'NAME');--> statement-breakpoint
CREATE TYPE "public"."file_op_batch_status" AS ENUM('PLANNED', 'APPLYING', 'APPLIED', 'UNDONE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."file_op_origin" AS ENUM('USER', 'AI');--> statement-breakpoint
CREATE TYPE "public"."file_op_status" AS ENUM('PENDING', 'DONE', 'FAILED', 'REVERTED');--> statement-breakpoint
CREATE TYPE "public"."file_op_type" AS ENUM('MOVE', 'RENAME', 'TRASH', 'RESTORE', 'PURGE');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('NORMAL', 'MISSING', 'TRASHED');--> statement-breakpoint
CREATE TYPE "public"."rating" AS ENUM('UNKNOWN', 'GENERAL', 'SENSITIVE', 'QUESTIONABLE', 'EXPLICIT');--> statement-breakpoint
CREATE TYPE "public"."rating_source" AS ENUM('MODEL', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."tag_category" AS ENUM('GENERAL', 'CHARACTER', 'SERIES', 'ARTIST', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."tag_source" AS ENUM('MANUAL', 'VLM');--> statement-breakpoint
CREATE TYPE "public"."tag_status" AS ENUM('ACCEPTED', 'SUGGESTED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "ai_conversation" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_conversation_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"title" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_memory" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_memory_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"kind" text NOT NULL,
	"embedding" vector(1024),
	"source_message_id" bigint
);
--> statement-breakpoint
CREATE TABLE "ai_message" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_message_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"conversation_id" bigint NOT NULL,
	"role" "ai_message_role" NOT NULL,
	"content" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_usage" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "api_usage_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"api" text NOT NULL,
	"model" text,
	"units" integer DEFAULT 1 NOT NULL,
	"est_cost" numeric(10, 4),
	"image_id" bigint
);
--> statement-breakpoint
CREATE TABLE "app_setting" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app_setting_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_op" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "file_op_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"batch_id" bigint NOT NULL,
	"seq" integer NOT NULL,
	"op_type" "file_op_type" NOT NULL,
	"image_file_id" bigint,
	"from_path" text NOT NULL,
	"to_path" text,
	"content_hash" text NOT NULL,
	"status" "file_op_status" DEFAULT 'PENDING' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "file_op_batch" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "file_op_batch_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"origin" "file_op_origin" NOT NULL,
	"summary" text NOT NULL,
	"status" "file_op_batch_status" DEFAULT 'PLANNED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "image_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"content_hash" text NOT NULL,
	"format" text NOT NULL,
	"width" integer,
	"height" integer,
	"byte_size" bigint NOT NULL,
	"display_name" text,
	"description" text,
	"rating" "rating" DEFAULT 'UNKNOWN' NOT NULL,
	"rating_source" "rating_source",
	"rating_scores" jsonb,
	"thumb_ready" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_ai_result" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "image_ai_result_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"image_id" bigint NOT NULL,
	"kind" "ai_result_kind" NOT NULL,
	"model" text NOT NULL,
	"result" jsonb NOT NULL,
	"usage" jsonb
);
--> statement-breakpoint
CREATE TABLE "image_embedding" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "image_embedding_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"image_id" bigint NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(1024) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_file" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "image_file_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"image_id" bigint NOT NULL,
	"root_id" bigint NOT NULL,
	"rel_path" text NOT NULL,
	"mtime" timestamp with time zone NOT NULL,
	"status" "file_status" DEFAULT 'NORMAL' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_tag" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "image_tag_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"image_id" bigint NOT NULL,
	"tag_id" bigint NOT NULL,
	"source" "tag_source" NOT NULL,
	"status" "tag_status" NOT NULL,
	"score" real
);
--> statement-breakpoint
CREATE TABLE "library_root" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "library_root_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"trash_dir" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tag_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"category" "tag_category" DEFAULT 'GENERAL' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_memory" ADD CONSTRAINT "ai_memory_source_message_id_ai_message_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."ai_message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_message" ADD CONSTRAINT "ai_message_conversation_id_ai_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_image_id_image_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_op" ADD CONSTRAINT "file_op_batch_id_file_op_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."file_op_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_op" ADD CONSTRAINT "file_op_image_file_id_image_file_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."image_file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_ai_result" ADD CONSTRAINT "image_ai_result_image_id_image_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_embedding" ADD CONSTRAINT "image_embedding_image_id_image_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_file" ADD CONSTRAINT "image_file_image_id_image_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_file" ADD CONSTRAINT "image_file_root_id_library_root_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."library_root"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_tag" ADD CONSTRAINT "image_tag_image_id_image_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_tag" ADD CONSTRAINT "image_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_message_conversation" ON "ai_message" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_api_usage_api_time" ON "api_usage" USING btree ("api","create_time");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_app_setting_key" ON "app_setting" USING btree ("key") WHERE "app_setting"."delete_state" = 0;--> statement-breakpoint
CREATE INDEX "idx_file_op_batch" ON "file_op" USING btree ("batch_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_image_content_hash" ON "image" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "idx_image_rating" ON "image" USING btree ("rating");--> statement-breakpoint
CREATE INDEX "idx_image_ai_result_image" ON "image_ai_result" USING btree ("image_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_image_embedding" ON "image_embedding" USING btree ("image_id","model") WHERE "image_embedding"."delete_state" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX "uk_image_file_location" ON "image_file" USING btree ("root_id","rel_path") WHERE "image_file"."delete_state" = 0;--> statement-breakpoint
CREATE INDEX "idx_image_file_image" ON "image_file" USING btree ("image_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_image_tag" ON "image_tag" USING btree ("image_id","tag_id") WHERE "image_tag"."delete_state" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX "uk_library_root_path" ON "library_root" USING btree ("path") WHERE "library_root"."delete_state" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX "uk_tag_name" ON "tag" USING btree ("name") WHERE "tag"."delete_state" = 0;