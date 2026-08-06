/**
 * Audit E2E terautentikasi AYOSERA (Task 5).
 *
 * Membuka seluruh halaman utama lewat browser sungguhan (Chrome terpasang,
 * lewat playwright-core `channel: "chrome"` — TIDAK mengunduh browser sendiri),
 * memeriksa console/uncaught error/response 5xx/CSP violation, desktop+mobile,
 * light+dark, filter & pagination, lalu memvalidasi seluruh export utama
 * (xlsx dibuka ulang dengan ExcelJS, pdf dengan pdf-lib).
 *
 * READ-ONLY: tidak pernah memanggil endpoint sync/backfill/rekonsiliasi write.
 *
 * Pakai:
 *   npm run test:e2e                      (server harus sudah jalan di BASE_URL)
 *   E2E_BASE_URL=https://... npm run test:e2e
 *   E2E_SKIP_EXPORTS=1 npm run test:e2e   (halaman saja)
 *
 * Kredensial dibaca dari .env.local (ADMIN_EMAIL/ADMIN_PASSWORD) atau env
 * proses — tidak pernah di-hardcode dan tidak pernah dicetak ke output.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { chromium, type APIRequestContext, type Browser, type BrowserContext, type Page } from "playwright-core";

for (const fileName of [".env.local", ".env"]) {
  const filePath = path.join(process.cwd(), fileName);
  if (!existsSync(filePath)) continue;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

const BASE_URL = (process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const EMAIL = process.env.E2E_EMAIL || process.env.ADMIN_EMAIL || "";
const PASSWORD = process.env.E2E_PASSWORD || process.env.ADMIN_PASSWORD || "";
const OUT_DIR = process.env.E2E_OUT || path.join(".next", "e2e");
const SKIP_EXPORTS = process.env.E2E_SKIP_EXPORTS === "1";

if (!EMAIL || !PASSWORD) {
  console.error("E2E_EMAIL/E2E_PASSWORD (atau ADMIN_EMAIL/ADMIN_PASSWORD di .env.local) wajib diset.");
  process.exit(2);
}

// ---------------------------------------------------------------- pelaporan

type Result = { area: string; name: string; ok: boolean; skipped?: boolean; detail: string };
const results: Result[] = [];
let currentArea = "setup";

function record(name: string, ok: boolean, detail = "") {
  results.push({ area: currentArea, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${currentArea}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name: string, reason: string) {
  results.push({ area: currentArea, name, ok: true, skipped: true, detail: reason });
  console.log(`SKIP  [${currentArea}] ${name} — ${reason}`);
}

async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    record(name, true, detail || "");
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ------------------------------------------------- pengumpul masalah browser

type PageIssue = { area: string; kind: string; text: string };
const pageIssues: PageIssue[] = [];

// Noise yang bukan masalah aplikasi: pesan info React DevTools & Fast Refresh.
const IGNORED_CONSOLE = [/Download the React DevTools/i, /\[Fast Refresh\]/i];

/**
 * CSP production memuat `upgrade-insecure-requests`. Saat build production diuji
 * lewat http://localhost (tanpa TLS), Next menaikkan permintaan yang dimulai
 * halaman ke https:// dan gagal dengan ERR_SSL_PROTOCOL_ERROR — murni artefak
 * pengujian lokal, tidak mungkin terjadi di production yang memang HTTPS.
 * Hanya diabaikan bila BASE_URL memang http.
 */
const LOCAL_HTTPS_UPGRADE_NOISE = BASE_URL.startsWith("http://") ? /ERR_SSL_PROTOCOL_ERROR/ : null;

function watchPage(page: Page) {
  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    const text = message.text();
    if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
    if (LOCAL_HTTPS_UPGRADE_NOISE?.test(text)) return;
    pageIssues.push({ area: currentArea, kind: `console.${type}`, text });
  });
  page.on("pageerror", (error) => {
    pageIssues.push({ area: currentArea, kind: "uncaught", text: error.message });
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      pageIssues.push({ area: currentArea, kind: `http${response.status()}`, text: response.url() });
    }
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "";
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(failure)) return;
    if (LOCAL_HTTPS_UPGRADE_NOISE?.test(failure)) return;
    pageIssues.push({ area: currentArea, kind: "requestfailed", text: `${request.url()} ${failure}` });
  });
}

/** Masalah yang menggagalkan audit: error console, exception, 5xx, request gagal. */
function issuesFor(area: string) {
  return pageIssues.filter((issue) => issue.area === area && issue.kind !== "console.warning");
}

async function shot(page: Page, name: string) {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true }).catch(() => {});
}

// --------------------------------------------------------- inventaris route

/**
 * Semua route API dari filesystem (app/api/**\/route.ts) — dipakai untuk sapuan
 * anonim supaya tidak ada route yang lolos audit hanya karena tidak muncul di
 * menu. Segmen dinamis `[x]` diganti placeholder.
 */
function listApiRoutes(dir = path.join("app", "api"), prefix = "/api"): { url: string; file: string }[] {
  const routes: { url: string; file: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith("[...")) continue; // catch-all Better Auth — bukan route bisnis
      routes.push(...listApiRoutes(full, `${prefix}/${entry.name.replace(/^\[(.+)\]$/, "e2e-probe")}`));
    } else if (entry.name === "route.ts") {
      routes.push({ url: prefix, file: full.replace(/\\/g, "/") });
    }
  }
  return routes;
}

