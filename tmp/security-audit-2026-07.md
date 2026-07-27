# AYOSERA Security and Bug Audit

Dibuat: 2026-07-27 — audit read-only menyeluruh (dependency, secret, auth/authz, API/input validation, frontend, export, MongoDB/data access, sync/cron, security headers, regression test). **Tidak ada kode/dependency/MongoDB/git yang diubah selama audit ini.** Semua nilai credential yang ditemukan (di test fixture) sudah dipastikan bukan credential asli sebelum dilaporkan; tidak ada nilai asli yang ditampilkan di laporan ini.

---

## Executive Summary

- **Keputusan akhir: FIX BEFORE RELEASE**
- Jumlah temuan kode aplikasi per severity: **Critical: 0 · High: 1 · Medium: 6 · Low: 8 · Informational: 10+** (checklist "confirmed safe", lihat Findings)
- Dependency (npm audit) per severity: **Critical: 1 (dev-only/build-time) · High: 6 · Moderate: 1 · Low: 0**
- Confirmed vulnerability (kode aplikasi): **1** (formula injection pada export Excel)
- Confirmed bug: **1** (query `/api/transactions` tidak benar-benar dibatasi tanggal seperti diklaim komentarnya)
- Security weakness: **4**
- Hardening recommendation: **7**
- Known operational risk: **1**
- False positive / confirmed-safe (dicek eksplisit, TIDAK ada masalah): 10+ item (lihat bagian akhir Findings)

Alasan "FIX BEFORE RELEASE": ditemukan **satu Confirmed High vulnerability yang benar-benar dapat dieksploitasi** (spreadsheet formula injection di export Excel — CWE-1236) pada kode yang SUDAH ADA di produksi (bukan bagian dari perubahan Phase 1 yang sedang menunggu commit). Kriteria "Release Blockers" pada instruksi mewajibkan Critical/High yang benar-benar memblokir dilaporkan sebagai blocker — temuan ini memenuhi kriteria tersebut untuk deploy BERIKUTNYA (bukan berarti perubahan Phase 1 itu sendiri buruk; Phase 1 lulus semua test dan tidak menyentuh file yang bermasalah ini).

---

## Release Decision

# FIX BEFORE RELEASE

Wajib diperbaiki sebelum deploy berikutnya: **SEC-01 (formula injection export Excel)**. Selain itu, tidak ada Critical/High lain yang ditemukan pada kode aplikasi. Perubahan Phase 1 (fitur DRAFT laporan keuangan) yang sedang menunggu commit **TIDAK** menyentuh file yang bermasalah dan **LULUS SEMUA TEST** — commit Phase 1 itu sendiri secara teknis aman, tapi kebijakan rilis di sini digabung dengan seluruh codebase karena audit ini diminta secara menyeluruh, bukan hanya diff Phase 1.

---

## Release Blockers

| ID | Judul | Severity | Lokasi |
| --- | --- | --- | --- |
| SEC-01 | Spreadsheet formula injection pada export Excel (Export Kategori/Rincian Item) | **High** | `lib/olsera-item-export.ts:70-74`, `lib/olsera-category-export.ts:105-118,276` |

Tidak ada Critical pada kode aplikasi. Dependency Critical (`tar` via `@tailwindcss/oxide`) adalah **dev/build-time only** (dijelaskan di Dependency Audit) — TIDAK diklasifikasikan sebagai release blocker runtime, tapi dicatat untuk kesadaran.

---

## Findings

### SEC-01 — Spreadsheet Formula Injection pada Export Excel
- **Severity:** High
- **File:baris:** `lib/olsera-item-export.ts:70-74` (`safeText()`), `lib/olsera-category-export.ts:105-118` (`safeText()` kedua, implementasi berbeda), `lib/olsera-category-export.ts:276` (`row.itemName` ditulis MENTAH tanpa `safeText`)
- **Bukti teknis:** Kedua fungsi `safeText()` hanya melakukan `trim()`, menolak string angka murni, dan menolak `"[object Object]"` — **tidak pernah** memeriksa/menetralisir karakter awal `=`, `+`, `-`, atau `@`. Nilai seperti `customerName`, `salesByName`, `itemName` (berasal dari data Olsera — API pihak ketiga, bukan input yang dikontrol AYOSERA) ditulis langsung sebagai `cell.value` di ExcelJS.
- **Skenario dampak:** Jika nama produk/item/pelanggan di Olsera diawali `=`, `+`, `-`, atau `@` (mis. `=HYPERLINK("http://evil","klik")` atau `=cmd|'/c calc'!A1`), nilai tsb akan disimpan APA ADANYA di file `.xlsx` export dan **dieksekusi sebagai formula** oleh Microsoft Excel/LibreOffice saat file dibuka oleh staf finance/admin AYOSERA.
- **Dapat dieksploitasi:** Ya — dibuktikan langsung dari kode (tidak ada sanitasi sama sekali untuk karakter formula).
- **Prasyarat eksploitasi:** Penyerang perlu bisa membuat data transaksi Olsera dengan `itemName`/`customerName` yang diawali karakter formula (mis. lewat nama produk di sistem Olsera, atau nama pelanggan saat checkout) — TIDAK memerlukan akses ke AYOSERA sendiri, hanya kontrol atas data yang mengalir dari Olsera. Korban harus membuka file export di Excel/LibreOffice (bukan otomatis tereksekusi di AYOSERA sendiri).
- **Rekomendasi:** Tambahkan pemeriksaan leading-character (`/^[=+\-@\t\r]/`) di KEDUA `safeText()` (prefix dengan `'` bila cocok), dan pastikan seluruh sel yang berisi string dari Olsera (termasuk `row.itemName` di `olsera-category-export.ts:276`, dan pola serupa di `lib/olsera-labers-export.ts`, `lib/omzet-export.ts`, `lib/omset-kategori-export.ts`, `lib/olsera-inventory-monthly-export.ts`) melalui sanitasi yang sama. **Perbaikan TIDAK dilakukan pada audit ini** (audit read-only).
- **Release blocker:** **YA**

