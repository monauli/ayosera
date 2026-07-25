// @ts-nocheck
/**
 * Repair terkontrol bug tanda negatif Buku Besar Detail (Februari-Juli 2026).
 *
 * TIDAK PERNAH memanggil API Olsera live — seluruh perhitungan memakai
 * `rawPayload` yang SUDAH tersimpan di setiap dokumen
 * `olsera_financial_ledger_entries`. TIDAK melakukan sync ulang, TIDAK
 * menghapus dokumen. Hanya field `debit`/`credit` yang diperbaiki pada
 * dokumen yang nilainya benar-benar berbeda dari hasil normalisasi yang
 * sudah diperbaiki (lihat lib/olsera-financial-core.ts,
 * normalizeLedgerDetailPayload). Akun 60100 TIDAK disentuh sama sekali.
 *
 * Mode:
 *   --dry-run        (default) hanya identifikasi + laporan, tidak menulis apa pun.
 *   --apply           backup lalu tulis perbaikan (idempotent).
 *   --restore <runId> kembalikan nilai debit/credit ke sebelum repair, dari backup runId tsb.
 */
import pkg from "@next/env";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { parseFinancialAmount } from "../lib/olsera-financial-core.ts";

const { loadEnvConfig } = pkg;
loadEnvConfig(process.cwd());

const OUT_DIR = path.join(process.cwd(), "tmp", "ledger-sign-repair-2026");
fs.mkdirSync(OUT_DIR, { recursive: true });
const BACKUP_FILE = path.join(OUT_DIR, "backup-ledger.jsonl");

const PERIODS = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
const PROTECTED_ACCOUNT = "60100";

const EXPECTED_NEGATIVE_ENTRY_COUNT = 63;
const EXPECTED_AFFECTED = new Map<string, string[]>([
  ["50500", ["2026-02", "2026-03", "2026-04", "2026-05"]],
  ["51000", ["2026-02", "2026-03"]],
  ["70001", ["2026-02"]],
]);

function first(row: Record<string, unknown>, keys: string[]): unknown {
  return keys.map((key) => row[key]).find((value) => value != null && String(value).trim() !== "");
}

/** Logika normalizer yang SUDAH DIPERBAIKI: tanpa Math.abs() pada credit. */
function recomputeFixed(rawRow: Record<string, unknown>) {
  const debit = parseFinancialAmount(first(rawRow, ["fdebit", "debit"]) as any);
  const credit = parseFinancialAmount(first(rawRow, ["fcredit", "credit"]) as any);
  return { debit, credit };
}

function hashRawPayload(raw: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(raw ?? null)).digest("hex").slice(0, 32);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const mode = args.includes("--apply") ? "apply" : args.includes("--restore") ? "restore" : "dry-run";
  const restoreIdx = args.indexOf("--restore");
  const restoreRunId = restoreIdx >= 0 ? args[restoreIdx + 1] : null;
  return { mode, restoreRunId };
}

async function collectCandidates(db: any, storeId: number) {
  const ledger = db.collection("olsera_financial_ledger_entries");
  const candidates: any[] = [];
  const negativeEntries: any[] = [];

  for (const period of PERIODS) {
    const rows = await ledger.find({ storeId, period, accountCode: { $ne: PROTECTED_ACCOUNT } }).sort({ accountCode: 1, transactionDate: 1 }).toArray();
    for (const row of rows) {
      if (row.isOpeningBalance === true) continue;
      const raw = (row.rawPayload && typeof row.rawPayload === "object" ? row.rawPayload : {}) as Record<string, unknown>;
      const rawDebit = first(raw, ["fdebit", "debit"]);
      const rawCredit = first(raw, ["fcredit", "credit"]);
      const { debit: fixedDebit, credit: fixedCredit } = recomputeFixed(raw);
      if (fixedDebit < 0 || fixedCredit < 0) {
        negativeEntries.push({ period, accountCode: row.accountCode, transactionNo: row.transactionNo, rawDebit, rawCredit });
      }
      const currentDebit = Number(row.debit) || 0;
      const currentCredit = Number(row.credit) || 0;
      const changed = Math.abs(currentDebit - fixedDebit) > 0.01 || Math.abs(currentCredit - fixedCredit) > 0.01;
      if (changed) {
        candidates.push({
          _id: row._id,
          period,
          accountCode: row.accountCode,
          accountName: row.accountName ?? null,
          transactionNo: row.transactionNo ?? null,
          transactionDate: row.formattedTransactionDate ?? row.transactionDate ?? null,
          description: row.description ?? null,
          currentDebit,
          currentCredit,
          fixedDebit,
          fixedCredit,
          rawPayloadHash: hashRawPayload(row.rawPayload),
          fullDoc: row,
        });
      }
    }
  }
  return { candidates, negativeEntries };
}

