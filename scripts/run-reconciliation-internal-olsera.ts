// Entrypoint INTERNAL (bukan route publik, bukan cron) untuk Runner Modul
// Rekonsiliasi Phase 5B — HANYA reconciliationType INTERNAL_OLSERA, domain
// CATEGORY/PRODUCT/INVENTORY/SNAPSHOT. Default WAJIB dry-run: tanpa --write,
// script ini TIDAK PERNAH menulis ke MongoDB.
//
// Contoh (dry-run, default) via npm script (lihat package.json "reconciliation:internal"):
//   npm run reconciliation:internal -- --period=2026-05 --domains=CATEGORY,PRODUCT,INVENTORY,SNAPSHOT --dry-run
// atau langsung tanpa npm:
//   npx tsx --conditions=react-server scripts/run-reconciliation-internal-olsera.ts --period=2026-05
//
// Mode tulis (JANGAN dijalankan tanpa verifikasi dry-run terlebih dahulu):
//   ALLOW_RECONCILIATION_WRITE=1 npm run reconciliation:internal -- --period=2026-05 --write
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

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
// PENTING: harus dimuat SEBELUM import lib/mongodb.ts (yang membaca
// process.env.MONGODB_URI di top-level module) — lihat pola sama di
// scripts/audit-order-item-identity-2026.ts. Dynamic import ditunda ke dalam
// main() (bukan top-level await) supaya kompatibel dengan tsx tanpa
// package.json "type":"module".
loadLocalEnv();

type Args = {
  period: string | null;
  domains: string[];
  dryRun: boolean;
  storeId: number | null;
  jsonOutput: string | null;
  write: boolean;
};

function parseArgs(argv: string[], defaultDomains: readonly string[]): Args {
  let period: string | null = null;
  let domains: string[] = [...defaultDomains];
  let write = false;
  let storeId: number | null = null;
  let jsonOutput: string | null = null;

  for (const arg of argv) {
    if (arg.startsWith("--period=")) period = arg.slice("--period=".length);
    else if (arg.startsWith("--domains=")) domains = arg.slice("--domains=".length).split(",").map((d) => d.trim()).filter(Boolean);
    else if (arg === "--write") write = true;
    else if (arg === "--dry-run") write = false;
    else if (arg.startsWith("--store-id=")) storeId = Number(arg.slice("--store-id=".length));
    else if (arg.startsWith("--json-output=")) jsonOutput = arg.slice("--json-output=".length);
  }

  return { period, domains, dryRun: !write, storeId, jsonOutput, write };
}

/**
 * Guard mode tulis — WAJIB flag --write EKSPLISIT (bukan default), DAN env
 * ALLOW_RECONCILIATION_WRITE=1 (guard tambahan, terpisah dari flag CLI supaya
 * tidak bisa dijalankan tak sengaja oleh siapa pun yang menyalin command).
 * Bila NODE_ENV=production, WAJIB satu guard tambahan lagi
 * (ALLOW_RECONCILIATION_WRITE_PRODUCTION=1) — mencegah mode tulis dijalankan
 * di production tanpa keputusan eksplisit terpisah.
 */
function assertWriteAllowed(write: boolean): void {
  if (!write) return;
  if (process.env.ALLOW_RECONCILIATION_WRITE !== "1") {
    throw new Error(
      'Mode --write ditolak: set environment variable ALLOW_RECONCILIATION_WRITE=1 secara eksplisit setelah dry-run diverifikasi. Ini BUKAN default — jangan diaktifkan tanpa alasan jelas.',
    );
  }
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_RECONCILIATION_WRITE_PRODUCTION !== "1") {
    throw new Error(
      "Mode --write ditolak di NODE_ENV=production: butuh guard tambahan ALLOW_RECONCILIATION_WRITE_PRODUCTION=1 secara eksplisit.",
    );
  }
}