### BUG-01 — Query `/api/transactions` tidak dibatasi tanggal bila parameter kosong (klaim komentar salah)
- **Severity:** Medium
- **File:baris:** `app/api/transactions/route.ts:48` (`bookings.find(filter).sort(sortSpec).toArray()`, tanpa `.limit()`), komentar di baris 47 menyatakan "Query sudah dibatasi rentang tanggal + filter, jadi set ini terbatas"; `lib/booking-query.ts:27-32` — `filter.date` HANYA diisi bila `date`/`start_date`/`end_date` disediakan.
- **Bukti teknis:** `buildBookingFilter()` tidak memaksa filter tanggal apa pun — bila ketiga parameter kosong, `filter` bisa jadi `{}` (atau hanya berisi filter non-tanggal), sehingga `.find(filter)` men-scan SELURUH koleksi `bookings` tanpa batas, bertentangan dengan komentar kode.
- **Skenario dampak:** User terautentikasi (modul "transaksi") memanggil `/api/transactions` tanpa parameter tanggal → seluruh histori booking dimuat ke memori sekaligus. Seiring pertumbuhan data, ini berisiko lambat/memory-heavy (DoS ringan internal), bukan kebocoran data (user memang berhak lihat data transaksi).
- **Dapat dieksploitasi:** Ya, oleh user internal yang sudah terautentikasi — bukan celah otorisasi, murni bug performa/DoS ringan.
- **Prasyarat:** Akun dengan modul "transaksi", memanggil endpoint tanpa parameter tanggal.
- **Rekomendasi:** Tambahkan default rentang tanggal wajib (mis. 90 hari terakhir) bila tak ada parameter tanggal, atau `.limit()` keras di level query.
- **Release blocker:** Tidak (Medium, internal-only, bukan kebocoran data)

### SEC-02 — Fallback secret hardcoded untuk sesi Better Auth
- **Severity:** Medium (security weakness, saat ini termitigasi oleh konfigurasi env yang benar)
- **File:baris:** `lib/auth.ts:43` — `secret: process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET || "local-dev-secret-change-before-production-please-32chars"`
- **Bukti teknis:** Bila KEDUA env var (`BETTER_AUTH_SECRET`, `JWT_SECRET`) tidak diset di suatu environment, secret penandatanganan sesi jatuh ke string hardcoded yang ada di repo publik/tim.
- **Skenario dampak:** Bila deploy environment (mis. preview/staging Vercel) lupa mengatur env var ini, siapa pun yang membaca source code dapat memalsukan/menandatangani sesi (session forgery/account takeover).
- **Dapat dieksploitasi:** Tidak dapat dibuktikan pada environment saat ini — `.env.local` memverifikasi `JWT_SECRET` SUDAH diset (dicek keberadaan key, bukan nilainya), sehingga fallback hardcoded TIDAK aktif di environment ini. Risiko murni pada environment lain yang mungkin lupa konfigurasi.
- **Prasyarat:** Deployment tanpa `BETTER_AUTH_SECRET`/`JWT_SECRET` diset.
- **Rekomendasi:** Hapus fallback hardcoded; `throw` saat startup bila secret tidak diset di production (fail-closed, bukan fail-open ke nilai publik).
- **Release blocker:** Tidak (termitigasi di environment ini oleh konfigurasi yang sudah benar)

### SEC-03 — Header keamanan wajib (CSP, X-Frame-Options/frame-ancestors, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) tidak diset
- **Severity:** Medium
- **File:baris:** `next.config.ts:1-8` (tidak ada fungsi `headers()`), `middleware.ts:1-23` (hanya redirect berbasis cookie, tidak menambahkan header apa pun)
- **Bukti teknis:** Grep menyeluruh untuk CSP/X-Content-Type-Options/Referrer-Policy/Permissions-Policy/X-Frame-Options/CORS di seluruh repo — nol hasil.
- **Skenario dampak:** Dashboard (berisi sesi login, data finansial) TIDAK punya `frame-ancestors`/`X-Frame-Options` → berpotensi di-frame oleh situs lain (clickjacking). Tidak ada CSP berarti mitigasi XSS lapis kedua tidak ada (meski audit frontend tidak menemukan XSS aktif saat ini).
- **Dapat dieksploitasi:** Clickjacking scenario secara teknis mungkin (tidak ada penghalang framing), tapi memerlukan social engineering tambahan (user diarahkan ke halaman penyerang yang meng-iframe dashboard) — Medium, bukan High, karena butuh prasyarat tambahan dan tidak ada bukti aktif dieksploitasi.
- **Catatan:** Strict-Transport-Security TIDAK perlu ditambahkan manual bila di-deploy di domain custom Vercel (Vercel menambahkan HSTS otomatis di edge) — bukan gap yang perlu ditindaklanjuti.
- **Rekomendasi:** Tambahkan `headers()` di `next.config.ts` untuk `X-Frame-Options: DENY` (atau CSP `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. CSP penuh butuh perencanaan (banyak inline script/style dari Tailwind/Next) — rekomendasi bertahap.
- **Release blocker:** Tidak (Medium, hardening prioritas tinggi tapi bukan exploit aktif yang dibuktikan)

### SEC-04 — Perbandingan CRON_SECRET tidak constant-time
- **Severity:** Low
- **File:baris:** `lib/olsera-cron-auth.ts:13` (`authHeader !== \`Bearer ${expectedSecret}\``), pola identik di `lib/cron-olsera-sync.ts:26` dan `app/api/cron/sync/route.ts:39`
- **Bukti teknis:** Kelima endpoint cron (`/api/cron/sync`, `/api/cron/olsera-sync`, `/api/cron/olsera/{sales,inventory,financial}`) memakai `!==` string biasa, bukan `crypto.timingSafeEqual`.
- **Skenario dampak:** Teori: timing side-channel untuk menebak CRON_SECRET karakter demi karakter. Praktik: jitter jaringan HTTP publik (apalagi lewat Vercel edge) membuat serangan ini sangat tidak praktis dieksekusi nyata.
- **Dapat dieksploitasi:** Secara teori ya, secara praktik sangat sulit (butuh jutaan request presisi tinggi, tidak feasible lewat internet publik).
- **Rekomendasi:** Ganti dengan `crypto.timingSafeEqual` (butuh panjang buffer sama, perlu penanganan panjang berbeda dulu).
- **Release blocker:** Tidak