/**
 * `negativeEntryCount` adalah invarian atas rawPayload (tidak pernah berubah
 * oleh repair) — selalu diverifikasi. Pencocokan akun/periode yang TERDAMPAK
 * (candidates) HANYA diverifikasi ketat saat candidates.length > 0; run kedua
 * yang idempotent (semua sudah benar, candidates = 0) BUKAN mismatch — itu
 * justru bukti repair sebelumnya berhasil dan tidak ada perubahan tambahan.
 */
function verifyAgainstExpectation(candidates: any[], negativeEntries: any[]) {
  const mismatches: string[] = [];
  if (negativeEntries.length !== EXPECTED_NEGATIVE_ENTRY_COUNT) {
    mismatches.push(`Jumlah entry rawPayload negatif = ${negativeEntries.length}, diharapkan ${EXPECTED_NEGATIVE_ENTRY_COUNT}.`);
  }

  if (candidates.length === 0) return mismatches;

  const byAccountPeriod = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (!byAccountPeriod.has(c.accountCode)) byAccountPeriod.set(c.accountCode, new Set());
    byAccountPeriod.get(c.accountCode)!.add(c.period);
  }
  const actualAccounts = new Set(byAccountPeriod.keys());
  const expectedAccounts = new Set(EXPECTED_AFFECTED.keys());
  for (const acc of actualAccounts) if (!expectedAccounts.has(acc)) mismatches.push(`Akun terdampak TAK TERDUGA: ${acc} (periode: ${[...(byAccountPeriod.get(acc) ?? [])].join(", ")}).`);
  for (const acc of expectedAccounts) if (!actualAccounts.has(acc)) mismatches.push(`Akun yang DIHARAPKAN terdampak tapi TIDAK ditemukan: ${acc}.`);
  for (const [acc, periods] of EXPECTED_AFFECTED) {
    const actualPeriods = byAccountPeriod.get(acc) ?? new Set();
    for (const p of periods) if (!actualPeriods.has(p)) mismatches.push(`Akun ${acc} periode ${p} diharapkan terdampak tapi tidak ditemukan.`);
    for (const p of actualPeriods) if (!periods.includes(p)) mismatches.push(`Akun ${acc} periode ${p} terdampak tapi TIDAK diharapkan.`);
  }
  return mismatches;
}

async function writeDryRunXlsx(candidates: any[], filename: string) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Dry Run");
  ws.columns = [
    { header: "Periode", key: "period", width: 10 },
    { header: "Kode Akun", key: "accountCode", width: 12 },
    { header: "Nama Akun", key: "accountName", width: 28 },
    { header: "No. Jurnal", key: "transactionNo", width: 22 },
    { header: "Tanggal", key: "transactionDate", width: 14 },
    { header: "Deskripsi", key: "description", width: 28 },
    { header: "Debit Lama", key: "currentDebit", width: 16 },
    { header: "Credit Lama", key: "currentCredit", width: 16 },
    { header: "Debit Baru", key: "fixedDebit", width: 16 },
    { header: "Credit Baru", key: "fixedCredit", width: 16 },
    { header: "Hash rawPayload", key: "rawPayloadHash", width: 26 },
  ];
  ws.addRows(candidates.map(({ fullDoc, _id, ...rest }) => rest));
  ws.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile(path.join(OUT_DIR, filename));
}

async function runDryRun(db: any, storeId: number) {
  const { candidates, negativeEntries } = await collectCandidates(db, storeId);
  const mismatches = verifyAgainstExpectation(candidates, negativeEntries);

  await writeDryRunXlsx(candidates, "dry-run-before.xlsx");

  const summary = {
    mode: "dry-run",
    negativeEntryCount: negativeEntries.length,
    candidateCount: candidates.length,
    accountsAffected: [...new Set(candidates.map((c) => c.accountCode))].sort(),
    mismatches,
    matchesExpectation: mismatches.length === 0,
  };
  fs.writeFileSync(path.join(OUT_DIR, "dry-run-result.json"), JSON.stringify({ summary, candidates: candidates.map(({ fullDoc, ...rest }) => rest) }, null, 2));

  console.log(JSON.stringify(summary, null, 2));
  if (mismatches.length > 0) {
    console.error("DRY-RUN TIDAK SESUAI EKSPEKTASI — --apply TIDAK BOLEH dijalankan. Lihat mismatches di atas.");
    process.exitCode = 2;
  }
  return summary;
}

