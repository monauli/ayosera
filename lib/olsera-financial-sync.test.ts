import test from "node:test";
import assert from "node:assert/strict";
import { accountDocumentId, ledgerEntryId, monthlyReportId } from "./olsera-financial-store.ts";
test("financial identifiers are deterministic", () => { const row = { account_id: 84341, account_code: 11105, transaction_no: "JU1", transaction_date: "2026-05-01", debit: 10, credit: 0 }; assert.equal(monthlyReportId(324175, "2026-05", "profit-loss"), "324175:2026-05:profit-loss"); assert.equal(accountDocumentId(324175, row), "324175:account:84341"); assert.equal(ledgerEntryId(324175, "2026-05", "11105", { ...row, id: 99 }), "324175:2026-05:11105:99"); assert.equal(ledgerEntryId(324175, "2026-05", "11105", row), ledgerEntryId(324175, "2026-05", "11105", row)); });
