-- 按画布定稿的规则调整结构：标签分类改成用户维护的表、加标签别名、区分源目录和类目录、
-- 删除改为进系统回收站（不再有应用内回收站）、图片加 R-18 开关和拍摄信息。只往前加，保留已有数据。

-- 1. 目录类型：已有目录都是导入的源目录；不再使用应用内回收站目录
CREATE TYPE "public"."root_kind" AS ENUM('SOURCE', 'CATEGORY');--> statement-breakpoint
ALTER TABLE "library_root" ADD COLUMN "kind" "root_kind" DEFAULT 'SOURCE' NOT NULL;--> statement-breakpoint
ALTER TABLE "library_root" DROP COLUMN "trash_dir";--> statement-breakpoint
DROP INDEX "uk_library_root_path";--> statement-breakpoint
CREATE UNIQUE INDEX "uk_library_root_path" ON "library_root" USING btree (lower("path")) WHERE "library_root"."delete_state" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX "uk_library_root_category" ON "library_root" USING btree ("kind") WHERE "library_root"."delete_state" = 0 and "library_root"."kind" = 'CATEGORY';--> statement-breakpoint

-- 2. 文件状态：TRASHED（应用内回收站）改名为 DELETED（已进系统回收站）
ALTER TYPE "public"."file_status" RENAME VALUE 'TRASHED' TO 'DELETED';--> statement-breakpoint

-- 3. 文件操作类型：MOVE / COPY / RENAME / DELETE；旧的 TRASH、PURGE 归为 DELETE，RESTORE 归为 MOVE
ALTER TYPE "public"."file_op_type" RENAME TO "file_op_type_old";--> statement-breakpoint
CREATE TYPE "public"."file_op_type" AS ENUM('MOVE', 'COPY', 'RENAME', 'DELETE');--> statement-breakpoint
ALTER TABLE "file_op" ALTER COLUMN "op_type" TYPE "public"."file_op_type" USING (
  CASE "op_type"::text
    WHEN 'TRASH' THEN 'DELETE'
    WHEN 'PURGE' THEN 'DELETE'
    WHEN 'RESTORE' THEN 'MOVE'
    ELSE "op_type"::text
  END
)::"public"."file_op_type";--> statement-breakpoint
DROP TYPE "public"."file_op_type_old";--> statement-breakpoint

-- 4. 标签分类表：旧的分类枚举和新表同名，先把枚举改名让开
ALTER TYPE "public"."tag_category" RENAME TO "tag_category_old";--> statement-breakpoint
CREATE TABLE "tag_category" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tag_category_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"color_index" smallint NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "uk_tag_category_name" ON "tag_category" USING btree (lower("name")) WHERE "tag_category"."delete_state" = 0;--> statement-breakpoint
-- 预设 8 个分类，颜色序号对应 12 色调色板
INSERT INTO "tag_category" ("name", "color_index", "sort_order") VALUES
  ('角色', 0, 1), ('作品', 1, 2), ('画师', 2, 3), ('主题', 3, 4),
  ('地点', 4, 5), ('人物', 5, 6), ('器材', 9, 7), ('风格', 8, 8);--> statement-breakpoint

-- 5. 标签改为引用分类表：CHARACTER→角色，SERIES→作品，ARTIST→画师，GENERAL/OTHER→主题
ALTER TABLE "tag" ADD COLUMN "category_id" bigint;--> statement-breakpoint
UPDATE "tag" SET "category_id" = (
  SELECT "id" FROM "tag_category" WHERE "name" = CASE "tag"."category"::text
    WHEN 'CHARACTER' THEN '角色'
    WHEN 'SERIES' THEN '作品'
    WHEN 'ARTIST' THEN '画师'
    ELSE '主题'
  END
);--> statement-breakpoint
ALTER TABLE "tag" ALTER COLUMN "category_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tag" DROP COLUMN "category";--> statement-breakpoint
DROP TYPE "public"."tag_category_old";--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_category_id_tag_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."tag_category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tag_category" ON "tag" USING btree ("category_id");--> statement-breakpoint
-- 标签名按不区分大小写唯一
DROP INDEX "uk_tag_name";--> statement-breakpoint
CREATE UNIQUE INDEX "uk_tag_name" ON "tag" USING btree (lower("name")) WHERE "tag"."delete_state" = 0;--> statement-breakpoint

-- 6. 标签别名
CREATE TABLE "tag_alias" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tag_alias_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"create_time" timestamp with time zone DEFAULT now() NOT NULL,
	"update_time" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_state" smallint DEFAULT 0 NOT NULL,
	"tag_id" bigint NOT NULL,
	"name" text NOT NULL
);--> statement-breakpoint
ALTER TABLE "tag_alias" ADD CONSTRAINT "tag_alias_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uk_tag_alias_name" ON "tag_alias" USING btree (lower("name")) WHERE "tag_alias"."delete_state" = 0;--> statement-breakpoint
CREATE INDEX "idx_tag_alias_tag" ON "tag_alias" USING btree ("tag_id");--> statement-breakpoint

-- 7. 图片：R-18 开关、拍摄时间、拍摄信息
ALTER TABLE "image" ADD COLUMN "is_r18" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "image" ADD COLUMN "taken_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "image" ADD COLUMN "exif" jsonb;
