ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "task_key" text;--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_issue_idx" ON "heartbeat_runs" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_task_id_idx" ON "heartbeat_runs" USING btree ("company_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_task_key_idx" ON "heartbeat_runs" USING btree ("company_id","task_key","created_at");