async function runApply(db: any, storeId: number) {
  const { candidates, negativeEntries } = await collectCandidates(db, storeId);
  const mismatches = verifyAgainstExpectation(candidates, negativeEntries);
  if (mismatches.length > 0) {
    console.error("Dry-run internal sebelum apply TIDAK SESUAI EKSPEKTASI. Repair DIBATALKAN, tidak ada tulis ke MongoDB.");
    console.error(JSON.stringify(mismatches, null, 2));
    process.exitCode = 2;
    return;
  }
  if (candidates.length === 0) {
    console.log(JSON.stringify({ mode: "apply", runId: null, message: "Tidak ada dokumen yang perlu diperbaiki (sudah idempotent atau repair sebelumnya sudah diterapkan)." }, null, 2));
    return;
  }

  const runId = `repair-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const ledger = db.collection("olsera_financial_ledger_entries");

  // Backup SEBELUM tulis apa pun.
  const backupLines: string[] = [];
  for (const c of candidates) {
    backupLines.push(JSON.stringify({
      runId,
      backedUpAt: new Date().toISOString(),
      documentId: c._id,
      period: c.period,
      accountCode: c.accountCode,
      accountName: c.accountName,
      transactionNo: c.transactionNo,
      oldValues: { debit: c.currentDebit, credit: c.currentCredit },
      newValues: { debit: c.fixedDebit, credit: c.fixedCredit },
      rawPayloadHash: c.rawPayloadHash,
      fullDocumentBeforeRepair: c.fullDoc,
    }));
  }
  fs.appendFileSync(BACKUP_FILE, backupLines.join("\n") + "\n");

  // Tulis perbaikan — hanya debit/credit + penanda repair, TIDAK menyentuh _id/no jurnal/tanggal/deskripsi/rawPayload.
  let applied = 0;
  const appliedRows: any[] = [];
  for (const c of candidates) {
    const result = await ledger.updateOne(
      { _id: c._id },
      { $set: { debit: c.fixedDebit, credit: c.fixedCredit, signRepairRunId: runId, signRepairedAt: new Date() } },
    );
    if (result.modifiedCount > 0 || result.matchedCount > 0) {
      applied += 1;
      appliedRows.push(c);
    }
  }

  await writeDryRunXlsx(appliedRows, "applied-changes.xlsx");

  fs.writeFileSync(path.join(OUT_DIR, `apply-result-${runId}.json`), JSON.stringify({
    runId,
    documentsBackedUp: candidates.length,
    documentsApplied: applied,
    accountsAffected: [...new Set(candidates.map((c) => c.accountCode))].sort(),
    periodsAffected: [...new Set(candidates.map((c) => c.period))].sort(),
  }, null, 2));

  console.log(JSON.stringify({ mode: "apply", runId, documentsBackedUp: candidates.length, documentsApplied: applied }, null, 2));
}

async function runRestore(db: any, runId: string) {
  if (!runId) throw new Error("--restore membutuhkan <runId>.");
  if (!fs.existsSync(BACKUP_FILE)) throw new Error(`Backup file tidak ditemukan: ${BACKUP_FILE}`);
  const lines = fs.readFileSync(BACKUP_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const forRun = lines.filter((l) => l.runId === runId);
  if (forRun.length === 0) throw new Error(`Tidak ada backup untuk runId "${runId}".`);

  const ledger = db.collection("olsera_financial_ledger_entries");
  let restored = 0;
  for (const entry of forRun) {
    const result = await ledger.updateOne(
      { _id: entry.documentId },
      { $set: { debit: entry.oldValues.debit, credit: entry.oldValues.credit }, $unset: { signRepairRunId: "", signRepairedAt: "" } },
    );
    if (result.matchedCount > 0) restored += 1;
  }
  console.log(JSON.stringify({ mode: "restore", runId, documentsRestored: restored, documentsInBackup: forRun.length }, null, 2));
}

async function main() {
  const { mode, restoreRunId } = parseArgs();
  const { getClient, getMongoDb } = await import("../lib/mongodb.ts");
  await getClient();
  const db = getMongoDb();
  const storeId = Number(process.env.OLSERA_INTERNAL_STORE_ID);

  if (mode === "dry-run") await runDryRun(db, storeId);
  else if (mode === "apply") await runApply(db, storeId);
  else if (mode === "restore") await runRestore(db, restoreRunId);

  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
