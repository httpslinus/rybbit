ALTER TABLE "sites" ADD COLUMN "heatmaps" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "heatmap_sample_rate" real DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_heatmap_sample_rate_check" CHECK ("sites"."heatmap_sample_rate" >= 0 AND "sites"."heatmap_sample_rate" <= 100);