// Route yang MEMANG tidak memakai sesi user (punya mekanisme sendiri):
// endpoint auth, cron (Bearer CRON_SECRET), dan webhook masuk dari AYO.
const NON_SESSION_ROUTES = [/^\/api\/auth\//, /^\/api\/cron\//, /^\/api\/webhooks\/ayo/];

// ------------------------------------------------------------ util halaman

/**
 * Halaman baru selesai dimuat DAN sudah ter-hydrate. Tanpa ini, klik pertama
 * setelah navigasi bisa mendarat sebelum handler React terpasang dan tidak
 * melakukan apa pun (bukan bug aplikasi — cuma balapan test).
 */
async function waitForAppReady(page: Page) {
  await page.locator("h1").first().waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
}

async function openSidebar(page: Page) {
  const aside = page.locator("aside.rd-sidebar");
  const isOpen = () => aside.evaluate((el) => el.getBoundingClientRect().left >= 0).catch(() => false);
  // Sidebar dianimasikan (transform 300ms) dan state-nya milik React, jadi tunggu
  // posisinya benar-benar masuk viewport, bukan sekadar "visible".
  for (let attempt = 0; attempt < 5 && !(await isOpen()); attempt += 1) {
    await page.getByRole("button", { name: "Buka/tutup navigasi" }).click();
    await page.waitForFunction(() => {
      const el = document.querySelector("aside.rd-sidebar");
      return Boolean(el && el.getBoundingClientRect().left >= 0);
    }, undefined, { timeout: 8_000 }).catch(() => {});
  }
  assert(await isOpen(), "sidebar tidak terbuka setelah 5 percobaan");
}

async function gotoNav(page: Page, nav: { menu: string; sub?: string; title: string; viaDashboard?: boolean }) {
  // "Transaksi AYO" sengaja TIDAK ada di sidebar (lihat visibleNavItems di
  // app/page.tsx) — satu-satunya jalan masuk adalah tombol "Lihat Semua" di
  // Dashboard, jadi test menirukan jalur user yang sebenarnya.
  if (nav.viaDashboard) {
    await gotoNav(page, { menu: "Dashboard AYO", title: "Dashboard AYO" });
    await page.getByRole("button", { name: "Lihat Semua" }).first().click();
    await page.locator("h1", { hasText: nav.title }).first().waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
    return;
  }
  await openSidebar(page);
  if (nav.sub) {
    const group = page.locator("aside.rd-sidebar button", { hasText: nav.menu }).first();
    if ((await group.getAttribute("aria-expanded")) === "false") await group.click();
    await page.locator("aside.rd-sidebar button", { hasText: nav.sub }).first().click();
  } else {
    await page.locator("aside.rd-sidebar button").filter({ hasText: new RegExp(`^${nav.menu}$`) }).first().click();
  }
  await page.locator("h1", { hasText: nav.title }).first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
}

/** Overflow horizontal: lebar dokumen jauh melebihi viewport (>16px toleransi). */
async function horizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

// -------------------------------------------------------- validasi berkas

type FileResult = { status: number; filename: string; contentType: string; bytes: Buffer };

/**
 * GET terautentikasi dengan retry singkat: dev server lokal sesekali menutup
 * koneksi / timeout saat sedang mengompilasi route baru, dan itu bukan temuan
 * aplikasi. Kegagalan yang menetap tetap dilempar.
 */
async function apiGet(api: APIRequestContext, url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await api.get(url.startsWith("http") ? url : `${BASE_URL}${url}`, { timeout: 180_000 });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  throw lastError;
}

async function fetchFile(api: APIRequestContext, url: string): Promise<FileResult> {
  const response = await apiGet(api, url);
  const disposition = response.headers()["content-disposition"] || "";
  return {
    status: response.status(),
    filename: /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? "",
    contentType: response.headers()["content-type"] || "",
    bytes: await response.body(),
  };
}

/**
 * Sel teks yang bisa ditafsirkan spreadsheet sebagai formula/perintah.
 * Placeholder "-" (konstanta di kode export, bukan data eksternal) dan angka
 * negatif yang tersimpan sebagai teks sengaja tidak dihitung — keduanya tidak
 * pernah dieksekusi Excel dan menandainya hanya menghasilkan false positive.
 */
function looksLikeFormula(value: string) {
  if (/^[\t\r]/.test(value)) return true;
  const trimmed = value.trim();
  if (!/^[=+\-@]/.test(trimmed)) return false;
  if (trimmed === "-") return false;
  if (/^-?\d[\d.,]*$/.test(trimmed)) return false;
  return true;
}

async function assertXlsx(file: FileResult, expect: { filename: RegExp; minRows?: number; minSheets?: number; containsText?: RegExp; notContainsText?: RegExp }) {
  assert(file.status === 200, `HTTP ${file.status}`);
  assert(file.contentType.includes("spreadsheetml"), `MIME salah: ${file.contentType}`);
  assert(expect.filename.test(file.filename), `nama file tidak sesuai: "${file.filename}"`);
  assert(file.bytes.length > 0, "ukuran 0 byte");
  assert(file.bytes.subarray(0, 2).toString() === "PK", "bukan berkas zip/xlsx yang valid");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.bytes as unknown as ArrayBuffer);
  const sheets = workbook.worksheets;
  assert(sheets.length >= (expect.minSheets ?? 1), `jumlah sheet ${sheets.length} < ${expect.minSheets ?? 1}`);

  let rows = 0;
  let numericCells = 0;
  const unsafe: string[] = [];
  const texts: string[] = [];
  for (const sheet of sheets) {
    rows += sheet.actualRowCount;
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value;
        if (typeof value === "number") {
          numericCells += 1;
          assert(Number.isFinite(value), `angka NaN/Infinity di ${sheet.name}!${cell.address}`);
        } else if (typeof value === "string") {
          texts.push(value);
          if (looksLikeFormula(value)) unsafe.push(`${sheet.name}!${cell.address} (${value.slice(0, 20)})`);
        }
      });
    });
  }
  assert(!unsafe.length, `sel berpotensi formula injection: ${unsafe.slice(0, 3).join(", ")}`);
  assert(rows >= (expect.minRows ?? 2), `hanya ${rows} baris`);
  assert(numericCells > 0, "tidak ada satu pun sel angka (laporan kosong?)");
  if (expect.containsText) assert(texts.some((text) => expect.containsText!.test(text)), `teks ${expect.containsText} tidak ditemukan di workbook`);
  if (expect.notContainsText) assert(!texts.some((text) => expect.notContainsText!.test(text)), `teks ${expect.notContainsText} seharusnya TIDAK ada di workbook`);
  return `${(file.bytes.length / 1024).toFixed(0)}KB, ${sheets.length} sheet [${sheets.map((s) => s.name).join(" | ")}], ${rows} baris, ${numericCells} sel angka`;
}

async function assertPdf(file: FileResult, expect: { filename: RegExp }) {
  assert(file.status === 200, `HTTP ${file.status}`);
  assert(file.contentType.includes("pdf"), `MIME salah: ${file.contentType}`);
  assert(expect.filename.test(file.filename), `nama file tidak sesuai: "${file.filename}"`);
  assert(file.bytes.length > 0, "ukuran 0 byte");
  assert(file.bytes.subarray(0, 5).toString() === "%PDF-", "bukan PDF valid");
  const pdf = await PDFDocument.load(file.bytes);
  assert(pdf.getPageCount() >= 1, "PDF tanpa halaman");
  return `${(file.bytes.length / 1024).toFixed(0)}KB, ${pdf.getPageCount()} halaman`;
}

// ------------------------------------------------------------------- main

const jakartaToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
const currentMonth = jakartaToday.slice(0, 7);
const SAMPLE_DATE = process.env.E2E_SAMPLE_DATE || "2026-05-01";
const SAMPLE_MONTH = process.env.E2E_SAMPLE_MONTH || SAMPLE_DATE.slice(0, 7);
// Tanggal yang diketahui memuat Booking Session multi-slot (kasus referensi).
const SESSION_DATE = process.env.E2E_SESSION_DATE || "2026-07-30";

