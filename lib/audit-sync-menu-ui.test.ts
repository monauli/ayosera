import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const page = here("../app/page.tsx");
const panel = here("../components/private-integration-monitor.tsx");
const route = here("../app/api/private/integration-monitor/route.ts");

test("menu Audit & Sinkronisasi hanya ditambahkan ke sidebar untuk supervisor", () => {
  assert.match(page, /import \{ PrivateIntegrationMonitor \} from "@\/components\/private-integration-monitor";/);
  assert.match(
    page,
    /\.\.\.\(isSupervisor \? \[\{ label: "Audit", display: "Audit & Sinkronisasi", icon: ShieldAlert, module: "" \}\] : \[\]\)/,
  );
});

test("activeNavAllowed mewajibkan isSupervisor untuk nav Audit, sama seperti Pengguna", () => {
  assert.match(page, /activeNav === "Pengguna" \|\| activeNav === "Audit"\s*\n\s*\? isSupervisor/);
});

test("PrivateIntegrationMonitor hanya di-mount saat activeNav Audit dan isSupervisor", () => {
  assert.match(
    page,
    /activeNavAllowed && activeNav === "Audit" && isSupervisor && \(/,
  );
  assert.match(page, /<PrivateIntegrationMonitor \/>/);
});

test("panel tidak lagi diam-diam menghilang saat fetch gagal", () => {
  assert.doesNotMatch(panel, /if \(health === null\) return null;/);
  assert.match(panel, /kind: "unauthenticated"/);
  assert.match(panel, /kind: "forbidden"/);
  assert.match(panel, /kind: "error"/);
  assert.match(panel, /kind: "loading"/);
});

test("pesan 403 sesuai spesifikasi dan tidak membocorkan isi allowlist/user ID", () => {
  assert.match(panel, /Akun supervisor ini belum diizinkan menggunakan Private Integration Tools\./);
  assert.match(panel, /Hubungi pengelola sistem untuk menambahkan user ID ke AYOSERA_PRIVATE_TOOLS_USER_IDS\./);
  assert.doesNotMatch(panel, /allowlist\.(join|map)/);
});

test("GET dan POST /api/private/integration-monitor memanggil requirePrivateToolsUser() di dalam try dan meneruskan Response 401/403 apa adanya", () => {
  assert.match(route, /export async function GET\(\) \{\s*try \{ await requirePrivateToolsUser\(\);/);
  assert.match(route, /export async function POST\(request: Request\) \{\s*try \{\s*const user = await requirePrivateToolsUser\(\);/);
  assert.match(route, /catch \(error\) \{ if \(error instanceof Response\) return error;/);
  assert.match(route, /catch \(error\) \{\s*if \(error instanceof Response\) return error;/);
});

test("fallback error backend generik, tanpa stack trace atau detail internal", () => {
  assert.doesNotMatch(route, /error\.stack/);
  assert.doesNotMatch(route, /String\(error\)/);
  assert.match(route, /"Gagal memuat monitoring integritas\."/);
});
