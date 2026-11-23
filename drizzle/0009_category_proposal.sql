CREATE TABLE "category_analyzed_image" (
	"image_id" bigint PRIMARY KEY NOT NULL,
	"proposal_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_proposal" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "category_proposal_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"status" text DEFAULT 'pending' NOT NULL,
	"home" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "category_proposal_status_check" CHECK ("category_proposal"."status" IN ('pending', 'applied', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "category_analyzed_image" ADD CONSTRAINT "category_analyzed_image_image_id_image_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_analyzed_image" ADD CONSTRAINT "category_analyzed_image_proposal_id_category_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."category_proposal"("id") ON DELETE no action ON UPDATE no action;