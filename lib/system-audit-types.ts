export type AuditCheckStatus = "pass" | "warning" | "manual" | "failed" | "unavailable";

export type SystemAuditCheck = {
  id: string;
  module: string;
  period?: string | null;
  subject?: string | null;
  status: AuditCheckStatus;
  difference?: Record<string, unknown> | null;
  impact?: "low" | "medium" | "high" | "critical";
  checkedAt: string;
  recommendation: string;
};

export type SystemAuditSummary = Record<AuditCheckStatus, number>;

export type SystemAuditResult = {
  runId: string;
  storeId: number;
  scope: string;
  status: "completed" | "failed";
  startedAt: string;
  completedAt: string;
  checks: SystemAuditCheck[];
  summary: SystemAuditSummary;
};
