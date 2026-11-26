CREATE INDEX "idx_image_active_create" ON "image" USING btree ("create_time","id") WHERE "image"."delete_state" = 0;--> statement-breakpoint
CREATE INDEX "idx_image_active_r18" ON "image" USING btree ("is_r18") WHERE "image"."delete_state" = 0;--> statement-breakpoint
CREATE INDEX "idx_image_file_root_status" ON "image_file" USING btree ("root_id","status") WHERE "image_file"."delete_state" = 0;--> statement-breakpoint
CREATE INDEX "idx_image_tag_image_status" ON "image_tag" USING btree ("image_id","status") WHERE "image_tag"."delete_state" = 0;--> statement-breakpoint
CREATE INDEX "idx_image_tag_tag_status" ON "image_tag" USING btree ("tag_id","status") WHERE "image_tag"."delete_state" = 0;