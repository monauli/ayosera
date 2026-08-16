# Rebuild Monthly Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a supervisor-only dry-run/write process for one monthly inventory snapshot and verify it for March 2026.

**Architecture:** Reuse `ensureMonthlySnapshotChain` internals through a new service that exposes dry-run diagnostics and guarded write. Add one supervisor endpoint and controls in Inventory Reconciliation; keep export read-only and remove only the Inventory-page lock button.

**Tech Stack:** Next.js App Router, TypeScript, MongoDB repository, existing inventory snapshot/matching helpers, Node test runner, existing workbook export dependency.

## Global Constraints

- Only March 2026 may be run in production for this task.
- Locked periods are rejected server-side.
- Dry-run never writes.
- Snapshot backup precedes replacement; failed writes preserve readable old data.
- No changes to December–February, Olsera stock, or lock history.

### Task 1: Service and regression tests

**Files:**
- Create: `lib/rebuild-monthly-inventory.ts`
- Test: `lib/rebuild-monthly-inventory.test.ts`
- Modify: `lib/olsera-inventory-monthly-snapshot-store.ts` only if a shared repository helper must be exported.

- [ ] Write tests for dry-run no-write, February closing anchor, pagination result, carry-forward, new product, null variant, dedupe, positive/negative opname, formula mismatch, rerun, lock rejection, backup-before-write, failure preserving old snapshot, and month isolation.
- [ ] Run the focused test and confirm RED.
- [ ] Implement `inspectMonthlyInventory({year,month,repo,...})` and `rebuildMonthlyInventory({year,month,mode,repo,...})` using existing matching/formula/upsert primitives; reject locked periods and incomplete/duplicate candidates.
- [ ] Run focused tests and confirm PASS.

### Task 2: Supervisor endpoint and report fallback

**Files:**
- Create: `app/api/olsera/inventory/rebuild-monthly/route.ts`
- Create: `lib/monthly-inventory-difference-report.ts`
- Test: `lib/rebuild-monthly-inventory-route.test.ts`

- [ ] Add POST body validation for `year`, `month`, and `mode` (`dryRun` or `write`), require supervisor authorization, and never accept source quantities from client.
- [ ] Return dry-run diagnostics; on write call the service and return read-back summary.
- [ ] Generate the fallback workbook from diagnostics with Ringkasan plus Maret–Agustus sheets; keep sheets after Maret empty.
- [ ] Test auth, validation, dry-run no-write, write guard, and report structure.

### Task 3: Reconciliation UI and Inventory lock-button removal

**Files:**
- Modify: `app/reconciliation/inventory/page.tsx`
- Modify: inventory page component containing `Kunci Periode`.
- Test: relevant reconciliation/inventory UI tests.

- [ ] Add supervisor-only period picker, `Periksa Dulu`, diagnostics summary, difference list, and disabled-until-safe `Proses`.
- [ ] Keep lock control only in Reconciliation Inventory and never auto-click it.
- [ ] Remove the ordinary Inventory-page lock button without changing backend lock handlers.
- [ ] Add UI tests for dry-run/process gating and absent Inventory lock button.

### Task 4: Verification and handoff

**Files:**
- Modify: `AYOSERA-HANDOFF-FINAL.md`
- Modify: `AYOSERA-HANDOFF-LATEST.md`

- [ ] Run all requested tests, typecheck, scoped lint, build, and diff check.
- [ ] Run dry-run and write/read-back for March only through the official endpoint; run write twice and verify stable counts/no duplicates.
- [ ] Inspect the real production UI tabs and export without using export as a rebuild trigger.
- [ ] Update both handoffs with before/after, differences workbook path, test results, commit/deploy, and March unlocked status.
- [ ] Commit and push only source, tests, report, and handoff files; never stage user fixtures, backups, or secrets.
