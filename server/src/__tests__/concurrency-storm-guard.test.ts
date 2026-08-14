import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Concurrency / storm guard verification run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres concurrency + storm guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The global cap mirrors server/src/services/heartbeat.ts.
const GLOBAL_MAX_RUNNING = 100;

describeEmbeddedPostgres("AGE-7693 concurrency control + storm guard verification", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-age7693-concurrency-storm-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Concurrency / storm guard verification run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts: {
    maxConcurrentRuns?: number;
    agentName?: string;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts.agentName ?? "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          ...(opts.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: opts.maxConcurrentRuns } : {}),
        },
      },
      permissions: {},
    });

    return { companyId, agentId, prefix };
  }

  async function insertRun(opts: {
    companyId: string;
    agentId: string;
    status: "queued" | "running" | "succeeded" | "failed";
    issueId?: string;
    contextSnapshot?: Record<string, unknown>;
    runId?: string;
  }) {
    const runId = opts.runId ?? randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: opts.companyId,
      agentId: opts.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts.status,
      contextSnapshot: {
        issueId: opts.issueId,
        taskId: opts.issueId,
        wakeReason: "issue_assigned",
        ...(opts.contextSnapshot ?? {}),
      },
      ...(opts.status === "running" ? { startedAt: new Date() } : {}),
    });
    return runId;
  }

  async function getRunStatus(runId: string): Promise<string | undefined> {
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    return run?.status;
  }

  describe("concurrency control — runs queue beyond limits", () => {
    it("leaves a queued run queued when the per-agent concurrency slot is full", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent({ maxConcurrentRuns: 1 });

      // Occupy the single per-agent slot.
      await insertRun({ companyId, agentId, status: "running" });
      // Second run must wait in the queue.
      const queuedRunId = await insertRun({ companyId, agentId, status: "queued" });

      await heartbeat.resumeQueuedRuns();

      expect(await getRunStatus(queuedRunId)).toBe("queued");
    });

    it("leaves a queued run queued when the global cap is reached", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent({
        maxConcurrentRuns: GLOBAL_MAX_RUNNING,
      });

      // Fill the global budget with running runs for the flood agent.
      const floodRuns: string[] = [];
      for (let i = 0; i < GLOBAL_MAX_RUNNING; i += 1) {
        floodRuns.push(await insertRun({ companyId, agentId, status: "running" }));
      }
      expect(floodRuns).toHaveLength(GLOBAL_MAX_RUNNING);

      // A second, distinct agent with a queued run.
      const { companyId: company2, agentId: agent2 } = await seedCompanyAndAgent();
      const queuedRunId = await insertRun({ companyId: company2, agentId: agent2, status: "queued" });

      await heartbeat.resumeQueuedRuns();

      expect(await getRunStatus(queuedRunId)).toBe("queued");
    });

    it("claims a queued run when neither limit is reached (control)", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const queuedRunId = await insertRun({ companyId, agentId, status: "queued" });

      await heartbeat.resumeQueuedRuns();

      // With no competing running runs, the queued run should be claimed and settle.
      expect(await getRunStatus(queuedRunId)).not.toBe("queued");
    });
  });

  describe("storm guard — pauses recovery issue creation under high failure rate", () => {
    async function seedRecentRecoveryIssues(companyId: string, count: number) {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const id = randomUUID();
        ids.push(id);
        await db.insert(issues).values({
          id,
          companyId,
          title: `Recovery storm seed ${i}`,
          description: "Seed recovery action for storm guard verification.",
          status: "todo",
          priority: "medium",
          originKind: "stranded_issue_recovery",
          originId: randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      return ids;
    }

    // An assigned `todo` issue whose one automatic dispatch recovery was already
    // used normally escalates by creating a stranded_issue_recovery issue.
    async function seedStrandedEscalationCandidate() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      const now = new Date("2026-03-19T00:00:00.000Z");

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: prefix,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assignment_recovery",
        payload: { issueId },
        status: "failed",
        runId,
        claimedAt: now,
        finishedAt: new Date("2026-03-19T00:05:00.000Z"),
        error: "run failed before issue advanced",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        wakeupRequestId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_assignment_recovery",
          retryReason: "assignment_recovery",
        },
        startedAt: now,
        finishedAt: new Date("2026-03-19T00:05:00.000Z"),
        updatedAt: new Date("2026-03-19T00:05:00.000Z"),
        errorCode: "process_lost",
        error: "run failed before issue advanced",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover stranded assigned work",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        assigneeUserId: null,
        issueNumber: 1,
        identifier: `${prefix}-1`,
      });

      return { companyId, agentId, issueId, runId };
    }

    async function countRecoveryIssues(companyId: string) {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
      return rows[0]?.count ?? 0;
    }

    it("creates a recovery issue when the storm guard is below threshold (control)", async () => {
      const { companyId, issueId } = await seedStrandedEscalationCandidate();

      const result = await heartbeat.reconcileStrandedAssignedIssues();

      expect(result.escalated).toBe(1);
      expect(result.skipped).toBe(0);
      expect(await countRecoveryIssues(companyId)).toBe(1);

      const recovery = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
      expect(recovery[0]?.originId).toBe(issueId);
    });

    it("pauses recovery issue creation when many recovery actions were created with few resolved", async () => {
      const { companyId, issueId } = await seedStrandedEscalationCandidate();

      // Seed 6 recent unresolved recovery actions -> createdCount=6 > 5 and
      // createdCount(6) > resolvedCount*2(0) => storm guard active.
      await seedRecentRecoveryIssues(companyId, 6);

      const result = await heartbeat.reconcileStrandedAssignedIssues();

      // The storm guard short-circuits the whole candidate: no escalation, no
      // recovery issue creation.
      expect(result.escalated).toBe(0);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      // No NEW stranded_issue_recovery issue is created beyond the 6 seeds.
      expect(await countRecoveryIssues(companyId)).toBe(6);

      // The source issue stays in todo (not escalated to blocked).
      const source = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(source?.status).toBe("todo");
    });

    it("does not trigger when the created count is at the boundary (createdCount === 5)", async () => {
      const { companyId, issueId } = await seedStrandedEscalationCandidate();

      // 5 created, 0 resolved -> createdCount(5) is not > 5 => guard inactive.
      await seedRecentRecoveryIssues(companyId, 5);

      const result = await heartbeat.reconcileStrandedAssignedIssues();

      expect(result.escalated).toBe(1);
      expect(await countRecoveryIssues(companyId)).toBe(6); // 5 seeds + 1 new
    });

    it("stays inactive when resolved recovery actions keep pace (createdCount <= resolvedCount*2)", async () => {
      const { companyId, issueId } = await seedStrandedEscalationCandidate();

      // Seed 6 created, but 4 resolved within the window.
      // createdCount(6) > resolvedCount*2(8)? No => guard inactive.
      for (let i = 0; i < 6; i += 1) {
        await db.insert(issues).values({
          id: randomUUID(),
          companyId,
          title: `Recovery pace seed ${i}`,
          description: "Seed recovery action.",
          status: i < 4 ? "done" : "todo",
          priority: "medium",
          originKind: "stranded_issue_recovery",
          originId: randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      const result = await heartbeat.reconcileStrandedAssignedIssues();

      expect(result.escalated).toBe(1);
      expect(await countRecoveryIssues(companyId)).toBe(7); // 6 seeds + 1 new
    });
  });
});