const HELP_TEXT = `Runner internal Modul Rekonsiliasi (Phase 5B) — HANYA reconciliationType INTERNAL_OLSERA, domain CATEGORY/PRODUCT/INVENTORY/SNAPSHOT.

Penggunaan (via npm script):
  npm run reconciliation:internal -- --period=YYYY-MM [opsi lain]

Contoh dry-run (default, AMAN, tidak menulis MongoDB):
  npm run reconciliation:internal -- --period=2026-05 --domains=CATEGORY,PRODUCT,INVENTORY,SNAPSHOT --dry-run

Opsi:
  --period=YYYY-MM       WAJIB. Periode bulanan yang direkonsiliasi.
  --domains=A,B,C         Default: CATEGORY,PRODUCT,INVENTORY,SNAPSHOT (domain lain ditolak).
  --dry-run               Default. Hanya baca + evaluasi, TIDAK menulis MongoDB.
  --write                 Mode tulis. WAJIB juga env ALLOW_RECONCILIATION_WRITE=1
                          (dan ALLOW_RECONCILIATION_WRITE_PRODUCTION=1 bila NODE_ENV=production).
  --store-id=<id>         Override storeId (default: env OLSERA_INTERNAL_STORE_ID).
  --json-output=<path>    Simpan hasil lengkap sebagai JSON ke path ini.
  --help                  Tampilkan bantuan ini dan keluar (tidak membaca env/MongoDB).
`;

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }

  const { runReconciliation, PHASE_5B_DOMAINS, isPhase5BDomain } = await import("../lib/reconciliation-runner.ts");
  const args = parseArgs(rawArgs, PHASE_5B_DOMAINS);

  if (!args.period) throw new Error("--period=YYYY-MM wajib diisi. Jalankan dengan --help untuk bantuan.");
  for (const d of args.domains) {
    if (!isPhase5BDomain(d)) throw new Error(`Domain "${d}" ditolak — Phase 5B hanya menerima ${PHASE_5B_DOMAINS.join(", ")}.`);
  }

  assertWriteAllowed(args.write);

  const storeIdEnv = process.env.OLSERA_INTERNAL_STORE_ID ? Number(process.env.OLSERA_INTERNAL_STORE_ID) : null;
  const storeId = args.storeId ?? storeIdEnv;
  if (!storeId || !Number.isInteger(storeId) || storeId <= 0) {
    throw new Error("storeId tidak valid — set OLSERA_INTERNAL_STORE_ID di env atau --store-id=<id integer positif>.");
  }

  console.log(`[reconciliation] period=${args.period} domains=${args.domains.join(",")} dryRun=${args.dryRun} storeId=${storeId}`);
  if (!args.dryRun) console.warn("[reconciliation] MODE TULIS AKTIF — akan menulis reconciliation_runs/reconciliation_findings.");

  const result = await runReconciliation({
    storeId,
    period: args.period,
    reconciliationType: "INTERNAL_OLSERA",
    // sudah divalidasi di atas — cast aman karena setiap elemen sudah melewati isPhase5BDomain.
    domains: args.domains as (typeof PHASE_5B_DOMAINS)[number][],
    dryRun: args.dryRun,
    triggeredBy: `cli:run-reconciliation-internal-olsera${args.write ? ":write" : ":dry-run"}`,
    runVersion: 1,
  });

  console.log(`[reconciliation] status=${result.status} totalFindings=${result.summary.totalFindings} durationMs=${result.durationMs} docsRead=${result.docsRead}`);
  console.log(`[reconciliation] byStatus=${JSON.stringify(result.summary.byStatus)}`);
  console.log(`[reconciliation] impactSummary=${JSON.stringify(result.summary.impactSummary)} highestImpact=${result.summary.highestImpact}`);
  console.log(`[reconciliation] confidenceSummary=${JSON.stringify(result.summary.confidenceSummary)} overallConfidence=${result.summary.overallConfidence}`);
  if (Object.keys(result.domainErrors).length > 0) console.warn(`[reconciliation] domainErrors=${JSON.stringify(result.domainErrors)}`);

  if (args.jsonOutput) {
    mkdirSync(path.dirname(args.jsonOutput), { recursive: true });
    writeFileSync(args.jsonOutput, JSON.stringify(result, null, 2));
    console.log(`[reconciliation] output ditulis ke ${args.jsonOutput}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[reconciliation] gagal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