### SEC-05 — Endpoint cron lama `/api/cron/olsera-sync` tetap berfungsi penuh TANPA distributed lock baru
- **Severity:** Medium (Known Operational Risk)
- **File:baris:** `lib/cron-olsera-sync.ts:16-38` (memanggil `syncOlseraSalesByCategory` langsung, TIDAK memakai `lib/olsera-cron-lock.ts`), dibandingkan `lib/cron-olsera-sales.ts` (endpoint baru, memakai lock — dikonfirmasi lewat `withOlseraSyncLock`/`acquireOlseraSyncLock` di file yang sama)
- **Bukti teknis:** Endpoint lama (`app/api/cron/olsera-sync/route.ts`, method GET) masih menerima request dan mengeksekusi `syncOlseraSalesByCategory(start_date, end_date, { force: true })` bila `CRON_SECRET` cocok — TIDAK ada pemeriksaan/pengambilan lock `olsera_sync_locks` sama sekali di jalur ini.
- **Skenario dampak:** Bila scheduler eksternal (cron-job.org) untuk endpoint lama BELUM dinonaktifkan saat endpoint baru (`/api/cron/olsera/sales`, dengan lock) mulai dijadwalkan, keduanya bisa berjalan bersamaan tanpa koordinasi lock — berpotensi race condition/duplicate write pada window sinkron yang sama.
- **Dapat dieksploitasi:** TIDAK DAPAT DIVERIFIKASI dari repo — jadwal cron-job.org adalah konfigurasi eksternal, tidak tersimpan di kode. Ini murni risiko operasional, bukan vulnerability yang dibuktikan aktif.
- **Rekomendasi:** Konfirmasi manual di dashboard cron-job.org bahwa jadwal lama untuk `/api/cron/olsera-sync` SUDAH dihapus/dinonaktifkan. Pertimbangkan menghapus/menonaktifkan route lama di kode (mengembalikan 410 Gone) agar tidak bergantung pada konfigurasi eksternal yang tidak terlihat dari repo.
- **Release blocker:** Tidak (operational risk eksternal, bukan bug kode)

### SEC-06 — Endpoint cron `/api/cron/sync` dan `/api/cron/olsera-sync` memakai GET untuk operasi mutasi
- **Severity:** Low
- **File:baris:** `app/api/cron/sync/route.ts:35` (`export async function GET`, memicu `syncProductionListBookings`), `app/api/cron/olsera-sync/route.ts:15` (`export async function GET`, memicu sync + write DB)
- **Bukti teknis:** Kedua endpoint memakai method GET untuk operasi yang menulis ke MongoDB — menyalahi semantik HTTP (GET seharusnya idempotent/read-only), meskipun tetap digerbangi oleh cek `CRON_SECRET` yang identik dengan endpoint POST lainnya.
- **Skenario dampak:** Risiko utama GET-untuk-mutasi (caching perantara/CDN, prefetching browser, crawler) TIDAK berlaku signifikan di sini karena endpoint memerlukan header `Authorization: Bearer <CRON_SECRET>` yang tidak mungkin disisipkan oleh prefetcher/crawler otomatis.
- **Dapat dieksploitasi:** Tidak terbukti — mitigasi oleh gerbang secret yang sama efektifnya dengan endpoint POST.
- **Rekomendasi:** Migrasi ke POST untuk konsistensi semantik HTTP (bukan darurat).
- **Release blocker:** Tidak

### SEC-07 — Query inventori (`/api/olsera/inventory/products`, `/movements`) tidak difilter `storeId`
- **Severity:** Medium (latent/dormant — saat ini TIDAK exploitable karena single-tenant)
- **File:baris:** `app/api/olsera/inventory/products/route.ts:39-44` (`filter` hanya berisi `q`/`category`, tidak ada `storeId`), pola sama di `app/api/olsera/inventory/movements/route.ts`
- **Bukti teknis:** Skema `OlseraInventoryProductDocument.storeId` (`lib/mongodb.ts:261`) ada, tapi route pembacaannya tidak menambahkan klausa `storeId` ke filter MongoDB — membaca lintas SEMUA store dalam koleksi.
- **Skenario dampak:** Bila di masa depan lebih dari satu store/venue disinkronkan ke koleksi yang sama, endpoint ini akan mencampur data lintas store tanpa isolasi (cross-tenant data exposure).
- **Dapat dieksploitasi:** TIDAK saat ini — `storeId` diambil dari `process.env.OLSERA_INTERNAL_STORE_ID` (server-side, bukan input klien) dan hanya SATU store yang dikonfigurasi/disinkronkan (dikonfirmasi: tidak ada endpoint yang menerima `storeId` dari klien). Bug ini laten, bukan celah aktif.
- **Rekomendasi:** Tambahkan `filter.storeId = <storeId dari server config>` secara eksplisit di kedua route sebagai pertahanan berlapis, sebelum multi-store benar-benar diaktifkan.
- **Release blocker:** Tidak (laten, single-tenant saat ini)

### SEC-08 — Beberapa `fetch()` ke API eksternal (Olsera/AYO) tanpa timeout eksplisit
- **Severity:** Medium
- **File:baris:** `lib/olsera.ts:41,96` (token & data fetch), `lib/ayo.ts:104`, `lib/olsera-category-export.ts:50`, `lib/olsera-inventory-stockmovement.ts:59`, `lib/olsera-inventory.ts:63`, `lib/olsera-resolver-context.ts:35`, `lib/olsera-sync.ts:121` — semua tanpa `AbortController`/`signal`. Kontras: `lib/olsera-financial-client.ts:8` SUDAH memakai timeout 10 detik via `AbortController` + `clearTimeout` di `finally`.
- **Bukti teknis:** Dikonfirmasi via pembacaan langsung tiap file — tidak ada `signal:` pada opsi `fetch()` di file-file tsb.
- **Skenario dampak:** Bila Olsera/AYO API hang (bukan error, tapi tidak merespons sama sekali), request bisa menggantung hingga batas platform (`maxDuration` route, umumnya 60-300 detik sesuai konfigurasi masing-masing route) — bukan hang selamanya (dibatasi platform), tapi tetap memboroskan waktu eksekusi function dan bisa membuat sync/cron menjadi lambat/timeout tanpa pesan error yang jelas.
- **Dapat dieksploitasi:** Bukan celah keamanan yang bisa dipicu penyerang eksternal (Olsera/AYO adalah pihak yang dipercaya), tapi merupakan bug ketahanan (resilience) nyata.
- **Rekomendasi:** Terapkan pola `AbortController` yang sama seperti `lib/olsera-financial-client.ts` ke seluruh titik fetch eksternal lain.
- **Release blocker:** Tidak

