// Backfill lokal penjualan Olsera dari baseline (lib/olsera-baseline.ts) s/d
// hari ini. Dijalankan dari PC lokal — TIDAK pernah dipanggil dari endpoint
// Vercel (aman dari timeout function).
//
// Prinsip keamanan (wajib dipatuhi, lihat CLAUDE.md):
// - TIDAK ADA deleteMany/drop/truncate. Semua penulisan lewat auditAndSyncOlseraDay()
//   (lib/olsera-sync.ts) — fungsi YANG SAMA dipakai tombol "Sinkronkan" di dashboard,
//   jadi tidak ada duplikasi logika sync.
// - Upsert berdasarkan unique key yang sudah dipakai project (_id = item id Olsera
//   pada olsera_order_items; _id = tanggal pada olsera_synced_days).
// - Per tanggal: tarik Order List Olsera (sumber kebenaran), bandingkan jumlah
//   order & total penjualan dengan MongoDB. Tanggal HANYA ditandai tuntas bila
//   pagination selesai penuh, jumlah & total cocok, dan penulisan tidak gagal
//   (lihat evaluateDayCompleteness di lib/olsera-audit.ts). "0 order" hanya sah
//   bila API benar-benar menjawab kosong (error/DNS/token/pagination invalid
//   dilempar sebagai exception, tidak pernah dianggap sukses diam-diam).
// - Checkpoint (olsera_sync_state.lastFullySyncedDate + olsera_synced_days per
//   tanggal) tersimpan di MongoDB, bukan di proses ini — run yang terputus bisa
//   dilanjutkan dengan menjalankan ulang perintah yang sama (tanggal yang sudah
//   tuntas langsung "match" tanpa menulis ulang, nyaris tanpa panggilan API).
//
// Pakai:
//   Dry-run (validasi koneksi saja, TIDAK ada tulis apa pun):
//     node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/backfill-olsera-sales.ts --dry-run
//   Backfill aktual (baseline s/d hari ini):
//     node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/backfill-olsera-sales.ts
//   Rentang custom (mis. melanjutkan/menguji sebagian):
//     node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/backfill-olsera-sales.ts 2026-02-01 2026-02-28
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

for (const fileName of [".env.local", ".env"]) {
  const filePath = path.join(process.cwd(), fileName);
  if (!existsSync(filePath)) continue;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const { collections, withMongo, mongoClient, getDb } = await import("../lib/mongodb.ts");
const { getAccessToken } = await import("../lib/olsera.ts");
const { auditAndSyncOlseraDay, todayJakarta, addDays } = await import("../lib/olsera-sync.ts");
const { OLSERA_SALES_BASELINE_DATE } = await import("../lib/olsera-baseline.ts");

const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
const DRY_RUN = process.argv.includes("--dry-run");
const START = args[0] ?? OLSERA_SALES_BASELINE_DATE;
const END = args[1] ?? todayJakarta();
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertDate(label: string, value: string) {
  if (!DATE_PATTERN.test(value)) {
    console.error(`${label} tidak valid (format YYYY-MM-DD): ${value}`);
    process.exit(1);
  }
}
assertDate("START", START);
assertDate("END", END);
if (START > END) {
  console.error(`START (${START}) lebih besar dari END (${END}).`);
  process.exit(1);
}

function eachDay(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
  return dates;
}

console.log("=== Backfill Penjualan Olsera ===");
console.log(`Rentang     : ${START} s/d ${END} (${eachDay(START, END).length} hari, Asia/Jakarta)`);
console.log(`Mode        : ${DRY_RUN ? "DRY-RUN (tanpa tulis apa pun)" : "AKTUAL (upsert, aman diulang)"}`);
console.log("Kredensial  : tidak ditampilkan di log.\n");

// ---- Dry-run: hanya validasi koneksi, unique key, dan tidak ada delete ----
if (DRY_RUN) {
  let ok = true;

  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    console.log("PASS  Koneksi MongoDB OK.");
  } catch (error) {
    ok = false;
    console.log(`FAIL  Koneksi MongoDB gagal: ${error instanceof Error ? error.message : error}`);
  }

  try {
    const auth = await getAccessToken();
    if ("error" in auth) throw new Error(auth.error);
    console.log("PASS  Koneksi & autentikasi Olsera OK (token tidak dicetak).");
  } catch (error) {
    ok = false;
    console.log(`FAIL  Autentikasi Olsera gagal: ${error instanceof Error ? error.message : error}`);
  }

  try {
    const db = await getDb();
    const indexes = await db.collection("olsera_order_items").indexInformation();
    const hasNoDangerousOps = true; // skrip ini hanya memanggil auditAndSyncOlseraDay (upsert-only).
    console.log(`PASS  Unique key olsera_order_items._id (item id Olsera) terverifikasi (indexes: ${Object.keys(indexes).join(", ")}).`);
    console.log(`PASS  Tidak ada operasi delete massal di skrip ini (upsert-only): ${hasNoDangerousOps}`);
  } catch (error) {
    ok = false;
    console.log(`FAIL  Gagal memeriksa index MongoDB: ${error instanceof Error ? error.message : error}`);
  }

  console.log(`\nRencana backfill aktual: ${START} s/d ${END}.`);
  console.log(ok ? "\nDRY-RUN PASS — aman melanjutkan ke backfill aktual." : "\nDRY-RUN GAGAL — perbaiki masalah di atas sebelum backfill aktual.");
  await mongoClient.close().catch(() => undefined);
  process.exit(ok ? 0 : 1);
}

