// AUDIT READ-ONLY — Rekonsiliasi AYO vs Olsera (Milestone 3, Bagian K).
// TIDAK PERNAH menulis ke MongoDB, TIDAK memanggil API Olsera/AYO live,
// TIDAK melakukan sync/backfill. Hanya membaca bookings + olsera_order_items
// lewat lib/reconciliation-court-revenue-source.ts (dryRun, tanpa persist).
//
// Penggunaan:
//   npm run audit:court-revenue-production -- --from=2026-02-01 --to=2026-08-02
import { readFileSync, writeFileSync } from "node:fs";

function loadLocalEnv(): void {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* shell mungkin sudah menyediakan env */
  }
}
loadLocalEnv();

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs(argv: string[]): { from: string; to: string; jsonOutput: string | null } {
  let from = "2026-02-01";
  let to = new Date().toISOString().slice(0, 10);
  let jsonOutput: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--from=")) from = arg.slice("--from=".length);
    else if (arg.startsWith("--to=")) to = arg.slice("--to=".length);
    else if (arg.startsWith("--json=")) jsonOutput = arg.slice("--json=".length);
  }
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) throw new Error("--from/--to wajib format YYYY-MM-DD.");
  return { from, to, jsonOutput };
}

async function main() {
  const { from, to, jsonOutput } = parseArgs(process.argv.slice(2));
  console.log(`[audit:court-revenue] Rentang: ${from}..${to} (READ-ONLY, tidak ada tulis Mongo/API live)`);

  const { loadCourtRevenueFindings } = await import("../lib/reconciliation-court-revenue-source.ts");
  const { attachRootCause, buildDailyRollups, buildMonthlyRollup, summarizeRootCauses } = await import("../lib/reconciliation-court-revenue-aggregate.ts");

  const { findings: rawFindings, docsRead } = await loadCourtRevenueFindings(from, to);
  const findings = attachRootCause(rawFindings);
  const daily = buildDailyRollups(findings);
  const monthly = buildMonthlyRollup(`${from}..${to}`, findings, new Date());
  const rootCauses = summarizeRootCauses(`${from}..${to}`, findings);

  console.log(`\ndocsRead (bookings+order_items): ${docsRead}`);
  console.log(`Total finding (tanggal x court): ${findings.length}`);
  console.log(`\n=== LEVEL 1 — BULANAN (agregat seluruh rentang) ===`);
  console.log(`Total AYO    : Rp${monthly.ayoRevenue.toLocaleString("id-ID")}`);
  console.log(`Total Olsera : Rp${monthly.olseraRevenue.toLocaleString("id-ID")}`);
  console.log(`Selisih      : Rp${monthly.difference.toLocaleString("id-ID")} (${monthly.differencePercent === null ? "-" : monthly.differencePercent.toFixed(2) + "%"})`);
  console.log(`MATCH/MINOR  : ${monthly.matchCount}`);
  console.log(`MISMATCH     : ${monthly.mismatchCount}`);
  console.log(`Butuh Manual : ${monthly.manualReviewCount}`);
  console.log(`Status       : ${monthly.status}`);

  const byMonth = new Map<string, typeof findings>();
  for (const f of findings) {
    const m = f.date.slice(0, 7);
    const list = byMonth.get(m) ?? [];
    list.push(f);
    byMonth.set(m, list);
  }
  console.log(`\n=== LEVEL 1 — PER BULAN ===`);
  for (const [month, group] of [...byMonth.entries()].sort()) {
    const r = buildMonthlyRollup(month, group, new Date());
    console.log(`${month}: AYO=Rp${r.ayoRevenue.toLocaleString("id-ID")} Olsera=Rp${r.olseraRevenue.toLocaleString("id-ID")} Selisih=Rp${r.difference.toLocaleString("id-ID")} Status=${r.status} MISMATCH=${r.mismatchCount} ManualReview=${r.manualReviewCount}`);
  }

  const matchDays = daily.filter((d) => d.status === "MATCH" || d.status === "MINOR_DIFFERENCE").slice(0, 5);
  const mismatchDays = daily.filter((d) => d.status === "MISMATCH").slice(0, 5);
  console.log(`\n=== SAMPEL HARI MATCH (min. 3 wajib) — ditemukan ${daily.filter((d) => d.status === "MATCH" || d.status === "MINOR_DIFFERENCE").length} ===`);
  for (const d of matchDays) console.log(`${d.date}: AYO=Rp${d.ayoRevenue.toLocaleString("id-ID")} Olsera=Rp${d.olseraRevenue.toLocaleString("id-ID")} status=${d.status}`);
  console.log(`\n=== SAMPEL HARI MISMATCH (min. 3 wajib) — ditemukan ${daily.filter((d) => d.status === "MISMATCH").length} ===`);
  for (const d of mismatchDays) console.log(`${d.date}: AYO=Rp${d.ayoRevenue.toLocaleString("id-ID")} Olsera=Rp${d.olseraRevenue.toLocaleString("id-ID")} selisih=Rp${d.difference.toLocaleString("id-ID")}`);

  const courtKeys = new Set(findings.map((f) => f.courtKey));
  console.log(`\n=== COURT TERCAKUP (min. 2 wajib) — ${courtKeys.size} court: ${[...courtKeys].join(", ")} ===`);

  console.log(`\n=== ROOT CAUSE SUMMARY ===`);
  for (const rc of rootCauses) console.log(`${rc.label} [${rc.confidence}]: ${rc.caseCount} kasus, total selisih absolut Rp${rc.totalAbsDifference.toLocaleString("id-ID")}`);

  const multiSlotCandidates = findings.filter((f) => Number(f.sourceRefs.ayoBookingCount) > 1);
  console.log(`\n=== KASUS MULTI-SLOT (AYO bookingCount > 1 pada satu court+tanggal) — ${multiSlotCandidates.length} ditemukan ===`);
  for (const f of multiSlotCandidates.slice(0, 3)) console.log(`${f.date} ${f.courtKey}: ayoBookingCount=${f.sourceRefs.ayoBookingCount} olseraOrderCount=${f.sourceRefs.olseraOrderCount} status=${f.status}`);

  console.log(`\n=== BUTUH ADJUST MANUAL (contoh) ===`);
  for (const f of findings.filter((f) => f.status === "BUTUH_ADJUST_MANUAL").slice(0, 5)) {
    console.log(`${f.date} ${f.courtKey}: olseraRevenue=Rp${f.olseraRevenue.toLocaleString("id-ID")} rootCause=${f.rootCause?.label ?? "-"}`);
  }

  if (jsonOutput) {
    writeFileSync(jsonOutput, JSON.stringify({ from, to, docsRead, monthly, daily, rootCauses, courtKeys: [...courtKeys] }, null, 2));
    console.log(`\nJSON detail ditulis ke ${jsonOutput}`);
  }

  console.log(`\n[audit:court-revenue] SELESAI — read-only, tidak ada perubahan data.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[audit:court-revenue] GAGAL:", error instanceof Error ? error.message : error);
  process.exit(1);
});
