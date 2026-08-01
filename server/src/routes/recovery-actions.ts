import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { resolveRecoveryActionSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { recoveryService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function recoveryActionRoutes(db: Db) {
  const router = Router();
  const recoverySvc = recoveryService(db);

  router.post(
    "/companies/:companyId/recovery-actions/:id/resolve",
    validate(resolveRecoveryActionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const recoveryIssueId = req.params.id as string;
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      const result = await recoverySvc.resolveRecoveryAction(
        recoveryIssueId,
        req.body,
        actor,
      );

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? null,
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
