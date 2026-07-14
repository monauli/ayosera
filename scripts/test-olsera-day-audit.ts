// Validasi end-to-end audit sync satu tanggal (default: kasus 2026-07-13).
// Membandingkan API Olsera vs MongoDB, menarik ulang bila belum lengkap,
// lalu memverifikasi hasilnya tersimpan. Tidak ada angka hardcode.
//
// Pakai: node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/test-olsera-day-audit.ts [YYYY-MM-DD]
import { existsSync, readFileSync } from "fs";
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

const { auditAndSyncOlseraDay } = await import("../lib/olsera-sync.ts");
const { collections, withMongo, mongoClient } = await import("../lib/mongodb.ts");

const DATE = process.argv[2] ?? "2026-07-13";

async function snapshot() {
  return withMongo(async () => {
    const { olseraOrderItems, olseraSalesByCategory, olseraSyncedDays } = await collections();
    const [orderNos, categories, marked] = await Promise.all([
      olseraOrderItems.distinct("orderNo", { date: DATE }),
      olseraSalesByCategory.find({ date: DATE }).toArray(),
      olseraSyncedDays.findOne({ _id: DATE }),
    ]);
    const total = categories.reduce((sum, doc) => sum + doc.totalAmount, 0);
    return { orders: orderNos.length, categories: categories.length, total, marked };
  });
}

const before = await snapshot();
console.log(`Sebelum audit ${DATE}: ${before.orders} order tersimpan, ${before.categories} kategori, total ${before.total}`);
console.log(`  Catatan synced_days: ${before.marked ? `expectedOrderCount=${before.marked.expectedOrderCount}` : "(belum ada)"}`);

const started = Date.now();
const result = await auditAndSyncOlseraDay(DATE);
console.log(`\nHasil audit: action=${result.action}`);
console.log(`  expectedOrderCount=${result.expectedOrderCount}, processedOrderCount=${result.processedOrderCount}`);
console.log(`  reason=${result.reason ?? "-"}`);
if (result.errorMessage) console.log(`  errorMessage=${result.errorMessage}`);
console.log(`  durasi ${Math.round((Date.now() - started) / 1000)} detik`);

const after = await snapshot();
console.log(`\nSesudah audit ${DATE}: ${after.orders} order tersimpan, ${after.categories} kategori, total ${after.total}`);

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

check("audit tidak berstatus failed", result.action !== "failed");
check(
  "jumlah order MongoDB == jumlah order Olsera",
  result.expectedOrderCount === 0 ? after.orders === 0 : after.orders === result.expectedOrderCount,
);
check("Olsera punya transaksi → MongoDB tidak kosong", result.expectedOrderCount === 0 || after.orders > 0);

// Idempotensi: audit kedua harus "match" tanpa menarik ulang, tanpa mengubah data.
const second = await auditAndSyncOlseraDay(DATE);
const afterSecond = await snapshot();
check("audit kedua langsung match (tidak resync ulang)", second.action === "match");
check(
  "audit kedua tidak mengubah data (tanpa duplikat)",
  afterSecond.orders === after.orders && afterSecond.total === after.total,
);

await mongoClient.close().catch(() => undefined);
console.log(failures ? `\n${failures} check GAGAL` : "\nSemua check PASS");
process.exit(failures ? 1 : 0);