### SEC-09 — Regex tak di-escape pada pencarian booking (`lib/booking-query.ts`)
- **Severity:** Low
- **File:baris:** `lib/booking-query.ts` — parameter `q` dipakai sebagai `$regex` tanpa escape (berbeda dengan `bookingId`/`search` di `app/api/transactions/route.ts` yang SUDAH memakai `escapeRegex`).
- **Bukti teknis:** Nilai string dari `searchParams.get("q")` diinterpolasi langsung sebagai pola regex MongoDB.
- **Skenario dampak:** User terautentikasi (modul transaksi) dapat mengirim pola regex custom (mis. pola nested-quantifier yang lambat) sebagai nilai field `$regex` — BUKAN injection operator MongoDB (masih berupa nilai field biasa, bukan objek query mentah), tapi berpotensi query lambat (ReDoS ringan pada level MongoDB regex engine, dampak terbatas).
- **Dapat dieksploitasi:** Ya secara terbatas, hanya oleh user internal terautentikasi, dampak performa bukan kebocoran data.
- **Rekomendasi:** Terapkan `escapeRegex` yang sama ke parameter `q` di `booking-query.ts`.
- **Release blocker:** Tidak

### SEC-10 — `error.message` mentah dikembalikan di beberapa response API
- **Severity:** Low
- **File:baris:** `app/api/cron/sync/route.ts:84`, `app/api/reservations/route.ts:70`, `app/api/reservations/cancel/route.ts:58`, `app/api/webhooks/ayo/route.ts:113`, `app/api/webhooks/ayo-sandbox/route.ts:118,150`
- **Bukti teknis:** Pola `error instanceof Error ? error.message : "..."` dikembalikan langsung ke client/log tanpa whitelist pesan.
- **Skenario dampak:** Berpotensi membocorkan detail teknis (bukan credential — driver MongoDB/fetch TIDAK menyertakan connection string/token penuh di `error.message` standarnya), tapi tetap information disclosure ringan (nama field internal, struktur error).
- **Dapat dieksploitasi:** Tidak ditemukan bukti kebocoran credential aktual pada pola ini (berbeda dengan modul finansial yang SUDAH memakai `mapFinancialError`/pesan aman khusus).
- **Rekomendasi:** Samakan dengan pola aman modul finansial (`lib/olsera-financial-core.ts: mapFinancialError`) — pesan generik ke client, detail lengkap hanya di server log.
- **Release blocker:** Tidak

### SEC-11 — Label tanggal snapshot export inventori memakai UTC, bukan Asia/Jakarta
- **Severity:** Low (kosmetik)
- **File:baris:** `lib/olsera-inventory-export.ts:69` — `` `Snapshot: ${new Date().toISOString().slice(0, 10)}` ``
- **Bukti teknis:** Memakai `Date.prototype.toISOString()` (UTC) untuk label, bukan `Intl.DateTimeFormat` dengan `timeZone: "Asia/Jakarta"` seperti konvensi di `lib/olsera-baseline.ts`/`lib/olsera-financial-core.ts`.
- **Skenario dampak:** Dekat tengah malam UTC (07:00 WIB), label bisa menampilkan tanggal yang berbeda satu hari dari tanggal WIB sebenarnya. Hanya memengaruhi TEKS LABEL, bukan data/filter/perhitungan.
- **Rekomendasi:** Ganti ke pola Jakarta yang konsisten dengan modul lain.
- **Release blocker:** Tidak

### SEC-12 — Tidak ada unique index level-DB untuk `olsera_financial_ledger_entries`
- **Severity:** Informational
- **File:baris:** `lib/mongodb.ts:585-588` (createIndexes untuk koleksi ini tidak termasuk unique index)
- **Bukti teknis:** Idempotensi upsert bergantung SEPENUHNYA pada `_id` deterministik (`ledgerEntryId`, `lib/olsera-financial-store.ts:44`) tanpa unique index tambahan sebagai jaring pengaman kedua.
- **Skenario dampak:** Bila suatu saat logika pembuatan `_id` berubah dan menjadi tidak deterministik (bug masa depan), duplikasi entry ledger tidak akan terdeteksi oleh DB (karena tidak ada constraint tambahan selain `_id` bawaan).
- **Rekomendasi:** Opsional — tambahkan unique index komposit sebagai pertahanan berlapis.
- **Release blocker:** Tidak

---

### Confirmed-Safe / False-Positive-Checked (dicek eksplisit, TIDAK ada temuan)

