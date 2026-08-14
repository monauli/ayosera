# Inventory February Universe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the monthly inventory UI, export, and reconciliation use one dynamic sold-plus-historical universe without writing February historical quantities before the user workbook exists.

**Architecture:** Reuse the existing monthly snapshot chain and `buildTwoSheetInventoryRows`; add pure classification/provenance helpers around those rows, then route UI, export, and reconciliation through the same classification. Existing ODEA/YONEX identity and lock history remain untouched; unresolved identities make the period incomplete and non-lockable.

**Tech Stack:** TypeScript, Next.js/React, MongoDB, ExcelJS, Node test runner.

## Global Constraints

- No February historical write until verified `February Terjual` and `February Keseluruhan` workbooks are available.
- Never use current catalog quantity as historical February quantity.
- Do not lock February automatically.
- Preserve ODEA ROSE, YONEX SHORTS, ODEA RED, and lock/unlock history.
- Use dynamic counts and one deduplication key: storeId + productId + variantId.

### Task 1: Define the shared inventory-universe classification

**Files:** Modify `lib/olsera-inventory-ui.ts`; Test `lib/olsera-inventory-ui.test.ts`.

- [ ] Add failing tests for sold, historical non-sold, unresolved, dedupe, dynamic counts, and provenance.
- [ ] Run the focused test and confirm the new symbols fail because they do not exist.
- [ ] Implement pure helpers returning `{ sold, unsold, overall, unresolved, counts }`, with `source: "STOCK_MOVEMENT" | "USER_HISTORICAL_INVENTORY"` and no current-catalog quantity fallback for historical rows.
- [ ] Run the focused test and confirm it passes.

### Task 2: Expose the shared universe from the monthly API

**Files:** Inspect/modify `app/api/olsera/inventory/monthly/route.ts`; Test the existing route or add its focused route test.

- [ ] Add a failing test proving monthly API rows include `inventoryClass`, `source`, and dynamic sold/unsold/overall counts.
- [ ] Run it and confirm failure.
- [ ] Build classification from monthly snapshot rows plus catalog identity only; for historical periods, do not add catalog current quantity rows without a period-specific snapshot.
- [ ] Return completeness using the same universe and keep lock readiness false when unresolved or incomplete rows exist.
- [ ] Run the focused route test and confirm it passes.

### Task 3: Replace the two-tab stock UI with four dynamic tabs

**Files:** Modify `lib/olsera-inventory-ui.ts`, `components/olsera-inventory-panel.tsx`; Test `lib/olsera-inventory-ui.test.ts`.

- [ ] Add failing tests for tab labels/counts, common columns, and preserving movement history.
- [ ] Run focused tests and confirm failure.
- [ ] Add `Stok Terjual`, `Stok Tidak Terjual`, `Stok Keseluruhan`, and `Riwayat Mutasi`; filter the already-fetched monthly rows by shared classification rather than fetching separate universes.
- [ ] Keep search/category/status/hidden filters and existing lock/unlock history controls unchanged.
- [ ] Render category → product → variant and wrap long names with a full-name tooltip.
- [ ] Run focused UI tests and confirm they pass.

### Task 4: Align export with the shared universe

**Files:** Modify `lib/olsera-inventory-two-sheet-export.ts`; Test `lib/olsera-inventory-two-sheet-export.test.ts`.

- [ ] Add failing tests proving Terjual excludes zero-sales rows, Keseluruhan includes them, and duplicate keys appear once.
- [ ] Run focused tests and confirm failure.
- [ ] Reuse the shared classifier before writing sheets; preserve historical snapshot quantities and export provenance metadata where the existing export model permits it.
- [ ] Run export tests and confirm they pass.

### Task 5: Align reconciliation and lock readiness

**Files:** Modify `lib/inventory-monthly-period-lock.ts`, reconciliation inventory route/UI as needed; Test existing lock/reconciliation suites.

- [ ] Add failing tests for reconciliation using the same overall universe and lock rejection for unresolved identity.
- [ ] Run focused tests and confirm failure.
- [ ] Feed reconciliation from the shared overall rows/counts; keep BA limited to known-product quantity differences and never let BA resolve missing identity.
- [ ] Run lock, stock-opname, and reconciliation tests.

### Task 6: Verify safeguards and handoff

**Files:** Modify `AYOSERA-HANDOFF-LATEST.md` only after code verification.

- [ ] Run targeted inventory monthly/export/UI/reconciliation/lock/stock-opname tests.
- [ ] Run typecheck, production build, and `git diff --check`.
- [ ] Confirm no February write, no automatic lock, and no changes to ODEA/YONEX paths.
- [ ] Record workbook blocker and controlled-write status as PENDING in the handoff.
- [ ] Commit code + handoff and push `origin/main`.
