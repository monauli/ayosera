import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const page = here("../app/reconciliation/page.tsx");
const model = here("../app/api/reconciliation/findings-ui/route.ts");

test("halaman UI rekonsiliasi memiliki filter URL, pagination, state loading/error/empty dan mobile list", () => {
  assert.match(page, /useSearchParams/); assert.match(page, /router\.replace/); assert.match(page, /recon-pagination/);
  assert.match(page, /recon-skeleton/); assert.match(page, /Tidak ada finding/); assert.match(page, /recon-mobile-list/);
});
test("viewer tidak mendapat aksi tulis, supervisor mendapat form resolution dan revoke", () => {
  assert.match(page, /const supervisor = user\?\.role === "supervisor"/); assert.match(page, /\{supervisor &&/); assert.match(page, /Ganti keputusan/); assert.match(page, />Revoke</);
});
test("form memvalidasi OTHER/RESOLVED, mencegah double submit, memakai Idempotency-Key dan menangani 409", () => {
  assert.match(page, /reasonCode === "OTHER"/); assert.match(page, /decision === "RESOLVED"/); assert.match(page, /submittingRef\.current/);
  assert.match(page, /"Idempotency-Key"/); assert.match(page, /response\.status === 409/);
});
test("UI menampilkan current month, warning product ambiguity, status backend, history, tanpa aksi alias/rebuild", () => {
  assert.match(page, /Bulan Berjalan \/ Belum Final/); assert.match(page, /106817649/); assert.match(page, /tidak akan membuat alias produk/);
  assert.match(page, /detail\.effectiveStatus/); assert.match(page, /History resolution/); assert.doesNotMatch(page, /Buat Alias|Rebuild Snapshot|Pindahkan Histori/);
});
test("read model menjalankan filter, pagination, priority impact dan aggregate di MongoDB", () => {
  assert.match(model, /requireModule\("rekonsiliasi"\)/); assert.match(model, /\$facet/); assert.match(model, /\$lookup/);
  assert.match(model, /impactRank: 1, updatedAt: -1/); assert.match(model, /\$skip/); assert.match(model, /escapeRegex/);
});
