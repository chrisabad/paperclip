ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "task_key" text;--> statement-breakpoint

-- Backfill pre-existing rows from context_snapshot JSONB so liveness scope
-- queries match historical runs. Precedence mirrors deriveTaskKey:
-- task_key = taskKey ?? taskId ?? issueId; task_id = taskId ?? issueId; issue_id = issueId.
UPDATE "heartbeat_runs"
SET "issue_id" = "context_snapshot" ->> 'issueId'
WHERE "issue_id" IS NULL
  AND "context_snapshot" ->> 'issueId' IS NOT NULL;--> statement-breakpoint

UPDATE "heartbeat_runs"
SET "task_id" = COALESCE("context_snapshot" ->> 'taskId', "context_snapshot" ->> 'issueId')
WHERE "task_id" IS NULL
  AND COALESCE("context_snapshot" ->> 'taskId', "context_snapshot" ->> 'issueId') IS NOT NULL;--> statement-breakpoint

UPDATE "heartbeat_runs"
SET "task_key" = COALESCE(
  "context_snapshot" ->> 'taskKey',
  "context_snapshot" ->> 'taskId',
  "context_snapshot" ->> 'issueId'
)
WHERE "task_key" IS NULL
  AND COALESCE(
    "context_snapshot" ->> 'taskKey',
    "context_snapshot" ->> 'taskId',
    "context_snapshot" ->> 'issueId'
  ) IS NOT NULL;--> statement-breakpoint

CREATE INDEX "heartbeat_runs_company_issue_idx" ON "heartbeat_runs" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_task_id_idx" ON "heartbeat_runs" USING btree ("company_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_task_key_idx" ON "heartbeat_runs" USING btree ("company_id","task_key","created_at");