| Area | Hasil |
| --- | --- |
| `dangerouslySetInnerHTML` (`app/layout.tsx:46`) | String statis hardcoded (theme bootstrap script), tidak ada interpolasi variabel — **aman**. |
| `javascript:` URL / `<a href={var}>` dinamis | Tidak ditemukan pola URL dinamis dari variabel di `app/**`/`components/**`; seluruh `window.location.href =` memakai literal `"/login"`. |
| Token/secret di client bundle | Tidak ada `"use client"` file yang mereferensikan `process.env.OLSERA_*`/`MONGODB_*`/`AYO_*`. Hanya `NEXT_PUBLIC_APP_URL` (bukan credential) dipakai di `lib/auth.ts:44` (server-side). |
| `localStorage`/`sessionStorage` | Hanya menyimpan preferensi tema/mode UI, tidak ada token/session data. |
| `console.log` di client component | Tidak ditemukan satu pun di file `"use client"`. |
| Filename export (path traversal/header injection) | Seluruh nama file export dibangun dari enum tetap + tanggal yang sudah divalidasi regex `^\d{4}-\d{2}-\d{2}$` atau `validatePeriod()` — tidak ada input mentah klien yang mencapai filename. |
| Authorization pada seluruh export route | Semua route export (`app/api/olsera/export*`, `app/api/olsera/financial/export/**`, `app/api/olsera/inventory/export/**`, `app/api/transactions/export/**`) memanggil `requireModule(...)` atau `guard()` sebelum menghasilkan file — tidak ada yang lolos tanpa autentikasi. |
| Cross-store parameter di export | Tidak ada route export yang menerima `storeId` dari klien — store scope selalu tetap dari server config. |
| Empty catch block (`catch {}`) | Nol kecocokan di `lib/**`/`app/**` (di luar test). |
| Snapshot laporan keuangan/inventori tetap terbaca saat token Olsera live kedaluwarsa | Dikonfirmasi: route baca (`app/api/olsera/financial/snapshot/route.ts`, `app/api/olsera/inventory/products/route.ts`, dll) HANYA mengimpor modul MongoDB (`lib/*-store.ts`), TIDAK mengimpor client Olsera live — dashboard tetap tampil, hanya tombol sync yang gagal. |
| Distributed lock cron (Sales/Inventory/Financial baru + tombol manual "Sync Semua Olsera") | Memakai lock MongoDB yang SAMA (`lib/olsera-cron-lock.ts`, atomic `findOneAndUpdate` + TTL `lockedUntil`), dilepas di blok `finally` pada ketiga cron baru. |
| Idempotensi write sync (Sales/Inventory/Financial) | Seluruh write pakai `updateOne`/`bulkWrite` dengan `upsert:true` pada `_id` deterministik — retry aman, tidak menghasilkan duplikat. Tidak ada `session.startTransaction()` di codebase, tapi tidak diperlukan karena pola upsert idempoten ini. |
| Pagination (`page`/`limit`) | Divalidasi & di-clamp (`Math.max(1,...)`, `Math.min(MAX_LIMIT,...)`) di route yang memakainya (`snapshot/ledger`, `transactions`) — nilai negatif/nol/absurd tidak bisa mencapai query. |
| Rounding/precision keuangan | `Math.round()` hanya dipakai sekali di titik akhir tampilan/format, tidak ada akumulasi pembulatan berulang. |
| Stale token Olsera | Cache token dicek terhadap `expiresAt` dengan margin aman 60 detik (`lib/olsera.ts`), 401 membersihkan cache & memberi pesan "connection-expired" yang jelas — tidak silent-fail. |
| Retry MongoDB tak terbatas | `withDatabaseRetry` (`lib/mongodb-errors.ts`) retry TEPAT SATU KALI (bukan loop), sesuai desain — dikonfirmasi test unit. |

---

## Dependency Audit

### `npm audit` (termasuk devDependencies)

| Package | Severity | Langsung/Transitive | Fix tersedia | Dapat dieksploitasi di AYOSERA? |
| --- | --- | --- | --- | --- |
| `tar` (via `@tailwindcss/oxide`) | **Critical** | Transitive (dev/build tool — Tailwind CSS oxide engine) | `npm audit fix` | **Tidak** — hanya diproses saat build lokal/CI, tidak pernah memproses arsip yang berasal dari input pengguna/network di runtime produksi. |
| `better-auth` (1.6.20, rentang rentan 1.1.3-1.6.21) | High | **Langsung** | `npm audit fix` → 1.6.25 | **Tidak untuk CVE spesifik ini** — advisory adalah account-takeover via magic-link/email-OTP; dikonfirmasi `lib/auth.ts:45-48` HANYA mengaktifkan `emailAndPassword`, tidak ada plugin magic-link/OTP dikonfigurasi. Tetap direkomendasikan upgrade (murah, tanpa breaking change terlihat). |
| `brace-expansion` | High | Transitive (glob-related dev tooling) | `npm audit fix` | Tidak — DoS lewat pola glob buatan penyerang, tidak ada jalur input pengguna yang mencapai pemrosesan glob di runtime. |
| `next` (15.5.19, rentang gabungan advisory sangat luas) | High | **Langsung** | `npm audit fix` → 15.5.22 (perlu verifikasi manual apakah SEMUA CVE bundel benar-benar tertutup di versi ini, karena rentang advisory mencakup hingga preview 16.3) | **Sebagian berpotensi relevan** — app ini pakai App Router API routes (bukan custom server, jadi SSRF-via-custom-server tidak relevan); tidak ditemukan penggunaan `next/image` dengan SVG eksternal tak tepercaya atau `rewrites()` dgn hostname dinamis di `next.config.ts` (hanya `outputFileTracingRoot`) — beberapa CVE dalam paket ini kemungkinan TIDAK applicable ke fitur yang dipakai, tapi tidak semua bisa dipastikan tanpa membaca detail tiap advisory satu-satu. Rekomendasi: upgrade ke 15.5.22 minimal, evaluasi 16.x terpisah (breaking change mayor). |
| `postcss` (transitive via `next`) | High | Transitive | Ikut fix `next`/`@tailwindcss/postcss` | Tidak — hanya diproses saat build (CSS), bukan runtime dengan input pengguna. |
| `sharp` (transitive via `next` Image Optimization) | High | Transitive | `npm audit fix` | Rendah — hanya relevan bila `next/image` dipakai dengan sumber gambar tak tepercaya; tidak ditemukan penggunaan upload gambar dari pengguna di app ini. |
| `uuid` (<11.1.1, via `exceljs`) | Moderate | Transitive | `npm audit fix --force` → **breaking**: akan menurunkan `exceljs` ke 3.4.0 (versi lama, berisiko regresi pada seluruh fitur export yang baru diverifikasi Phase 1/audit ini) | Rendah — bug adalah missing bounds-check saat buffer disediakan manual; `exceljs` kemungkinan tidak memanggil API tsb dengan cara rentan. **Rekomendasi: JANGAN `--force` fix ini** — risiko downgrade breaking lebih besar dari risiko CVE itu sendiri untuk pola pemakaian saat ini. |
| `xlsx` (SheetJS, versi apa pun) | High | **Langsung** | **Tidak ada fix tersedia** | Rendah — hanya dipakai di 2 skrip admin one-off (`scripts/bootstrap-monthly-snapshot-baseline.ts:56`, `scripts/generate-monthly-inventory-test-june.ts:49`), keduanya memproses file LOKAL dengan path tetap (`XLSX.readFile(BASELINE_PATH)`), BUKAN file upload dari pengguna/network. Prototype pollution & ReDoS pada `xlsx` memerlukan file `.xlsx` yang dibuat penyerang diproses oleh aplikasi — tidak terjadi di sini karena skrip ini dijalankan manual oleh admin terhadap file yang mereka pilih sendiri. Rekomendasi: pertimbangkan migrasi ke `exceljs` (sudah dipakai di seluruh export produksi) untuk menghilangkan dependency ini sepenuhnya di masa depan; TIDAK mendesak. |

