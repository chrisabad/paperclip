import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRecoveryService = vi.hoisted(() => ({
  resolveRecoveryAction: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  recoveryService: () => mockRecoveryService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  vi.resetModules();
  const [{ errorHandler }, { recoveryActionRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/recovery-actions.js") as Promise<typeof import("../routes/recovery-actions.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", recoveryActionRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

describe.sequential("recovery-actions routes", () => {
  beforeEach(() => {
    mockRecoveryService.resolveRecoveryAction.mockReset();
    mockLogActivity.mockReset();
  });

  it("resolves a recovery action with outcome=restored", async () => {
    mockRecoveryService.resolveRecoveryAction.mockResolvedValue({
      success: true,
      issueId: "recovery-1",
      outcome: "restored",
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/recovery-actions/recovery-1/resolve")
        .send({ outcome: "restored", note: "Issue was fixed" }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      issueId: "recovery-1",
      outcome: "restored",
    });
    expect(mockRecoveryService.resolveRecoveryAction).toHaveBeenCalledWith(
      "recovery-1",
      { outcome: "restored", note: "Issue was fixed" },
      expect.objectContaining({}),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "recovery_action.resolved",
        entityId: "recovery-1",
        details: expect.objectContaining({ outcome: "restored" }),
      }),
    );
  });

  it("resolves a recovery action with outcome=exhausted", async () => {
    mockRecoveryService.resolveRecoveryAction.mockResolvedValue({
      success: true,
      issueId: "recovery-2",
      outcome: "exhausted",
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/recovery-actions/recovery-2/resolve")
        .send({ outcome: "exhausted" }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "exhausted" });
  });

  it("resolves a recovery action with outcome=cancelled", async () => {
    mockRecoveryService.resolveRecoveryAction.mockResolvedValue({
      success: true,
      issueId: "recovery-3",
      outcome: "cancelled",
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/recovery-actions/recovery-3/resolve")
        .send({ outcome: "cancelled", note: "No longer needed" }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "cancelled" });
  });

  it("rejects invalid outcome values", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/recovery-actions/recovery-1/resolve")
        .send({ outcome: "invalid_outcome" }),
    );

    expect(res.status).toBe(400);
    expect(mockRecoveryService.resolveRecoveryAction).not.toHaveBeenCalled();
  });

  it("rejects missing outcome field", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/recovery-actions/recovery-1/resolve")
        .send({ note: "missing outcome" }),
    );

    expect(res.status).toBe(400);
    expect(mockRecoveryService.resolveRecoveryAction).not.toHaveBeenCalled();
  });

  it("rejects note exceeding 2000 characters", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/recovery-actions/recovery-1/resolve")
        .send({ outcome: "restored", note: "x".repeat(2001) }),
    );

    expect(res.status).toBe(400);
    expect(mockRecoveryService.resolveRecoveryAction).not.toHaveBeenCalled();
  });

  it("forbids agent access from another company", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-2",
      source: "api_key",
    });
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/recovery-actions/recovery-1/resolve")
        .send({ outcome: "restored" }),
    );

    expect(res.status).toBe(403);
    expect(mockRecoveryService.resolveRecoveryAction).not.toHaveBeenCalled();
  });

  it("allows agent access within the same company", async () => {
    mockRecoveryService.resolveRecoveryAction.mockResolvedValue({
      success: true,
      issueId: "recovery-1",
      outcome: "restored",
    });

    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "api_key",
    });
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/recovery-actions/recovery-1/resolve")
        .send({ outcome: "restored" }),
    );

    expect(res.status).toBe(200);
  });
});
