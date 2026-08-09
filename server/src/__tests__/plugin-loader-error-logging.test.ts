import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pluginLoader } from "../services/plugin-loader.js";

// Mock the logger so we can assert on the WARN emitted for error-status plugins.
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin-loader error logging tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin-loader error-status boot logging", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-errlog-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(plugins);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function manifest(pluginKey: string): PaperclipPluginManifestV1 {
    return {
      id: pluginKey,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Error Logging Test",
      description: "Exercises error-status boot logging.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [],
      entrypoints: { worker: "./dist/worker.js" },
    };
  }

  async function insertErrorPlugin(pluginKey: string, lastError: string) {
    await db.insert(plugins).values({
      id: randomUUID(),
      pluginKey,
      packageName: pluginKey,
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: manifest(pluginKey),
      status: "error",
      installOrder: 1,
      lastError,
    });
  }

  it("logs a WARN naming the plugin and its lastError when a plugin is in error status at boot", async () => {
    const pluginKey = "paperclip.errlog";
    const lastError = "activation failed: entrypoint not found";
    await insertErrorPlugin(pluginKey, lastError);

    const loader = pluginLoader(
      db,
      { enableLocalFilesystem: false, enableNpmDiscovery: false },
      // loadAll only requires runtimeServices to be present when there are no
      // ready plugins; a minimal stub is sufficient for this path.
      {
        instanceInfo: { instanceId: "test-instance", hostVersion: "1.0.0" },
      } as never,
    );

    const result = await loader.loadAll();

    expect(result.total).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);

    const { logger } = await import("../middleware/logger.js");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [args, message] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args).toMatchObject({
      pluginKey,
      lastError,
    });
    expect(message).toContain("error status");
  });

  it("does not log a WARN when there are no error-status plugins", async () => {
    const loader = pluginLoader(
      db,
      { enableLocalFilesystem: false, enableNpmDiscovery: false },
      {
        instanceInfo: { instanceId: "test-instance", hostVersion: "1.0.0" },
      } as never,
    );

    await loader.loadAll();

    const { logger } = await import("../middleware/logger.js");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