**9 kerentanan total (2 moderate, 6 high, 1 critical)** dengan `npm audit`; **8 (2 moderate, 6 high)** dengan `npm audit --omit=dev` (tar/critical hanya muncul di devDependencies). **`npm audit fix` TIDAK dijalankan** sesuai batasan tugas.

### `npm outdated` (ringkasan)
`better-auth` 1.6.20→1.6.25, `next` 15.5.19→15.5.22 (patch aman) atau 16.2.12 (major, evaluasi terpisah), `mongodb` 7.3.0→7.5.0, `postcss` 8.5.15→8.5.23, serta beberapa `@radix-ui/*`/`lucide-react`/`recharts` minor version (risiko upgrade rendah, tidak berkaitan langsung dengan security). `typescript` 5.9.3→7.0.2 adalah major version jump — evaluasi terpisah, di luar cakupan urgensi security.

---

## Authentication and Authorization

- **Login/session:** `better-auth` dengan `emailAndPassword` saja (tidak ada magic-link/OTP) — sesi disimpan sebagai httpOnly cookie (`better-auth.session_token` / `__Secure-...` di production, dicek keberadaannya di `middleware.ts:3-11`). Middleware HANYA memeriksa keberadaan cookie (redirect cepat ke `/login` di sisi frontend); validasi SESUNGGUHNYA (signature, expiry, `disabled` flag) dilakukan server-side di `getCurrentUser()`/`requireUser()` (`lib/auth.ts:169-193`) — pola yang benar (client-side check hanya UX, bukan security boundary).
- **Otorisasi granular:** `requireSupervisor()`, `requireModule(module)`, `requireAnyModule(...)` (`lib/auth.ts:195-218`) dipanggil di setiap route API yang relevan (dikonfirmasi lewat pencarian pola auth di seluruh `app/api/**` — hanya endpoint auth itu sendiri, cron, dan webhook yang punya mekanisme berbeda, dijelaskan di bawah).
- **Privilege escalation:** Field `role`/`allowedModules` pada dokumen user diset `input: false` (`lib/auth.ts:56,61`) — TIDAK bisa diubah lewat body request sign-up/update-profile better-auth (mencegah user mendaftar sebagai supervisor sendiri). `normalizeRole()` (`lib/auth.ts:74-78`) hanya memberi role `"supervisor"` bila email PERSIS `SUPERVISOR_EMAIL` konstan — tidak bisa dipalsukan lewat data user biasa.
- **IDOR:** Tidak ditemukan endpoint yang menerima ID resource dari klien lalu mengembalikan data TANPA memvalidasi kepemilikan/scope — sebagian besar data bersifat single-tenant/organisasi-lebar (bukan per-user), sehingga IDOR klasik (akses data user lain) kurang relevan; SEC-07 (storeId) adalah kekhawatiran IDOR-adjacent PALING dekat, dan dinilai laten/tidak aktif.
- **Cron (khusus, 3 endpoint POST baru):** Ketiga (`sales`/`inventory`/`financial`) memvalidasi `Bearer CRON_SECRET` lewat `verifyCronSecret()` (`lib/olsera-cron-auth.ts`) — dikonfirmasi lewat test unit `test:cron-olsera-sales`, `test:cron-olsera-inventory`, `test:cron-olsera-financial` (semua PASS, termasuk skenario tanpa token/token salah/response tidak membocorkan secret). GET tidak diekspos oleh ketiga endpoint ini (hanya `export async function POST` terdefinisi — Next.js App Router otomatis menolak method lain dengan 405). Endpoint lama (`/api/cron/olsera-sync`, `/api/cron/sync`) memakai GET dan pola auth yang sama (SEC-04/SEC-05/SEC-06 di atas mencatat detail perbedaannya).
- **Cookie attributes:** Tidak ada override manual — mengandalkan default `better-auth`/`nextCookies()` plugin (umumnya `httpOnly`, `secure` di production, `sameSite: lax`). Tidak diverifikasi langsung terhadap dokumentasi versi `better-auth` yang terpasang; tidak ditemukan bukti misconfigurasi, tapi juga tidak diverifikasi eksplisit — dicatat sebagai **tidak diperiksa mendalam**, bukan "dikonfirmasi aman".
- **Logout/expiry:** `app/page.tsx` membersihkan cookie sesi basi saat menerima 401 dari API lalu redirect ke `/login` (dikutip dari komentar `middleware.ts:13-16` dan pola redirect di beberapa komponen panel) — tidak ditemukan bug logout.

---

## Data and MongoDB Security