async function main() {
  const browser: Browser = await chromium.launch({ channel: "chrome", headless: true });
  let failures = 0;
  try {
    // ---------------------------------------------------------- 1. auth
    currentArea = "auth";
    const anonContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const anonPage = await anonContext.newPage();
    watchPage(anonPage);

    await check("route terproteksi tanpa sesi diarahkan ke /login", async () => {
      await anonPage.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      assert(new URL(anonPage.url()).pathname === "/login", `berakhir di ${anonPage.url()}`);
    });
    await check("halaman /login tampil", async () => {
      await anonPage.locator("h1", { hasText: "Masuk ke Ayosera" }).waitFor({ state: "visible" });
    });
    await check("API terproteksi tanpa sesi ditolak (401)", async () => {
      const response = await apiGet(anonContext.request, `/api/dashboard`);
      assert(response.status() === 401, `HTTP ${response.status()}`);
    });
    await check("seluruh route API sesi menolak GET anonim (sapuan filesystem)", async () => {
      const routes = listApiRoutes();
      const sessionRoutes = routes.filter((route) => !NON_SESSION_ROUTES.some((pattern) => pattern.test(route.url)));
      const leaked: string[] = [];
      for (const route of sessionRoutes) {
        const response = await apiGet(anonContext.request, route.url);
        // 401/403 = ditolak, 405 = method salah, 400/404 = validasi sebelum data.
        // Yang tidak boleh: 200 (data bocor) atau 5xx.
        if (response.status() === 200 || response.status() >= 500) leaked.push(`${route.url} → ${response.status()}`);
      }
      assert(!leaked.length, `route membocorkan data tanpa sesi: ${leaked.join(", ")}`);
      return `${sessionRoutes.length} route sesi diuji anonim, ${routes.length - sessionRoutes.length} route non-sesi (auth/cron/webhook) dikecualikan`;
    });

    await check("login gagal menampilkan pesan error, bukan crash", async () => {
      await anonPage.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>('form button[type="submit"]');
        return Boolean(button && !button.disabled);
      }, undefined, { timeout: 60_000 });
      await anonPage.fill("#email", "nobody-e2e-task5@example.test");
      await anonPage.fill("#password", "wrong-password-e2e");
      await anonPage.getByRole("button", { name: /Masuk/ }).click();
      assert(!/password=/.test(anonPage.url()), `kredensial bocor ke URL: ${anonPage.url()}`);
      await anonPage.getByRole("alert").waitFor({ state: "visible", timeout: 20_000 });
      assert(new URL(anonPage.url()).pathname === "/login", "seharusnya tetap di /login");
    });
    await anonContext.close();

    const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    watchPage(page);

    await check("submit sebelum hydration tidak membocorkan kredensial ke URL", async () => {
      // Regresi: form login pernah ter-submit NATIVE (GET) sebelum React siap,
      // sehingga email+password masuk ke query string. Tombol submit kini
      // dinonaktifkan sampai hydration, `method="post"` sebagai lapisan kedua.
      await page.goto(`${BASE_URL}/login`, { waitUntil: "commit" });
      const submit = page.getByRole("button", { name: /Masuk/ });
      await submit.waitFor({ state: "visible", timeout: 60_000 });
      await submit.click({ force: true, noWaitAfter: true }).catch(() => {});
      await page.waitForTimeout(300);
      assert(!/password=|email=/.test(page.url()), `kredensial bocor ke URL: ${page.url()}`);
    });

    await check("login berhasil dan diarahkan ke dashboard", async () => {
      await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
      const submit = page.getByRole("button", { name: /Masuk/ });
      // Tombol aktif = hydration selesai; menunggu ini membuat test deterministik.
      await submit.waitFor({ state: "visible", timeout: 60_000 });
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>('form button[type="submit"]');
        return Boolean(button && !button.disabled);
      }, undefined, { timeout: 60_000 });
      await page.fill("#email", EMAIL);
      await page.fill("#password", PASSWORD);
      await submit.click();
      await page.waitForURL((url) => url.pathname === "/", { timeout: 60_000 });
      await page.locator("h1", { hasText: "Dashboard AYO" }).waitFor({ state: "visible", timeout: 60_000 });
      assert(!page.url().includes("?"), `URL mengandung query setelah login: ${page.url()}`);
    });
    await check("sesi bertahan setelah reload", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAppReady(page);
      assert(new URL(page.url()).pathname === "/", `berakhir di ${page.url()}`);
    });
    record("tidak ada error console/5xx pada alur auth", issuesFor("auth").length === 0, issuesFor("auth").map((i) => `${i.kind}: ${i.text}`).join(" ; "));

    // -------------------------------------------------- 2. seluruh halaman
    const session = (await (await apiGet(context.request, `/api/auth/me`)).json()) as {
      user?: { role?: string; allowedModules?: string[] };
    };
    const role = session.user?.role ?? "";
    const modules = session.user?.allowedModules ?? [];
    console.log(`\nSesi uji: role="${role}", modul=[${modules.join(", ")}]\n`);

    const navs = [
      { key: "dashboard", menu: "Dashboard AYO", title: "Dashboard AYO", module: "dasbor" },
      { key: "transaksi", menu: "Transaksi AYO", title: "Transaksi AYO", module: "transaksi", viaDashboard: true },
      { key: "olsera-kategori", menu: "Olsera", sub: "Kategori Penjualan", title: "Kategori Penjualan Olsera", module: "olsera" },
      { key: "olsera-inventori", menu: "Olsera", sub: "Inventori", title: "Inventori Olsera", module: "olsera" },
      { key: "olsera-keuangan", menu: "Olsera", sub: "Laporan Keuangan", title: "Laporan Keuangan Olsera", module: "olsera" },
      { key: "webhook", menu: "Webhook", title: "Monitoring Webhook AYO", module: "webhook" },
      // Menu "Pengguna" hanya dirender untuk supervisor.
      { key: "pengguna", menu: "Pengguna", title: "Manajemen Pengguna", module: "__supervisor__" },
    ].filter((nav) => {
      const available = nav.module === "__supervisor__" ? role === "supervisor" : modules.includes(nav.module);
      if (!available) {
        currentArea = nav.key;
        skip(`halaman "${nav.title}"`, nav.module === "__supervisor__" ? "butuh akun supervisor — tidak tersedia di kredensial uji" : `modul "${nav.module}" tidak dimiliki akun uji`);
      }
      return available;
    });

    for (const nav of navs) {
      currentArea = nav.key;
      await check(`halaman "${nav.title}" terbuka`, async () => {
        await gotoNav(page, nav);
        const overflow = await horizontalOverflow(page);
        assert(overflow <= 16, `overflow horizontal ${overflow}px pada 1440x900`);
        return `judul OK, overflow ${overflow}px`;
      });
      const issues = issuesFor(nav.key);
      if (issues.length) await shot(page, `fail-${nav.key}`);
      record("tidak ada console error / uncaught / 5xx", issues.length === 0, issues.map((i) => `${i.kind}: ${i.text}`).join(" ; "));
    }

    // ------------------------------------------- 3. filter & pagination
    const navByKey = (key: string) => {
      const nav = navs.find((item) => item.key === key);
      assert(nav, `nav "${key}" tidak tersedia untuk akun uji`);
      return nav;
    };

    currentArea = "transaksi-interaksi";
    await gotoNav(page, navByKey("transaksi"));
    await check("filter tanggal transaksi (preset Kemarin) bekerja", async () => {
      const before = await page.locator("table tbody tr").count();
      await page.getByRole("button", { name: "Kemarin", exact: true }).first().click();
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      const after = await page.locator("table tbody tr").count();
      return `baris ${before} → ${after}`;
    });
    await check("pagination transaksi tidak error", async () => {
      const label = page.locator("text=/^Halaman \\d+ \\/ \\d+$/").first();
      if (!(await label.count())) return "kontrol pagination tidak tampil (data sedikit)";
      const text = (await label.textContent()) ?? "";
      const next = page.getByRole("button", { name: "Berikutnya" }).first();
      if (await next.isDisabled()) return `hanya 1 halaman (${text.trim()})`;
      await next.click();
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      const after = ((await label.textContent()) ?? "").trim();
      assert(after !== text.trim(), "nomor halaman tidak berubah setelah klik Berikutnya");
      await page.getByRole("button", { name: "Sebelumnya" }).first().click();
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      return `${text.trim()} → ${after} → kembali`;
    });
    record("tidak ada console error / 5xx saat filter+pagination", issuesFor("transaksi-interaksi").length === 0, issuesFor("transaksi-interaksi").map((i) => `${i.kind}: ${i.text}`).join(" ; "));

    // ------------------------------------------------- 3b. Booking Session
    currentArea = "booking-session";
    const rupiahToNumber = (text: string) => Number(text.replace(/[^0-9]/g, "")) || 0;
    const sessionButtons = () => page.getByRole("button", { name: /detail \d+ slot untuk/ });
    const sessionButton = sessionButtons().first();

    await check(`filter ke ${SESSION_DATE} menampilkan Booking Session (default tertutup)`, async () => {
      await gotoNav(page, navByKey("transaksi"));
      await page.getByLabel("Tanggal mulai filter custom").fill(SESSION_DATE);
      await page.getByLabel("Tanggal selesai filter custom").fill(SESSION_DATE);
      // Tunggu tabel BENAR-BENAR menampilkan tanggal yang diminta — sekaligus
      // membuktikan filter tanggal bekerja, bukan sekadar menunggu jaringan.
      await page.waitForFunction(
        (date) => document.querySelector("tbody tr:not([id]) td")?.textContent?.trim() === date,
        SESSION_DATE,
        { timeout: 30_000 },
      );
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      await sessionButton.waitFor({ state: "visible", timeout: 30_000 });
      assert((await sessionButton.getAttribute("aria-expanded")) === "false", "session tidak tertutup secara default");
      const label = ((await sessionButton.textContent()) ?? "").trim();
      assert(/^\d+ slot$/.test(label), `label tidak sesuai: "${label}"`);
      const detailId = await sessionButton.getAttribute("aria-controls");
      assert(detailId, "aria-controls tidak diset");
      assert(!(await page.locator(`#${detailId}`).count()), "detail seharusnya belum dirender saat tertutup");
      // Istilah teknis "Booking Session" tidak boleh jadi identitas baris.
      const body = (await page.locator("tbody").first().textContent()) ?? "";
      assert(!/Booking Session/.test(body), "teks \"Booking Session\" masih tampil di tabel");
      return `${await sessionButtons().count()} session pada ${SESSION_DATE}`;
    });

    await check("baris ringkas menampilkan pelanggan, jam, court, dan total sesi", async () => {
      const cells = sessionButton.locator("xpath=ancestor::tr[1]").locator("td");
      const [date, time, customer, field, amount] = await Promise.all(
        [0, 1, 3, 5, 6].map(async (index) => ((await cells.nth(index).textContent()) ?? "").trim()),
      );
      assert(date.length > 0, "kolom Tanggal kosong");
      assert(/\d{2}:\d{2}\s*-\s*\d{2}:\d{2}/.test(time), `rentang jam tidak terbaca: "${time}"`);
      assert(customer.length > 0, "kolom Pelanggan kosong");
      assert(field.length > 0, "kolom Lapangan kosong");
      assert(/^Rp\s*[\d.]+$/.test(amount), `Total sesi tidak terbaca di kolom Nominal: "${amount}"`);
      return `${customer} · ${time} · ${field} · ${amount}`;
    });

    await check("klik expand menampilkan seluruh slot + aria-expanded false → true", async () => {
      await sessionButton.click();
      assert((await sessionButton.getAttribute("aria-expanded")) === "true", "aria-expanded tidak berubah");
      const detailId = (await sessionButton.getAttribute("aria-controls"))!;
      const detail = page.locator(`#${detailId}`);
      await detail.waitFor({ state: "visible", timeout: 15_000 });
      const slots = detail.locator("li");
      const slotCount = await slots.count();
      assert(slotCount >= 2, `session hanya punya ${slotCount} slot`);
      // Detail langsung ke daftar slot: tidak ada blok ringkasan sebelum <ul>.
      assert(!(await detail.locator("dl").count()), "detail masih memuat blok ringkasan");
      const text = (await detail.textContent()) ?? "";
      for (const repeated of ["Nama:", "Tanggal:", "Court:", "Total sesi:"]) {
        assert(!text.includes(repeated), `detail mengulang "${repeated}" yang sudah ada di baris ringkas`);
      }
      for (let index = 0; index < slotCount; index += 1) {
        const slot = ((await slots.nth(index).textContent()) ?? "").trim();
        assert(slot.startsWith(`Slot ${index + 1}`), `slot #${index + 1} tidak bernomor: "${slot}"`);
        assert(/\d{2}:\d{2}\s*-\s*\d{2}:\d{2}/.test(slot), `slot #${index + 1} tanpa jam: "${slot}"`);
        assert(/Booking:\s*\S+/.test(slot), `slot #${index + 1} tanpa ID booking`);
        assert(/Nominal slot:\s*Rp\s*[\d.]+/.test(slot), `slot #${index + 1} tanpa nominal`);
        assert(/Selesai|Belum Bayar|Dibatalkan/.test(slot), `slot #${index + 1} tanpa status`);
      }
      // Istilah pembayaran tidak boleh dipakai — API AYO tidak punya datanya.
      assert(!/DP|pelunasan|uang muka/i.test(text), "detail memakai istilah pembayaran yang dilarang");
      return `${slotCount} slot tampil`;
    });

    await check("Total sesi = jumlah Nominal slot yang dihitung (seluruh session di halaman)", async () => {
      const buttons = sessionButtons();
      const count = await buttons.count();
      let checked = 0;
      let nonZero = 0;
      for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        if ((await button.getAttribute("aria-expanded")) === "false") await button.click();
        const detail = page.locator(`#${(await button.getAttribute("aria-controls"))!}`);
        await detail.waitFor({ state: "visible", timeout: 15_000 });
        // Total sesi kini hanya hidup di kolom Nominal baris ringkas.
        const summaryCell = button.locator("xpath=ancestor::tr[1]").locator("td").nth(6);
        const total = rupiahToNumber((await summaryCell.textContent()) ?? "");
        let sum = 0;
        const slots = detail.locator("li");
        for (let slot = 0; slot < (await slots.count()); slot += 1) {
          const slotText = (await slots.nth(slot).textContent()) ?? "";
          // Slot yang tidak dihitung (mis. dibatalkan) sengaja dikecualikan —
          // mengikuti engine revenue existing, bukan aturan baru.
          if (/Tidak dihitung ke total sesi/.test(slotText)) continue;
          sum += rupiahToNumber(/Nominal slot:\s*(Rp\s*[\d.]+)/.exec(slotText)?.[1] ?? "");
        }
        assert(total === sum, `session #${index + 1}: Total sesi ${total} != jumlah nominal slot ${sum}`);
        checked += 1;
        if (total > 0) nonZero += 1;
        await button.click();
      }
      assert(nonZero > 0, "tidak ada session bernilai > 0 untuk diuji");
      return `${checked} session diperiksa, ${nonZero} bernilai > 0`;
    });

    await check("expand/collapse lewat keyboard (Enter) bekerja", async () => {
      await sessionButton.focus();
      const before = await sessionButton.getAttribute("aria-expanded");
      await page.keyboard.press("Enter");
      const toggled = await sessionButton.getAttribute("aria-expanded");
      assert(toggled !== before, `aria-expanded tetap "${before}" setelah Enter`);
      await page.keyboard.press("Enter");
      assert((await sessionButton.getAttribute("aria-expanded")) === before, "Enter kedua tidak mengembalikan keadaan semula");
      return `${before} → ${toggled} → ${before}`;
    });

    await check("setiap booking muncul tepat sekali & total pagination tetap per booking", async () => {
      const response = await apiGet(context.request, `/api/transactions?start_date=${SESSION_DATE}&end_date=${SESSION_DATE}&page=1&limit=50&sort=date&dir=asc`);
      assert(response.status() === 200, `HTTP ${response.status()}`);
      const payload = (await response.json()) as { data: unknown[]; total: number };
      const buttons = sessionButtons();
      let slotTotal = 0;
      for (let index = 0; index < (await buttons.count()); index += 1) {
        const label = (await buttons.nth(index).textContent()) ?? "";
        slotTotal += Number(/(\d+) slot/.exec(label)?.[1] ?? 0);
      }
      // Baris tunggal = baris tabel yang bukan baris ringkas session (baris detail punya id).
      const singleRows = (await page.locator("tbody tr:not([id])").count()) - (await buttons.count());
      assert(slotTotal + singleRows === payload.data.length, `slot ${slotTotal} + tunggal ${singleRows} != ${payload.data.length} booking dari API`);
      const summary = (await page.getByText(/dari \d+ transaksi/).first().textContent()) ?? "";
      const shown = Number(/dari (\d+) transaksi/.exec(summary)?.[1] ?? 0);
      assert(shown === payload.total, `teks pagination ${shown} != total API ${payload.total} (total harus tetap per booking)`);
      return `${slotTotal} slot dalam session + ${singleRows} booking tunggal = ${payload.data.length}; total pagination ${shown}`;
    });

    await check("booking tunggal tetap tanpa tombol expand", async () => {
      const rows = page.locator("tbody tr:not([id])");
      const total = await rows.count();
      const withButton = await sessionButtons().count();
      assert(total > withButton, "tidak ada baris tunggal untuk dibandingkan");
      return `${total - withButton} baris tunggal tidak berubah`;
    });

    await check("session tidak menambah overflow horizontal (desktop)", async () => {
      const overflow = await horizontalOverflow(page);
      assert(overflow <= 16, `overflow ${overflow}px saat session terbuka`);
      return `overflow ${overflow}px`;
    });

    record("tidak ada console error / 5xx pada Booking Session", issuesFor("booking-session").length === 0, issuesFor("booking-session").map((i) => `${i.kind}: ${i.text}`).join(" ; "));

    currentArea = "inventori-interaksi";
    await gotoNav(page, navByKey("olsera-inventori"));
    await check("tombol Hidden Item bekerja (hanya memengaruhi tampilan)", async () => {
      const button = page.getByRole("button", { name: /^Hidden Item/ }).first();
      const before = await page.locator("table tbody tr").count();
      await button.click();
      await page.waitForTimeout(500);
      const after = await page.locator("table tbody tr").count();
      const pressed = await button.getAttribute("aria-pressed");
      assert(pressed === "true", "aria-pressed tidak berubah");
      await button.click();
      return `baris ${before} → ${after} (toggle kembali)`;
    });
    await check("filter status 'Butuh Adjust Manual' tersedia dan tidak crash", async () => {
      const select = page.getByLabel("Filter status stok").first();
      await select.selectOption("manual");
      await page.waitForTimeout(500);
      const rows = await page.locator("table tbody tr").count();
      await select.selectOption("");
      return `${rows} baris pada filter manual`;
    });
    record("tidak ada console error / 5xx pada interaksi inventori", issuesFor("inventori-interaksi").length === 0, issuesFor("inventori-interaksi").map((i) => `${i.kind}: ${i.text}`).join(" ; "));

    // ---------------------------------------------------- 4. rekonsiliasi
    for (const route of ["/reconciliation", "/reconciliation/inventory"]) {
      currentArea = `rekonsiliasi${route.replace(/\//g, "-")}`;
      await check(`halaman ${route} terbuka`, async () => {
        const response = await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        assert((response?.status() ?? 0) < 400, `HTTP ${response?.status()}`);
        await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
        const heading = await page.locator("h1").first().textContent();
        const overflow = await horizontalOverflow(page);
        assert(overflow <= 16, `overflow horizontal ${overflow}px`);
        return `judul "${heading?.trim()}", overflow ${overflow}px`;
      });
      record("tidak ada console error / 5xx", issuesFor(currentArea).length === 0, issuesFor(currentArea).map((i) => `${i.kind}: ${i.text}`).join(" ; "));
    }

    // ------------------------------------ 4b. laporan keuangan: label DRAFT
    currentArea = "keuangan-draft";
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await waitForAppReady(page);
    await gotoNav(page, navByKey("olsera-keuangan"));
    await check("bulan berjalan berlabel 'Bulan Berjalan / Belum Final'", async () => {
      const periodInput = page.getByLabel("Pilih periode laporan keuangan");
      assert((await periodInput.inputValue()) === currentMonth, `periode default "${await periodInput.inputValue()}", bukan ${currentMonth}`);
      await page.getByText("Bulan Berjalan / Belum Final").first().waitFor({ state: "visible", timeout: 30_000 });
    });
    await check("bulan yang sudah lewat TIDAK berlabel draft", async () => {
      await page.getByLabel("Pilih periode laporan keuangan").fill(SAMPLE_MONTH);
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      await page.getByText("Bulan Berjalan / Belum Final").first().waitFor({ state: "hidden", timeout: 30_000 });
      const label = await page.getByText(/^Periode/).first().textContent();
      return `label periode: "${label?.replace(/\s+/g, " ").trim().slice(0, 60)}"`;
    });
    record("tidak ada console error / 5xx pada laporan keuangan", issuesFor("keuangan-draft").length === 0, issuesFor("keuangan-draft").map((i) => `${i.kind}: ${i.text}`).join(" ; "));

    // ----------------------------------------------------------- 5. tema
    currentArea = "tema";
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await waitForAppReady(page);
    await check("toggle dark mode mengubah data-mode", async () => {
      const before = await page.locator("html").getAttribute("data-mode");
      await page.getByRole("button", { name: /Ganti ke (Light|Dark) Mode/ }).click();
      await page.waitForTimeout(300);
      const after = await page.locator("html").getAttribute("data-mode");
      assert(before !== after, `data-mode tetap "${after}"`);
      return `${before} → ${after}`;
    });
    await check("tema bertahan setelah reload", async () => {
      const before = await page.locator("html").getAttribute("data-mode");
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAppReady(page);
      const after = await page.locator("html").getAttribute("data-mode");
      assert(before === after, `tema berubah setelah reload: ${before} → ${after}`);
      return `tetap "${after}"`;
    });
    await check("kembali ke light mode dan tetap bertahan", async () => {
      const current = await page.locator("html").getAttribute("data-mode");
      if (current !== "light") await page.getByRole("button", { name: /Ganti ke (Light|Dark) Mode/ }).click();
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAppReady(page);
      const after = await page.locator("html").getAttribute("data-mode");
      assert(after === "light", `data-mode "${after}"`);
    });
    await check("detail Booking Session terbaca di light mode (teks gelap di atas permukaan terang)", async () => {
      await gotoNav(page, navByKey("transaksi"));
      // Biarkan permintaan awal (hari ini) selesai dulu — mengganti filter saat
      // permintaan masih terbang membatalkannya dan memunculkan noise ECONNRESET.
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      await page.getByLabel("Tanggal mulai filter custom").fill(SESSION_DATE);
      await page.getByLabel("Tanggal selesai filter custom").fill(SESSION_DATE);
      await page.waitForFunction(
        (date) => document.querySelector("tbody tr:not([id]) td")?.textContent?.trim() === date,
        SESSION_DATE,
        { timeout: 30_000 },
      );
      const button = sessionButtons().first();
      await button.waitFor({ state: "visible", timeout: 30_000 });
      await button.click();
      const detail = page.locator(`#${(await button.getAttribute("aria-controls"))!}`);
      await detail.waitFor({ state: "visible", timeout: 15_000 });
      // Risiko nyata di light mode: kelas slate terang tidak ikut dipetakan ulang
      // sehingga teks jadi putih di atas latar putih. Cek luminansi kasar tiap span.
      const luminance = (color: string) => {
        const [r, g, b] = (color.match(/[\d.]+/g) ?? ["0", "0", "0"]).map(Number);
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      };
      const colors = await detail.locator("li span").evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
      const brightest = colors.reduce((max, color) => Math.max(max, luminance(color)), 0);
      assert(colors.length > 0, "tidak ada teks slot untuk diperiksa");
      assert(brightest < 0.6, `ada teks slot terlalu terang di light mode (luminansi ${brightest.toFixed(2)})`);
      await button.click();
      return `${colors.length} teks slot, luminansi tertinggi ${brightest.toFixed(2)}`;
    });
    record("tidak ada console error / 5xx saat ganti tema", issuesFor("tema").length === 0, issuesFor("tema").map((i) => `${i.kind}: ${i.text}`).join(" ; "));

    // ------------------------------------------------ 6. security header
    currentArea = "security";
    await check("security header lengkap pada dokumen HTML", async () => {
      const response = await apiGet(context.request, `/`);
      const headers = response.headers();
      for (const name of ["content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy"]) {
        assert(headers[name], `header ${name} hilang`);
      }
      assert(!/script-src[^;]*\*/.test(headers["content-security-policy"]), "CSP script-src memakai wildcard");
      return "CSP + 4 header lain ada";
    });
    await check("tidak ada CSP violation di browser", async () => {
      const violations = pageIssues.filter((issue) => /Content Security Policy/i.test(issue.text));
      assert(violations.length === 0, violations.map((v) => v.text).join(" ; "));
    });

    // ------------------------------------------------------ 7. sanity data
    currentArea = "sanity-data";
    const api = context.request;
    await check("dashboard API mengembalikan angka wajar (tidak negatif/NaN)", async () => {
      const response = await apiGet(api, `/api/dashboard`);
      assert(response.status() === 200, `HTTP ${response.status()}`);
      const payload = (await response.json()) as Record<string, unknown>;
      const numbers: string[] = [];
      const walk = (value: unknown, keyPath: string) => {
        if (typeof value === "number") {
          assert(Number.isFinite(value), `NaN/Infinity di ${keyPath}`);
          if (/revenue|total|count|jumlah/i.test(keyPath)) {
            assert(value >= 0, `nilai negatif di ${keyPath}: ${value}`);
            numbers.push(keyPath);
          }
        } else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${keyPath}[${index}]`));
        else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) walk(inner, `${keyPath}.${key}`);
      };
      walk(payload, "dashboard");
      return `${numbers.length} metrik revenue/total/count diperiksa`;
    });
    // Laporan keuangan di UI/export dibaca dari SNAPSHOT MongoDB
    // (/api/olsera/financial/snapshot), bukan endpoint live Olsera — jadi
    // pemeriksaan kestabilan angka dilakukan pada sumber yang sama dengan UI.
    await check("angka laporan keuangan stabil antar dua permintaan", async () => {
      const first = await apiGet(api, `/api/olsera/financial/snapshot?period=${SAMPLE_MONTH}`);
      const second = await apiGet(api, `/api/olsera/financial/snapshot?period=${SAMPLE_MONTH}`);
      assert(first.status() === 200 && second.status() === 200, `HTTP ${first.status()} / ${second.status()}`);
      const firstPayload = (await first.json()) as { reports?: { balanceSheet?: { assets?: { amount?: number } } } };
      const secondPayload = await second.json();
      assert(JSON.stringify(firstPayload) === JSON.stringify(secondPayload), "payload berbeda antar dua permintaan");
      const assets = firstPayload.reports?.balanceSheet?.assets?.amount;
      assert(typeof assets === "number" && Number.isFinite(assets) && assets !== 0, `total aset tidak wajar: ${assets}`);
      return `periode ${SAMPLE_MONTH} identik, total aset ${assets}`;
    });
    await check("pagination transaksi konsisten dengan total di API", async () => {
      const response = await apiGet(api, `/api/transactions?start_date=${SAMPLE_DATE}&end_date=${SAMPLE_DATE}&page=1&limit=25`);
      assert(response.status() === 200, `HTTP ${response.status()}`);
      const payload = (await response.json()) as { data?: unknown[]; total?: number; totalPages?: number; limit?: number };
      const rows = payload.data ?? [];
      const total = payload.total ?? 0;
      const totalPages = payload.totalPages ?? 1;
      assert(Number.isFinite(total) && total >= 0, `total tidak wajar: ${total}`);
      assert(rows.length <= 25, `limit dilanggar: ${rows.length} baris`);
      assert(totalPages === Math.max(1, Math.ceil(total / 25)), `totalPages ${totalPages} tidak cocok dengan total ${total} / limit 25`);
      return `${SAMPLE_DATE}: ${rows.length} baris halaman 1, total ${total}, ${totalPages} halaman`;
    });

    // --------------------------------------------------------- 8. mobile
    currentArea = "mobile";
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      storageState: await context.storageState(),
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    const mobilePage = await mobileContext.newPage();
    watchPage(mobilePage);
    await mobilePage.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await waitForAppReady(mobilePage);
    for (const nav of navs) {
      await check(`mobile 390x844: "${nav.title}"`, async () => {
        await gotoNav(mobilePage, nav);
        const overflow = await horizontalOverflow(mobilePage);
        if (overflow > 16) await shot(mobilePage, `fail-mobile-${nav.key}`);
        assert(overflow <= 16, `overflow horizontal ${overflow}px`);
        const logout = mobilePage.getByRole("button", { name: "Logout" });
        assert(await logout.isVisible(), "tombol Logout tidak terlihat di mobile");
        return `overflow ${overflow}px`;
      });
    }
    await check("mobile 390x844: Booking Session dapat dibuka tanpa overflow baru", async () => {
      await gotoNav(mobilePage, navByKey("transaksi"));
      await mobilePage.getByLabel("Tanggal mulai filter custom").fill(SESSION_DATE);
      await mobilePage.getByLabel("Tanggal selesai filter custom").fill(SESSION_DATE);
      await mobilePage.waitForFunction(
        (date) => document.querySelector("tbody tr:not([id]) td")?.textContent?.trim() === date,
        SESSION_DATE,
        { timeout: 30_000 },
      );
      const before = await horizontalOverflow(mobilePage);
      const button = mobilePage.getByRole("button", { name: /detail \d+ slot untuk/ }).first();
      await button.waitFor({ state: "visible", timeout: 30_000 });
      const box = await button.boundingBox();
      assert((box?.height ?? 0) >= 32, `target sentuh terlalu kecil: ${box?.height ?? 0}px`);
      await button.click();
      assert((await button.getAttribute("aria-expanded")) === "true", "session tidak terbuka di mobile");
      const after = await horizontalOverflow(mobilePage);
      if (after > before + 16) await shot(mobilePage, "fail-mobile-booking-session");
      assert(after <= before + 16, `overflow naik ${before}px → ${after}px setelah session dibuka`);
      return `overflow ${before}px → ${after}px, target sentuh ${Math.round(box?.height ?? 0)}px`;
    });
    record("mobile: tidak ada console error / 5xx", issuesFor("mobile").length === 0, issuesFor("mobile").map((i) => `${i.kind}: ${i.text}`).join(" ; "));
    await mobileContext.close();

    // -------------------------------------------------------- 9. export
    if (!SKIP_EXPORTS) {
      currentArea = "export-ayo";
      await check("Export Omzet Harian (1 hari)", async () =>
        assertXlsx(await fetchFile(api, `/api/transactions/export/harian?date=${SAMPLE_DATE}`), { filename: new RegExp(`Omzet Harian ${SAMPLE_DATE}\\.xlsx`) }));
      await check("Export Omzet Rentang (1 hari)", async () =>
        assertXlsx(await fetchFile(api, `/api/transactions/export/range?start=${SAMPLE_DATE}&end=${SAMPLE_DATE}`), { filename: /Omzet .*\.xlsx/ }));
      await check("Export Omzet Bulanan", async () =>
        assertXlsx(await fetchFile(api, `/api/transactions/export/bulanan?month=${SAMPLE_MONTH}`), { filename: /Omzet Bulanan .*\.xlsx/ }));
      await check("Export rentang tanggal berlebihan ditolak 400", async () => {
        const response = await apiGet(api, `/api/transactions/export/range?start=2020-01-01&end=${jakartaToday}`);
        assert(response.status() === 400, `HTTP ${response.status()}`);
        const body = await response.text();
        assert(!/at .*\(.*:\d+:\d+\)/.test(body), "stack trace bocor ke response");
        return "400 + pesan aman";
      });

      currentArea = "export-olsera";
      await check("Export Kategori Penjualan (1 hari)", async () =>
        assertXlsx(await fetchFile(api, `/api/olsera/export-categories?start_date=${SAMPLE_DATE}&end_date=${SAMPLE_DATE}`), { filename: new RegExp(`Kategori Penjualan-${SAMPLE_DATE}__${SAMPLE_DATE}\\.xlsx`) }));
      await check("Export Rincian Penjualan (1 hari)", async () =>
        assertXlsx(await fetchFile(api, `/api/olsera/export-items?start_date=${SAMPLE_DATE}&end_date=${SAMPLE_DATE}`), { filename: new RegExp(`Rincian Penjualan-${SAMPLE_DATE}__${SAMPLE_DATE}\\.xlsx`) }));
      await check("Export Omset Olsera (1 hari)", async () =>
        assertXlsx(await fetchFile(api, `/api/olsera/export?start_date=${SAMPLE_DATE}&end_date=${SAMPLE_DATE}`), { filename: /Omset Olsera .*\.xlsx/ }));
      await check("Export Omset Kategori (1 bulan)", async () =>
        assertXlsx(await fetchFile(api, `/api/olsera/export-category-revenue?month=${SAMPLE_MONTH}`), { filename: new RegExp(`Omset Kategori-${SAMPLE_MONTH}\\.xlsx`) }));
      await check("Export Pembagian Hasil LABERS (1 bulan)", async () =>
        assertXlsx(await fetchFile(api, `/api/olsera/export-labers-sharing?month=${SAMPLE_MONTH}`), { filename: new RegExp(`Pembagian Hasil LABERS-${SAMPLE_MONTH}\\.xlsx`) }));

      currentArea = "export-inventori";
      // "Hidden Item" adalah filter TAMPILAN saja (lib/olsera-inventory-ui.ts):
      // kategori LABERS/JASA HOST harus tetap ikut di export.
      await check("Export Stok Inventori tetap memuat kategori Hidden Item", async () =>
        assertXlsx(await fetchFile(api, `/api/olsera/inventory/export?type=stock`), {
          filename: /Stok Inventori-\d{4}-\d{2}-\d{2}\.xlsx/,
          containsText: /^(LABERS|JASA HOST)$/i,
        }));
      await check("Export Mutasi Inventori (1 hari)", async () =>
        assertXlsx(await fetchFile(api, `/api/olsera/inventory/export?type=movements&start_date=${SAMPLE_DATE}&end_date=${SAMPLE_DATE}`), { filename: /Mutasi Inventori-.*\.xlsx/ }));
      await check("Export Konsistensi Inventori", async () =>
        assertXlsx(await fetchFile(api, `/api/olsera/inventory/export?type=consistency&start_date=${SAMPLE_DATE}`), { filename: /Konsistensi Inventori-.*\.xlsx/ }));
      await check("Export Inventori Bulanan canonical (2 sheet: Terjual & Keseluruhan)", async () =>
        assertXlsx(await fetchFile(api, `/api/olsera/inventory/export/monthly-auto?year=${SAMPLE_MONTH.slice(0, 4)}&month=${Number(SAMPLE_MONTH.slice(5, 7))}`), { filename: new RegExp(`Inventori-${SAMPLE_MONTH}\\.xlsx`) }));

      currentArea = "export-keuangan";
      for (const report of ["neraca", "laba-rugi", "arus-kas", "ringkasan-buku-besar"]) {
        await check(`Export PDF ${report} (${SAMPLE_MONTH})`, async () =>
          assertPdf(await fetchFile(api, `/api/olsera/financial/export/pdf?period=${SAMPLE_MONTH}&report=${report}`), { filename: new RegExp(`${report}-${SAMPLE_MONTH}\\.pdf`) }));
      }
      await check(`Export Excel gabungan laporan keuangan (${SAMPLE_MONTH}, bulan tertutup: tanpa label DRAFT)`, async () =>
        assertXlsx(await fetchFile(api, `/api/olsera/financial/export/excel?period=${SAMPLE_MONTH}`), {
          filename: new RegExp(`laporan-keuangan-${SAMPLE_MONTH}\\.xlsx`),
          minSheets: 4,
          notContainsText: /DRAFT|BELUM FINAL/i,
        }));
      await check(`Export Excel bulan berjalan (${currentMonth}) membawa label DRAFT/BELUM FINAL`, async () =>
        assertXlsx(await fetchFile(api, `/api/olsera/financial/export/excel?period=${currentMonth}`), {
          filename: new RegExp(`laporan-keuangan-${currentMonth}\\.xlsx`),
          minSheets: 4,
          containsText: /DRAFT|BELUM FINAL/i,
        }));
      await check("Export Buku Besar Detail SATU akun (sample kecil, bukan export produksi penuh)", async () => {
        const snapshot = await apiGet(api, `/api/olsera/financial/snapshot?period=${SAMPLE_MONTH}`);
        assert(snapshot.status() === 200, `snapshot HTTP ${snapshot.status()}`);
        const payload = (await snapshot.json()) as { reports?: { ledgerSummary?: { accountCode?: number | string; debit?: number; credit?: number }[] } };
        const accounts = payload.reports?.ledgerSummary ?? [];
        // Akun tanpa mutasi sengaja dijawab 404 "ledger-empty" oleh API; ambil
        // akun yang benar-benar punya jurnal supaya yang diuji jalur suksesnya.
        const code = accounts.find((account) => (account.debit ?? 0) !== 0 || (account.credit ?? 0) !== 0)?.accountCode;
        assert(code, "tidak ada akun bermutasi pada ringkasan buku besar snapshot");
        const emptyAccount = accounts.find((account) => (account.debit ?? 0) === 0 && (account.credit ?? 0) === 0)?.accountCode;
        if (emptyAccount) {
          const empty = await apiGet(api, `/api/olsera/financial/export/pdf?period=${SAMPLE_MONTH}&report=buku-besar-detail&accountCode=${encodeURIComponent(String(emptyAccount))}`);
          assert(empty.status() === 404, `akun tanpa mutasi seharusnya 404, dapat ${empty.status()}`);
        }
        const file = await fetchFile(api, `/api/olsera/financial/export/pdf?period=${SAMPLE_MONTH}&report=buku-besar-detail&accountCode=${encodeURIComponent(String(code))}`);
        return `${await assertPdf(file, { filename: /\.pdf$/ })} (akun ${code})`;
      });
      await check("periode tanpa data ditolak rapi (bukan 5xx / bukan file korup)", async () => {
        const response = await apiGet(api, `/api/olsera/financial/export/pdf?period=2019-01&report=neraca`);
        assert(response.status() < 500, `HTTP ${response.status()}`);
        return `HTTP ${response.status()}`;
      });
    }

    // -------------------------------------------------------- 10. logout
    currentArea = "logout";
    await check("logout berhasil dan diarahkan ke /login", async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await waitForAppReady(page);
      await page.getByRole("button", { name: "Logout" }).click();
      await page.waitForURL((url) => url.pathname === "/login", { timeout: 60_000 });
    });
    await check("route terproteksi ditolak setelah logout", async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      assert(new URL(page.url()).pathname === "/login", `berakhir di ${page.url()}`);
      const response = await apiGet(context.request, `/api/dashboard`);
      assert(response.status() === 401, `API dashboard HTTP ${response.status()}`);
    });
    record("logout: tidak ada console error / 5xx", issuesFor("logout").length === 0, issuesFor("logout").map((i) => `${i.kind}: ${i.text}`).join(" ; "));

    await context.close();
  } finally {
    await browser.close();
  }

  failures = results.filter((result) => !result.ok).length;
  const skipped = results.filter((result) => result.skipped).length;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, "e2e-results.json"), JSON.stringify({ baseUrl: BASE_URL, results, pageIssues }, null, 2));
  const warnings = pageIssues.filter((issue) => issue.kind === "console.warning");
  if (warnings.length) {
    console.log(`\nWarning console (tidak menggagalkan, ${warnings.length}):`);
    for (const warning of [...new Set(warnings.map((w) => `[${w.area}] ${w.text}`))]) console.log(`  ${warning}`);
  }
  console.log(`\n${results.length - failures - skipped}/${results.length - skipped} cek PASS, ${skipped} skip. Detail: ${path.join(OUT_DIR, "e2e-results.json")}`);
  if (failures) {
    console.log("\nGAGAL:");
    for (const result of results.filter((r) => !r.ok)) console.log(`  [${result.area}] ${result.name} — ${result.detail}`);
  }
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
