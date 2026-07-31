import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Regresi Task 5: form login pernah bisa ter-submit secara NATIVE sebelum React
 * hydration selesai. Karena `<form>` tanpa atribut method default ke GET, email
 * dan password ikut terkirim sebagai query string (`/login?email=...&password=...`)
 * — bocor ke history browser, log akses server, dan header Referer.
 *
 * Test ini struktural (membaca source) karena perilakunya hanya muncul di
 * browser sungguhan sebelum hydration; verifikasi perilakunya ada di
 * scripts/e2e-audit.ts ("kredensial tidak pernah muncul di URL"). Yang dijaga di
 * sini adalah dua lapisan pencegahnya supaya tidak terhapus tanpa sengaja.
 */
const source = readFileSync(path.join(process.cwd(), "app", "login", "page.tsx"), "utf8");

test("form login memakai method post sehingga kredensial tidak pernah masuk query string", () => {
  const form = /<form[^>]*>/.exec(source)?.[0] ?? "";
  assert.ok(form, "form login tidak ditemukan");
  assert.match(form, /method="post"/, "form login harus punya method=\"post\"");
});

test("tombol submit login nonaktif sampai hydration selesai", () => {
  assert.match(source, /const \[hydrated, setHydrated\] = useState\(false\)/, "state hydrated hilang");
  assert.match(source, /setHydrated\(true\)/, "hydrated tidak pernah diset di effect mount");
  assert.match(source, /type="submit"[^>]*disabled=\{loading \|\| !hydrated\}/, "tombol submit harus disabled saat belum hydrated");
});