- **Cross-store isolation:** Single-tenant by design; `storeId()` HANYA berasal dari `process.env.OLSERA_INTERNAL_STORE_ID` (`lib/olsera-financial-store.ts:34-38`), tidak pernah dari input klien di endpoint manapun (dikonfirmasi grep menyeluruh). Satu gap laten: SEC-07 (inventori tidak menambahkan klausa `storeId` eksplisit ke filter query, meski hanya ada satu store aktif saat ini).
- **NoSQL injection:** Tidak ditemukan route yang men-spread objek JSON mentah dari body/query langsung ke filter MongoDB — seluruh filter dibangun field-per-field dari nilai skalar yang sudah lewat `zod` (rute inventori) atau pengecekan tipe manual. Satu gap kecil: `lib/booking-query.ts` (`q`) tidak di-escape sebagai regex (SEC-09, Low, bukan operator injection).
- **Unbounded query:** Beberapa `.find().toArray()` tanpa `.limit()` ditemukan di `/api/transactions` (BUG-01, Medium — komentar kode salah), `/api/dashboard`, serta beberapa route export dengan rentang tanggal yang scope-nya dikontrol klien (`start`/`end` query param) — risiko Low-Medium tergantung ukuran data historis di masa depan.
- **Timeout & retry:** `MongoClient` diset `serverSelectionTimeoutMS: 5000` tapi TIDAK ada `socketTimeoutMS`/`connectTimeoutMS` eksplisit (`lib/mongodb.ts`). `withDatabaseRetry` retry TEPAT SATU KALI dengan jitter, dikonfirmasi test unit — bukan infinite loop.
- **HTTP 504 pada timeout:** Dikonfirmasi konsisten di endpoint finansial (`app/api/olsera/financial/snapshot/route.ts` — `Promise.race` 15 detik → 504) dan diuji test unit (`8) MongoDB timeout -> HTTP 504 terstruktur`). Endpoint lain (transactions/dashboard/inventori) TIDAK memakai pola timeout-race yang sama — error MongoDB apa pun di sana jatuh ke 500 generik, bukan 504 spesifik (Low, inkonsistensi bukan bug keamanan).
- **Duplicate write / atomicity:** Semua write sync (Sales/Inventory/Financial) pakai `updateOne`/`bulkWrite` dengan `upsert:true` pada `_id` deterministik — aman terhadap retry ganda. Tidak ada MongoDB transaction (`session.startTransaction`) dipakai di mana pun, tapi tidak diperlukan karena pola upsert idempoten di atas menghilangkan risiko partial-write yang biasanya dipecahkan transaction.
- **Unique index:** Ada pada koleksi kunci (`users.email`, `bookings.booking_id`, `olseraInventoryMonthlySnapshots` komposit, dll). `olseraFinancialLedgerEntries` tidak punya unique index tambahan di luar `_id` (SEC-12, Informational).
- **Snapshot tetap terbaca saat token Olsera live kedaluwarsa:** Dikonfirmasi — seluruh route baca dashboard (finansial, inventori) HANYA membaca MongoDB, tidak mengimpor client Olsera live sama sekali.

---

## Frontend and Export Security

- **XSS:** Tidak ditemukan vector aktif. Satu-satunya `dangerouslySetInnerHTML` adalah string statis (theme bootstrap). Tidak ada `<a href={var}>` atau `location.href` dinamis dari input eksternal.
- **Formula injection (PDF/Excel):** **SEC-01 — Confirmed High**, lihat Findings di atas. Berlaku untuk export Excel (`olsera-item-export.ts`, `olsera-category-export.ts`, dan kemungkinan file export lain dengan pola sama yang belum diverifikasi satu-per-satu — direkomendasikan audit lanjutan cepat ke `lib/olsera-labers-export.ts`, `lib/omzet-export.ts`, `lib/omset-kategori-export.ts`, `lib/olsera-inventory-monthly-export.ts` sebelum perbaikan). PDF (`pdf-lib`) TIDAK rentan pola yang sama (bukan spreadsheet, teks dirender apa adanya sebagai grafis, tidak dieksekusi).
- **Filename/path traversal:** Aman — seluruh nama file dibangun dari enum + tanggal tervalidasi regex.
- **Draft label (fitur Phase 1) tidak bisa dimanipulasi klien:** Dikonfirmasi — `isCurrentJakartaPeriod()`/`draftReportNotice()` dihitung SERVER-SIDE di titik generate PDF/Excel (`lib/olsera-financial-pdf.ts`, `lib/olsera-financial-excel.ts`, dipanggil dari route API), bukan dikirim dari client sebagai parameter yang bisa dipalsukan. Klien hanya memilih `period` (divalidasi `validatePeriod()` server-side); status draft SELALU dihitung ulang di server berdasarkan waktu server saat request, bukan flag dari client.
- **Export tidak mengambil data toko lain:** Dikonfirmasi — tidak ada route export yang menerima `storeId` dari klien.
- **Authorization sebelum export:** Dikonfirmasi seluruh route export memanggil guard sebelum generate file.

---

## Operational Security

- **Cron overlap:** Tiga cron baru (Sales/Inventory/Financial) + tombol manual "Sync Semua Olsera" berbagi SATU lock MongoDB (`lib/olsera-cron-lock.ts`) — dikonfirmasi lewat kode dan test unit (`double click tidak membuat dua proses`, `lock selalu dilepas walau salah satu tahap gagal`). **Endpoint cron LAMA (`/api/cron/olsera-sync`) TIDAK ikut serta dalam lock ini** — SEC-05, Known Operational Risk.
- **Retry behavior:** `withDatabaseRetry` (MongoDB) retry sekali dengan jitter. Fetch eksternal Olsera/AYO (kecuali modul finansial) TIDAK punya retry/timeout eksplisit di level fetch — SEC-08.
- **Partial failure / timeout:** Cron finansial/inventori memakai checkpoint bertahap (step-by-step, dilanjutkan panggilan cron berikutnya) — dikonfirmasi test unit (`partial-progress dapat dilanjutkan request berikutnya TANPA membuat run baru`). Desain ini tahan terhadap timeout serverless (maxDuration 300s) karena tidak mengandalkan satu request menyelesaikan seluruh sync.
- **MongoDB cold start:** Tidak ditemukan penanganan eksplisit untuk cold-start Atlas (connection pooling default MongoDB driver `+ srv` dipakai; `serverSelectionTimeoutMS: 5000` cukup singkat untuk gagal cepat & retry, bukan hang lama).
- **Stale token Olsera:** Ditangani dengan benar (cache + margin 60 detik + pembersihan cache saat 401).
- **Log sanitization:** Tidak ditemukan log yang mencetak nilai token/secret/URI asli (hanya metadata seperti `token_type`/`expires_in`). `error.message` mentah dikembalikan di beberapa response (SEC-10, Low) — bukan credential, tapi detail teknis yang idealnya disamakan dengan pola aman modul finansial.
- **Dua instance berjalan bersamaan:** Dicegah oleh distributed lock untuk 3 cron baru + tombol manual; TIDAK dicegah untuk endpoint lama (SEC-05).

