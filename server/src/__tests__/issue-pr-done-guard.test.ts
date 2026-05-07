import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  hasPermission: vi.fn(async () => false),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async () => null),
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({
      getById: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

type TestActor = {
  type: "board";
  userId: string;
  companyIds: string[];
  source: "local_implicit";
  isInstanceAdmin: boolean;
};

const boardActor: TestActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

async function createApp(actor?: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? boardActor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function baseIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: "33333333-3333-4333-8333-333333333333",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "AGE-99999",
    title: "Test issue",
    executionPolicy: null,
    executionState: null,
    projectId: null,
    goalId: null,
    parentId: null,
    childIssueIds: [],
    childIssueSummaries: [],
    childIssueSummaryTruncated: false,
    blockerIssueIds: [],
    ...overrides,
  };
}

describe("PR-done guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...baseIssue(),
      ...patch,
      updatedAt: new Date(),
    }));
  });

  it("rejects PATCH status:done when linked PR is not merged (OPEN)", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    mockWorkProductService.listForIssue.mockResolvedValue([
      {
        id: "wp-1",
        type: "pull_request",
        status: "open",
        healthStatus: "healthy",
        isPrimary: true,
      },
    ]);

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("not merged");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects PATCH status:done when linked PR has failing CI", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    mockWorkProductService.listForIssue.mockResolvedValue([
      {
        id: "wp-2",
        type: "pull_request",
        status: "merged",
        healthStatus: "unhealthy",
        isPrimary: true,
      },
    ]);

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("failing CI");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows PATCH status:done when all linked PRs are merged and CI is green", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    mockWorkProductService.listForIssue.mockResolvedValue([
      {
        id: "wp-3",
        type: "pull_request",
        status: "merged",
        healthStatus: "healthy",
        isPrimary: true,
      },
    ]);

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("allows PATCH status:done when issue has no pull_request work products", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    mockWorkProductService.listForIssue.mockResolvedValue([
      {
        id: "wp-4",
        type: "branch",
        status: "active",
        healthStatus: "healthy",
        isPrimary: false,
      },
    ]);

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("skips guard when status is not transitioning to done", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    // The request may fail for other reasons (no review path), but the guard itself should not block
    // We just verify workProductService.listForIssue was NOT called for non-done transitions
    // Actually, the guard only runs for done transitions, so listForIssue should not be called
    expect(mockWorkProductService.listForIssue).not.toHaveBeenCalled();
  });
});
