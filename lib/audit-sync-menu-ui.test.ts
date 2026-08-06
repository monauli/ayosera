import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const authLib = here("./auth.ts");
const page = here("../app/page.tsx");
const usersPanel = here("../components/users-panel.tsx");
const panel = here("../components/private-integration-monitor.tsx");
const monitorLib = here("./private-integration-monitor.ts");
const route = here("../app/api/private/integration-monitor/route.ts");
const cronRoute = here("../app/api/cron/integration-audit/route.ts");
const usersCreateRoute = here("../app/api/users/route.ts");
const usersUpdateRoute = here("../app/api/users/[id]/route.ts");

test("modul 'audit' terdaftar di APP_MODULES (satu sistem permission, bukan permission kedua)", () => {
  assert.match(authLib, /export const APP_MODULES = \["dasbor", "transaksi", "olsera", "webhook", "rekonsiliasi", "audit"\] as const;/);
});

test("supervisor tetap otomatis mendapat SEMUA modul (termasuk 'audit') lewat normalizeModules yang sama, tanpa kode baru", () => {
  assert.match(authLib, /function normalizeModules\(role: AppRole, modules: unknown\): AppModule\[\] \{\s*\n\s*if \(role === "supervisor"\) return \[\.\.\.APP_MODULES\];/);
});

test("user tanpa field allowedModules (data lama) tetap default TIDAK punya modul apapun, tidak crash", () => {
  assert.match(authLib, /if \(!Array\.isArray\(modules\)\) return \[\];/);
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
  assert.match(route, /export async function GET\(\) \{\s*try \{ await requireModule\("audit"\);/);
  assert.match(route, /export async function POST\(request: Request\) \{\s*try \{\s*const user = await requireModule\("audit"\);/);
  assert.doesNotMatch(route, /requirePrivateToolsUser/);
});

test("route tetap meneruskan Response 401\\/403 apa adanya dan fallback generik tanpa stack trace", () => {
  assert.match(route, /catch \(error\) \{ if \(error instanceof Response\) return error;/);
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
  assert.match(panel, /window\.confirm\(message\)/);
  assert.match(panel, /Data existing tidak akan dihapus atau ditimpa\./);
});

test("audit (\"check\") tidak menulis apapun — hanya repair yang menyentuh koleksi produksi", () => {
  const checkBody = route.slice(route.indexOf("async function runAyoGapAudit"), route.indexOf("async function repair("));
  assert.doesNotMatch(checkBody, /bulkWrite|insertOne\(.*(bookings|ayoPaymentEvents|olseraOrderItems)/);
});
