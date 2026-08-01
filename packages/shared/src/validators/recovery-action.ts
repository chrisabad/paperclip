import { z } from "zod";

export const recoveryActionOutcomes = [
  "restored",
  "exhausted",
  "cancelled",
] as const;

export const resolveRecoveryActionSchema = z.object({
  outcome: z.enum(recoveryActionOutcomes),
  note: z.string().max(2000).optional().nullable(),
});

export type ResolveRecoveryAction = z.infer<typeof resolveRecoveryActionSchema>;
export type RecoveryActionOutcome = (typeof recoveryActionOutcomes)[number];
