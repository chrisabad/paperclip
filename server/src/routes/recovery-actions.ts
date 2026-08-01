import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { resolveRecoveryActionSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { recoveryService, logActivity, heartbeatService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function recoveryActionRoutes(db: Db) {
  const router = Router();
  const heartbeat = heartbeatService(db);
  const recoverySvc = recoveryService(db, { enqueueWakeup: heartbeat.wakeup });

  router.post(
    "/companies/:companyId/recovery-actions/:id/resolve",
    validate(resolveRecoveryActionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const recoveryIssueId = req.params.id as string;
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      const mapActor = {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId ?? undefined,
      };
      const result = await recoverySvc.resolveRecoveryAction(
        recoveryIssueId,
        req.body,
        mapActor,
      );

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? undefined,
        runId: actor.runId ?? undefined,
        action: "recovery_action.resolved",
        entityType: "issue",
        entityId: recoveryIssueId,
        details: {
          source: "routes.recovery_actions.resolve",
          outcome: result.outcome,
        },
      });

      res.json(result);
    },
  );

  return router;
}
