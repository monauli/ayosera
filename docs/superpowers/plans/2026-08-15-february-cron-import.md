# February Cron Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run the verified February historical import once from the existing inventory cron, directly against the production database, without HTTP or period locking.

**Architecture:** Add one idempotent migration function called inside the existing cron after its database lock is acquired. It claims a marker in `olseraInventoryState`, validates the built-in 31/17/48 source against the catalog, upserts the same monthly snapshot documents as the supervisor route, and records completion or failure diagnostics.

**Tech Stack:** TypeScript, MongoDB collections, existing historical import planner, Vitest.

## Global Constraints

- Do not expose or modify secrets.
- Do not alter Olsera stock.
- Do not lock February.
- Preserve the two arithmetic mismatches as `incomplete` diagnostics.
- Do not import March–August.

---

### Task 1: Add migration regression test

**Files:**
- Create: `lib/february-historical-migration.test.ts`

- [ ] Assert the migration uses the marker and completion state, and contains no period-lock operation.

### Task 2: Implement direct cron migration

**Files:**
- Create: `lib/february-historical-migration.ts`
- Modify: `lib/cron-olsera-inventory.ts`

- [ ] Claim the marker atomically, validate source/catalog identity and 31/17/48, upsert monthly snapshots, preserve incomplete diagnostics, and mark completion.
- [ ] Call the migration from the existing cron before normal sync work and expose only safe status fields.

### Task 3: Verify and hand off

**Files:**
- Modify: `AYOSERA-HANDOFF-LATEST.md`

- [ ] Run tests, typecheck, build, and diff check; inspect changed files; commit and push only if all pass.
- [ ] Record whether production cron execution and read-back were possible without exposing credentials.