---

## Test Results

| Perintah | Status |
| --- | --- |
| `npm run type-check` | **PASS** — 0 error |
| `npm run test:unit` (seluruh 21 suite, termasuk cron auth ×5, financial core/export, inventory, resolver, sync orchestrator, addon) | **PASS** — 0 fail |
| `npm run test:olsera-financial-export` (khusus) | **PASS** — 32/32 |
| `npm run test:olsera-financial` (core, khusus) | **PASS** — 16/16 |
| `npm run test:olsera-sync-orchestrator` (khusus) | **PASS** — 11/11 (termasuk "double click tidak membuat dua proses", "token Olsera expired menghasilkan status connection-expired") |
| `npm run test:olsera-resolver` (khusus) | **PASS** — 19/19 |
| `npm run build` | **PASS** — build produksi sukses, seluruh route ter-generate |
| `git diff --check` | **PASS** — tidak ada masalah whitespace/conflict marker |
| `git status --short` | 8 file modified (Phase 1 app+test), file baru dari audit sebelumnya (`scripts/audit-*.ts`, `tmp/`) — tidak ada perubahan tak terduga |

Cron authorization secara spesifik teruji lewat `test:cron-olsera-sales`, `test:cron-olsera-inventory`, `test:cron-olsera-financial`, `test:olsera-cron-lock`, dan `test:cron-olsera-sync` — SEMUA bagian dari `test:unit` dan PASS (dikonfirmasi via nama test yang muncul di output, mis. "401 bila header Authorization salah", "409 sync-in-progress bila lock sedang dipegang").

---

## Files Reviewed

`app/api/**/route.ts` (seluruh ~50 route), `middleware.ts`, `next.config.ts`, `vercel.json`, `lib/auth.ts`, `lib/mongodb.ts`, `lib/mongodb-errors.ts`, `lib/olsera-cron-auth.ts`, `lib/olsera-cron-lock.ts`, `lib/cron-olsera-{sync,sales,inventory,financial}.ts`, `lib/olsera.ts`, `lib/ayo.ts`, `lib/olsera-sync.ts`, `lib/olsera-inventory*.ts`, `lib/olsera-financial-*.ts`, `lib/booking-query.ts`, `lib/olsera-category-resolver.ts`, `lib/olsera-resolver-context.ts`, `lib/olsera-item-export.ts`, `lib/olsera-category-export.ts`, `lib/olsera-labers-export.ts` (parsial), `lib/omzet-export.ts`/`omset-kategori-export.ts` (parsial), `app/layout.tsx`, `app/page.tsx`, `app/login/page.tsx`, `components/olsera-financial-panel.tsx`, `components/olsera-inventory-panel.tsx`, `.env.example`, `.gitignore`, `package.json` (dependencies), hasil `npm audit`/`npm outdated`, seluruh suite `lib/*.test.ts` yang tercakup `npm run test:unit`.

---

## Recommended Fix Order

1. **Critical:** — (tidak ada Critical pada kode aplikasi; `tar` Critical hanya dev/build-time, tidak mendesak untuk runtime)
2. **High:**
   - SEC-01 — Formula injection export Excel (WAJIB sebelum rilis berikutnya)
   - Dependency High: `better-auth` → 1.6.25 (murah, tidak breaking), evaluasi `next` → 15.5.22 lalu rencana upgrade mayor terpisah
3. **Medium:**
   - BUG-01 — Query `/api/transactions` tanpa batas tanggal
   - SEC-03 — Header keamanan (clickjacking)
   - SEC-05 — Nonaktifkan/hapus endpoint cron lama tanpa lock (atau konfirmasi jadwal eksternal sudah dimatikan)
   - SEC-07 — Tambahkan filter `storeId` eksplisit di query inventori (pertahanan berlapis)
   - SEC-08 — Tambahkan timeout ke seluruh `fetch()` eksternal yang belum punya
   - SEC-02 — Hapus fallback secret hardcoded, fail-closed saat startup
4. **Low:**
   - SEC-04 (constant-time compare), SEC-06 (GET→POST cron lama), SEC-09 (escape regex booking search), SEC-10 (samakan error response), SEC-11 (label UTC→WIB), SEC-12 (unique index tambahan ledger)
5. **Hardening:**
   - Evaluasi migrasi/hapus dependency `xlsx` (SheetJS, tanpa fix tersedia) — pertimbangkan pindah sepenuhnya ke `exceljs` di 2 skrip yang masih memakainya
   - JANGAN jalankan `npm audit fix --force` untuk `uuid`/`exceljs` (breaking, downgrade `exceljs` ke versi lama)

---

## Final Conclusion

- **Aman commit (Phase 1 — fitur DRAFT laporan keuangan):** **Ya** — perubahan Phase 1 tidak menyentuh file yang mengandung SEC-01, lulus seluruh test, tidak mengubah angka laporan.
- **Aman push:** **Bersyarat** — aman untuk push Phase 1 SENDIRI (tidak memperkenalkan kerentanan baru), TAPI kebijakan rilis menyeluruh untuk deploy PRODUKSI BERIKUTNYA sebaiknya menunggu SEC-01 diperbaiki, karena itu adalah Confirmed High vulnerability yang sudah live.
- **Aman deploy (seluruh codebase saat ini):** **Tidak, sampai SEC-01 diperbaiki** — sesuai kriteria instruksi (Critical/High = release blocker).
- **Perbaikan WAJIB sebelum release:** SEC-01 (formula injection). Direkomendasikan sekaligus: dependency `better-auth` upgrade (murah, tidak breaking).
- **Perbaikan yang BOLEH dilakukan setelah release:** Seluruh temuan Medium/Low/Informational (BUG-01, SEC-02 sampai SEC-12), serta evaluasi upgrade `next`/dependency lain yang memerlukan pengujian regresi lebih menyeluruh.

**Tidak ada perbaikan, commit, push, atau deploy yang dilakukan pada audit ini — seluruhnya read-only sesuai instruksi.**