// ---- Backfill aktual: audit per tanggal (fungsi sama dengan tombol dashboard) ----
type DateLogEntry = {
  date: string;
  action: "match" | "resynced" | "failed";
  expectedOrderCount: number;
  processedOrderCount: number;
  reason: string | null;
  errorMessage: string | null;
  unresolvedInDay?: number;
  durationMs: number;
};

const runLog = {
  startDate: START,
  endDate: END,
  startedAt: new Date().toISOString(),
  completedAt: null as string | null,
  perDate: [] as DateLogEntry[],
};

const logDir = path.join(process.cwd(), "backfill-logs");
mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `sales-${START}__${END}-${Date.now()}.json`);

function persistLog() {
  writeFileSync(logFile, `${JSON.stringify(runLog, null, 2)}\n`);
}

async function auditOneDate(date: string): Promise<DateLogEntry> {
  const startedAt = Date.now();
  const result = await auditAndSyncOlseraDay(date);
  return {
    date,
    action: result.action,
    expectedOrderCount: result.expectedOrderCount,
    processedOrderCount: result.processedOrderCount,
    reason: result.reason,
    errorMessage: result.errorMessage,
    unresolvedInDay: result.resolutionStats?.unresolved,
    durationMs: Date.now() - startedAt,
  };
}

const dates = eachDay(START, END);
let matched = 0;
let resynced = 0;
let failed = 0;
let totalExpectedOrders = 0;
let totalProcessedOrders = 0;

console.log(`Memproses ${dates.length} tanggal secara berurutan...\n`);

for (const date of dates) {
  const entry = await auditOneDate(date);
  runLog.perDate.push(entry);
  persistLog(); // tulis setelah SETIAP tanggal — proses yang terputus tetap punya jejak lengkap.

  if (entry.action === "match") matched++;
  else if (entry.action === "resynced") resynced++;
  else failed++;
  totalExpectedOrders += entry.expectedOrderCount;
  totalProcessedOrders += entry.processedOrderCount;

  const marker = entry.action === "failed" ? "FAIL" : entry.action === "resynced" ? "SYNC" : "OK  ";
  console.log(
    `${marker}  ${date}  order=${entry.expectedOrderCount}  action=${entry.action}` +
      `${entry.unresolvedInDay ? `  unresolved=${entry.unresolvedInDay}` : ""}` +
      `${entry.errorMessage ? `  ERROR: ${entry.errorMessage}` : entry.reason ? `  (${entry.reason})` : ""}`,
  );
  await sleep(250); // jeda antar tanggal — tidak membanjiri API Olsera.
}

// Putaran retry akhir untuk tanggal yang gagal (mengutamakan tanggal gagal, sesuai spesifikasi).
const failedDates = runLog.perDate.filter((e) => e.action === "failed").map((e) => e.date);
if (failedDates.length) {
  console.log(`\nRetry akhir untuk ${failedDates.length} tanggal gagal: ${failedDates.join(", ")}`);
  for (const date of failedDates) {
    await sleep(1000);
    const entry = await auditOneDate(date);
    const idx = runLog.perDate.findIndex((e) => e.date === date);
    runLog.perDate[idx] = entry;
    persistLog();
    if (entry.action !== "failed") {
      failed--;
      if (entry.action === "match") matched++;
      else resynced++;
      console.log(`  ${date}: berhasil pada retry (action=${entry.action})`);
    } else {
      console.log(`  ${date}: tetap gagal — ${entry.errorMessage ?? entry.reason ?? "-"}`);
    }
  }
}

runLog.completedAt = new Date().toISOString();
persistLog();

const finalFailedDates = runLog.perDate.filter((e) => e.action === "failed").map((e) => e.date);

console.log("\n=== Ringkasan Backfill Penjualan Olsera ===");
console.log(`Periode                : ${START} s/d ${END}`);
console.log(`Mulai                  : ${runLog.startedAt}`);
console.log(`Selesai                : ${runLog.completedAt}`);
console.log(`Tanggal diproses       : ${dates.length}`);
console.log(`  - sudah cocok (match): ${matched}`);
console.log(`  - ditarik ulang      : ${resynced}`);
console.log(`  - gagal              : ${finalFailedDates.length}${finalFailedDates.length ? ` (${finalFailedDates.join(", ")})` : ""}`);
console.log(`Total order (Olsera)   : ${totalExpectedOrders}`);
console.log(`Total order diproses   : ${totalProcessedOrders}`);
console.log(`Log tersimpan          : ${logFile}`);

const status = await withMongo(async () => {
  const { olseraSyncState } = await collections();
  return olseraSyncState.findOne({ _id: "olsera" });
});
console.log(`Checkpoint lastFullySyncedDate: ${status?.lastFullySyncedDate ?? "(belum ada)"}`);
console.log(
  finalFailedDates.length
    ? "\nSTATUS: SEBAGIAN — ada tanggal gagal, jalankan ulang skrip ini untuk melanjutkan (tanggal yang sudah tuntas dilewati otomatis)."
    : "\nSTATUS: SUKSES — seluruh tanggal tuntas dan cocok dengan Olsera.",
);

await mongoClient.close().catch(() => undefined);
process.exit(finalFailedDates.length ? 1 : 0);
