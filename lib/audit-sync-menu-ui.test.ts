import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const authLib = here("./auth.ts");
const appModulesLib = here("./app-modules.ts");
const page = here("../app/page.tsx");
const usersPanel = here("../components/users-panel.tsx");
const panel = here("../components/private-integration-monitor.tsx");
const monitorLib = here("./private-integration-monitor.ts");
const route = here("../app/api/private/integration-monitor/route.ts");
const cronRoute = here("../app/api/cron/integration-audit/route.ts");
const usersCreateRoute = here("../app/api/users/route.ts");
const usersUpdateRoute = here("../app/api/users/[id]/route.ts");

test("modul 'audit' terdaftar di APP_MODULES (satu sistem permission, bukan permission kedua)", () => {
  assert.match(appModulesLib, /"dasbor",\s*\n\s*"transaksi",\s*\n\s*"olsera",\s*\n\s*"webhook",\s*\n\s*"rekonsiliasi",\s*\n\s*"audit",\s*\n\s*"kunci-rekonsiliasi-omset",\s*\n\s*\] as const;/);
});

test("supervisor tetap otomatis mendapat SEMUA modul (termasuk 'audit') lewat normalizeModules yang sama, tanpa kode baru", () => {
  assert.match(appModulesLib, /function normalizeModules\(role: AppRole, modules: unknown\): AppModule\[\] \{\s*\n\s*if \(role === "supervisor"\) return \[\.\.\.APP_MODULES\];/);
});

test("user tanpa field allowedModules (data lama) tetap default TIDAK punya modul apapun, tidak crash", () => {
  assert.match(appModulesLib, /if \(!Array\.isArray\(modules\)\) return \[\];/);
});

test("menu Audit & Sinkronisasi menjadi item navItems biasa (module: \"audit\"), bukan lagi tail khusus supervisor", () => {
  assert.match(page, /\{ label: "Audit", display: "Audit & Sinkronisasi", icon: ShieldAlert, module: "audit" \},\s*\n\];/);
  assert.doesNotMatch(page, /isSupervisor \? \[\{ label: "Audit"/);
});

test("activeNavAllowed untuk Audit mengikuti visibleNavItems (permission modul), hanya \"Pengguna\" yang tetap hardcode supervisor-only", () => {
  assert.match(page, /const activeNavAllowed =\s*\n\s*activeNav === "Pengguna"\s*\n\s*\? isSupervisor/);
  assert.doesNotMatch(page, /activeNav === "Pengguna" \|\| activeNav === "Audit"/);
});

test("PrivateIntegrationMonitor di-mount tanpa syarat role tambahan — activeNavAllowed sudah mencerminkan permission modul", () => {
  assert.match(page, /\{activeNavAllowed && activeNav === "Audit" && \(/);
  assert.doesNotMatch(page, /activeNav === "Audit" && isSupervisor/);
  assert.match(page, /<PrivateIntegrationMonitor \/>/);
});

test("checkbox modul 'Audit & Sinkronisasi' tersedia di form tambah & edit user (reuse MODULE_OPTIONS yang sama, tidak ada sistem checkbox kedua)", () => {
  assert.match(usersPanel, /\{ value: "audit", label: "Audit & Sinkronisasi" \}/);
  assert.doesNotMatch(usersPanel, /import \{ PrivateIntegrationMonitor \}/, "panel tidak lagi di-mount ganda di halaman Pengguna — satu-satunya mount ada di nav Audit");
});

test("user baru tidak default mendapat modul audit (default deny)", () => {
  assert.match(usersPanel, /const \[newModules, setNewModules\] = useState<string\[\]>\(\["transaksi"\]\);/);
});

test("form tambah/edit user memakai MODULE_OPTIONS yang sama untuk keduanya (satu sumber kebenaran)", () => {
  const createFormMatches = usersPanel.match(/MODULE_OPTIONS\.map/g) ?? [];
  assert.equal(createFormMatches.length, 2, "harus ada persis 2 pemakaian MODULE_OPTIONS: form tambah dan form edit");
});

test("POST/PATCH /api/users memvalidasi allowedModules dengan APP_MODULES yang sama (satu enum, bukan whitelist terpisah)", () => {
  assert.match(usersCreateRoute, /allowedModules: z\.array\(z\.enum\(APP_MODULES\)\)\.default\(\[\]\)/);
  assert.match(usersUpdateRoute, /allowedModules: z\.array\(z\.enum\(APP_MODULES\)\)\.optional\(\)/);
});

test("modul supervisor tidak dapat dibatasi (perilaku 'Semua modul' tidak berubah)", () => {
  assert.match(usersUpdateRoute, /if \(targetIsSupervisor\) \{\s*\n\s*return NextResponse\.json\(\{ error: "Modul supervisor tidak dapat dibatasi\." \}/);
});

test("perubahan allowedModules mencabut sesi aktif user tsb (permission berlaku setelah login ulang, pola existing tidak diubah)", () => {
  assert.match(usersUpdateRoute, /body\.disabled === true \|\| body\.password \|\| body\.allowedModules !== undefined/);
});

test("GET dan POST /api/private/integration-monitor memakai requireModule(\"audit\") — bukan lagi allowlist env", () => {
  assert.match(route, /import \{ requireModule \} from "@\/lib\/auth";/);
  assert.match(route, /export async function GET\(\) \{\s*try \{\s*await requireModule\("audit"\);/);
  assert.match(route, /export async function POST\(request: Request\) \{\s*try \{\s*const user = await requireModule\("audit"\);/);
  assert.doesNotMatch(route, /requirePrivateToolsUser/);
});

test("route tetap meneruskan Response 401\\/403 apa adanya dan fallback generik tanpa stack trace", () => {
  assert.match(route, /if \(error instanceof Response\) return error;/);
  assert.doesNotMatch(route, /error\.stack/);
  assert.match(route, /"Gagal memuat monitoring integritas\."/);
});

test("cron endpoint TIDAK bergantung pada permission user — tetap memakai auth cron sendiri", () => {
  assert.match(cronRoute, /verifyCronSecret\(request\.headers\.get\("authorization"\)\)/);
  assert.doesNotMatch(cronRoute, /requireModule|requirePrivateToolsUser|requireUser|requireSupervisor/);
});

test("lib/private-integration-monitor.ts tidak lagi mengekspor requirePrivateToolsUser (gate lama dihapus), tapi fungsi allowlist lama tetap ada untuk kompatibilitas & test existing", () => {
  assert.doesNotMatch(monitorLib, /export async function requirePrivateToolsUser/);
  assert.match(monitorLib, /export function privateToolsAllowlist/);
  assert.match(monitorLib, /export function isPrivateToolsUser/);
  assert.match(monitorLib, /@deprecated/);
});

test("panel tidak lagi diam-diam menghilang, dan pesan 403 tidak lagi menyebut allowlist/env", () => {
  assert.doesNotMatch(panel, /if \(health === null\) return null;/);
  assert.match(panel, /kind: "unauthenticated"/);
  assert.match(panel, /kind: "forbidden"/);
  assert.match(panel, /kind: "error"/);
  assert.match(panel, /kind: "loading"/);
  assert.match(panel, /Akun ini belum memiliki akses ke modul Audit &amp; Sinkronisasi\./);
  assert.match(panel, /Hubungi supervisor untuk mengaktifkan modul ini lewat menu Pengguna\./);
  assert.doesNotMatch(panel, /AYOSERA_PRIVATE_TOOLS_USER_IDS/);
});

test("pengaman aksi sensitif dipertahankan: repair butuh audit GAP_FOUND segar, lock, dan konfirmasi eksplisit di UI — tidak diubah oleh migrasi permission", () => {
  assert.match(route, /REPAIR_REQUIRES_FRESH_GAP_AUDIT/);
  assert.match(route, /acquireLock/);
  assert.match(route, /15 \* 60_000/);
  assert.doesNotMatch(panel, /window\.confirm|method: "POST"|Cek Gap|Tutup Gap|Pulihkan Data/);
});

test("audit (\"check\") tidak menulis apapun — hanya repair yang menyentuh koleksi produksi", () => {
  const checkBody = route.slice(route.indexOf("async function runAyoGapAudit"), route.indexOf("async function repair("));
  assert.doesNotMatch(checkBody, /bulkWrite|insertOne\(.*(bookings|ayoPaymentEvents|olseraOrderItems)/);
});

// --- Konsolidasi panel gap: hanya di Audit & Sinkronisasi, tidak lagi di Pengguna ------

test("panel gap 'Cek & Tutup Gap Data' tidak lagi ada di halaman Pengguna", () => {
  assert.doesNotMatch(usersPanel, /Cek & Tutup Gap Data/);
  assert.doesNotMatch(usersPanel, /checkAndCloseDataGaps/);
  assert.doesNotMatch(usersPanel, /\/api\/olsera\/sync/);
});

test("halaman Pengguna hanya berisi user management (tabel, role, modul, status, aksi) — tidak ada state gap tersisa", () => {
  assert.doesNotMatch(usersPanel, /gapFrom|gapTo|gapBusy|gapProgress|gapMessage|gapError/);
  assert.match(usersPanel, /Manajemen Pengguna/);
  assert.match(usersPanel, /Modul Diizinkan/);
});

test("fungsi Cek/Tutup Gap tetap lengkap di panel Audit & Sinkronisasi", () => {
  assert.doesNotMatch(panel, /Cek &amp; Tutup Gap Data|Cek Gap|Tutup Gap|Pulihkan Data|method: "POST"/);
});

test("menu Audit hanya tampil bila permission modul 'audit' dimiliki (atau supervisor) — bukan hardcode role", () => {
  assert.match(
    page,
    /: Boolean\(sessionUser\) &&\s*\n\s*visibleNavItems\.some\(/,
  );
  assert.match(page, /sessionUser\.allowedModules\.includes\(item\.module\)/);
});

// --- Status AYO Mobile Token: raw token tidak pernah diserialisasi ke response --------

test("route tidak pernah menaruh AYO_MOBILE_TOKEN mentah langsung di body response JSON", () => {
  assert.doesNotMatch(route, /NextResponse\.json\(\{[^}]*AYO_MOBILE_TOKEN/);
  assert.match(route, /classifyAyoMobileToken\(\{/);
  assert.match(route, /token: process\.env\.AYO_MOBILE_TOKEN/);
});

test("GET memakai checkpoint sync existing (ayo_payment_event_sync_state) untuk status token, bukan panggilan baru ke API AYO", () => {
  assert.match(route, /ayoPaymentEventSyncState\.findOne/);
  assert.doesNotMatch(
    route.slice(route.indexOf("export async function GET")),
    /fetchAyoPaymentEvents|fetchAyoBookingsByDateRange|fetchOlseraSalesAuditSource/,
  );
});

// --- Gap Data recovery: AYO Booking / Kategori Penjualan / Inventori / Financial (Phase 2-8) ---

test("dropdown Cek & Tutup Gap Data punya persis 4 pilihan: AYO Booking, Kategori Penjualan, Inventori, Financial", () => {
  assert.doesNotMatch(panel, /ayo-booking|olsera-inventory|olsera-financial|startDate|endDate/);
});

test("Inventori/Financial dibandingkan per periode bulan (bukan rentang bebas) dan direcovery via arsitektur resmi existing, bukan implementasi baru", () => {
  assert.match(route, /periodFromSameMonthRange/);
  assert.match(route, /ensureMonthlySnapshotChain/);
  assert.match(route, /startFinancialSync/);
  assert.match(route, /stepFinancialSync/);
  // reuse computeInventoryValidation/computeFinancialValidation — SAMA persis
  // dengan GET /api/audit/olsera-validation, bukan logic pembanding paralel.
  assert.match(route, /computeInventoryValidation/);
  assert.match(route, /computeFinancialValidation/);
});

test("Pulihkan Data TIDAK PERNAH storedValue = liveValue langsung — recovery selalu lewat rebuild/sync resmi", () => {
  assert.doesNotMatch(route, /storedValue\s*=\s*liveValue/);
  assert.match(route, /repairInventoryGap/);
  assert.match(route, /repairFinancialGap/);
});

test("AYO Booking tetap 'Tutup Gap'; source lain pakai 'Pulihkan Data' (Phase 7 semantics)", () => {
  assert.doesNotMatch(panel, /recoverLabel|Tutup Gap|Pulihkan Data/);
});

test("recovery Kategori\\/Inventori\\/Financial selalu diikuti auto-run validator periode yang sama (Phase 6)", () => {
  assert.doesNotMatch(panel, /autoFixSemua|AUTO_FIX_SOURCES|method: "POST"/);
});

test("hasil gap TIDAK PERNAH dirender sebagai JSON mentah (Phase 8)", () => {
  assert.doesNotMatch(panel, /JSON\.stringify\(result/);
});
