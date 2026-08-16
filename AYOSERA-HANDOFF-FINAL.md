# AYOSERA — Audit Final Februari–Juli 2026

Tanggal: 16 Agustus 2026  

## Otomatisasi Financial Historical tanpa browser — 16 Agustus 2026

- Audit cron menemukan celah: query historical sebelumnya hanya mengambil log berstatus belum selesai, sehingga periode tanpa log (contoh Juni/Juli) tidak pernah menjadi target otomatis.
- Perbaikan pada `lib/cron-olsera-financial.ts` memperluas kandidat dari `FINANCIAL_BASELINE_PERIOD` sampai sebelum bulan berjalan. Periode kosong hanya dipilih setelah seluruh periode sebelumnya sukses; urutannya Mei checkpoint 76 → Juni → Juli, sementara Februari–April dilewati.
- Run `running` tetap di-resume; lock, deadline, telemetry, dan fase reconcile existing tetap digunakan. Tidak ada endpoint baru, hardcode akun/nominal, atau proses paralel.
- Regression baru mencakup pemilihan Mei cursor 76 dan periode kosong Juni/Juli berurutan.
- Verifikasi: cron Financial 56 lulus, suite Financial terkait lulus, typecheck lulus, scoped lint tanpa error, build lulus, dan `git diff --check` lulus.
- Belum dideploy atau dipicu ke production pada sesi ini. Status production tetap **Belum Bisa Dicek**.
Production: `https://ayosera.vercel.app`  
Ruang lingkup: read-only; tidak ada perubahan data, stok, lock, unlock, atau sync.

## Hasil

| Bulan | Category | Reconciliation | Neraca | Laba Rugi | Arus Kas | Buku Besar | Export Category | Export Financial | Export Omzet |
|---|---|---|---|---|---|---|---|---|---|
| Februari | Belum Bisa Dicek (sampel parsial 14/28 hari) | Cocok | Cocok | Cocok | Cocok | Selisih (53/85; akun 50000/51000) | Cocok (file dibaca) | Cocok (file dibaca) | Belum Bisa Dicek |
| Maret | Belum Bisa Dicek (timeout) | Belum Bisa Dicek | Cocok | Cocok | Cocok | Selisih (48/85) | Belum Bisa Dicek (isi belum dibaca) | Belum Bisa Dicek (isi belum dibaca) | Belum Bisa Dicek |
| April | Belum Bisa Dicek (timeout) | Belum Bisa Dicek | Cocok | Cocok | Cocok | Selisih (40/85) | Belum Bisa Dicek (isi belum dibaca) | Belum Bisa Dicek (isi belum dibaca) | Belum Bisa Dicek |
| Mei | Belum Bisa Dicek (timeout) | Belum Bisa Dicek | Cocok | Cocok | Cocok | Selisih (36/85) | Belum Bisa Dicek (isi belum dibaca) | Belum Bisa Dicek (isi belum dibaca) | Belum Bisa Dicek |
| Juni | Belum Bisa Dicek (timeout) | Belum Bisa Dicek | Cocok | Cocok | Cocok | Selisih (37/85) | Belum Bisa Dicek (isi belum dibaca) | Belum Bisa Dicek (isi belum dibaca) | Belum Bisa Dicek |
| Juli | Belum Bisa Dicek (timeout) | Belum Bisa Dicek | Cocok | Cocok | Cocok | Cocok (85/85) | Belum Bisa Dicek (isi belum dibaca) | Belum Bisa Dicek (isi belum dibaca) | Belum Bisa Dicek |

## Kesimpulan

**Bagian tertentu belum bisa dicek.**

- Keuangan level-total (Neraca, Laba Rugi, Arus Kas) cocok Februari–Juli dengan toleransi Rp1; delta utama tercatat 0.
- Buku Besar Februari–Juni memiliki selisih pada debit/kredit mentah, terutama akun 50000 dan 51000; saldo akhir tetap sama. Juli 85/85 cocok.
- Kategori belum terbukti penuh karena timeout Olsera; sampel Februari yang berhasil tidak menunjukkan selisih qty/nominal.
- Export Februari dibuka dan dibaca. Export Maret–Juli baru terbukti sebagai file XLSX valid; isi belum dibaca mendalam.
- Audit production lanjutan pada sesi ini berhenti di halaman login; tidak ada kredensial yang diminta atau diproses.

## Audit lanjutan non-inventori — 16 Agustus 2026

- Tidak ada pemeriksaan Inventori, perubahan stok, sync, lock, atau unlock.
- Trace lokal `normalizeLedgerDetailPayload` dan `bulkUpsertLedgerEntries` memetakan debit/kredit dari payload Olsera apa adanya; tidak ditemukan kode yang menyalin debit menjadi kredit atau sebaliknya. Karena payload production akun 50000/51000 tidak tersedia pada sesi ini, penyebab akhir tetap **Belum Bisa Dicek** dan tidak ada koreksi angka.
- Rekonsiliasi Omzet dan aturan toleransi Rp1 tetap dipertahankan. Fixture/test existing mencakup kasus April Rp739.999/Rp740.000; tidak ada perubahan angka.
- File nyata Maret–Juli tidak tersedia di workspace untuk dibuka dan dibaca. File yang ada hanya fixture/export periode lain; status Maret–Juli tetap **Belum Bisa Dicek**, bukan PASS berdasarkan signature XLSX.
- Production kembali ke `/login`; pemeriksaan kategori per bulan, export live, dan rekonsiliasi production tidak dapat dilanjutkan tanpa sesi login manual.

## Bukti dan batasan

Rincian angka, request, timeout, akun, export, test, dan commit ada di `AYOSERA-HANDOFF-LATEST.md`, terutama entri audit production 16 Agustus 2026. Status `Belum Bisa Dicek` berarti data tidak cukup untuk menyatakan Cocok atau Selisih; tidak ada angka yang ditebak.

## Investigasi Buku Besar 50000/51000 — 16 Agustus 2026

- Tidak ada perubahan Financial, Inventori, stok, lock, Kategori, atau production write.
- Trace lokal membuktikan `normalizeLedgerDetailPayload` membaca `fdebit` dan `fcredit` masing-masing, mengecualikan baris `Saldo Awal` dari total mutasi, dan `bulkUpsertLedgerEntries` menyimpan kedua field tanpa aturan khusus akun. Jalur export membaca ledger tersimpan yang sama.
- Seluruh suite Financial lulus: core 29, response 15, export 49, sync 1, DI 8, period-state 18, reconciliation-integrity 8, integrity-fix 15, hardening 3, auth-guard 8, time-budget 9, cron 55.
- Typecheck, build dengan Mongo proses-only, dan diff check lulus. Lint tetap gagal pada baseline `no-explicit-any` yang sudah ada.
- Penyebab akun 50000/51000 belum dapat dibuktikan tanpa payload resmi Olsera dan data tersimpan production untuk Februari–Juni. Tidak ada pembalikan, normalisasi khusus akun, atau koreksi angka yang dibuat.
- Satu kebutuhan akses tersisa: sesi production yang sudah login atau payload read-only resmi untuk akun 50000/51000 Februari–Juni, agar perbandingan per transaksi dan read-back dapat dilakukan.
- Tidak ada commit/push/deploy karena belum ada fix yang terbukti aman.

## Fix Buku Besar Februari — workbook Olsera dan backup AYOSERA — 16 Agustus 2026

- `tmp/fixtures/ledger_1_16Aug2026.xlsx` dibuka penuh: 1 sheet `ledger`, 5.856 baris. Baris target berada pada `2026-02-03` sampai `2026-02-28`.
- `tmp/fixtures/Ledger_Summary11101_1_Feb2026.xlsx` dibuka penuh: 1 sheet `ledger`, 86 baris, 85 akun. Tidak ada kolom periode; isinya konsisten dengan detail Februari.
- Backup AYOSERA menunjukkan sync Februari masih `running`, fase `ledger-details`, checkpoint akun 16; fase `reconcile` belum dijalankan.

### Angka sebelum perbaikan

| Akun | Sumber | Debit | Kredit | Saldo akhir | Transaksi |
|---|---|---:|---:|---:|---:|
| 50000 | Olsera detail | Rp21.890.500 | Rp21.890.500 | Rp0 | 8 |
| 50000 | Olsera summary workbook | Rp21.890.500 | -Rp21.890.500 | Rp0 | — |
| 50000 | AYOSERA detail | Rp21.890.500 | Rp21.890.500 | netto Rp0 | 8 |
| 50000 | AYOSERA summary tersimpan | Rp0 | Rp21.890.500 | -Rp21.890.500 | — |
| 51000 | Olsera detail | Rp20.614.923,86 | Rp20.614.923,86 | Rp0 | 896 |
| 51000 | Olsera summary workbook | Rp20.614.923,86 | -Rp20.614.923,86 | Rp0 | — |
| 51000 | AYOSERA detail | Rp20.614.923,86 | Rp20.614.923,86 | netto Rp0 | 896 |
| 51000 | AYOSERA summary tersimpan | Rp20.614.924 | Rp1.275.576 | Rp21.890.500 | — |

### Penyebab dan perubahan

- Detail AYOSERA memuat transaksi Februari yang sama dengan workbook Olsera, termasuk jurnal tutup buku `CL26040700000589`; tidak ditemukan transaksi ganda atau hilang pada dua akun target.
- Sync berhenti sebelum `reconcile`, sehingga summary lama tidak disamakan dengan detail.
- Fungsi rekonsiliasi sebelumnya hanya memperbarui debit/kredit, bukan saldo akhir. Kini saldo dihitung umum sebagai `saldo awal + debit - kredit`; tanpa saldo awal, saldo adalah netto mutasi.
- Tidak ada hardcode akun/periode/nominal dan payload Olsera tidak diubah. Inventori, Kategori, stok, dan lock tidak disentuh.
- Hasil lokal setelah rekonsiliasi: 50000 `Rp21.890.500 / Rp21.890.500 / saldo Rp0`; 51000 `Rp20.614.923,86 / Rp20.614.923,86 / saldo Rp0`.

### Verifikasi

- Regression tests baru mencakup akun 50000/51000 tanpa saldo awal dan akun dengan saldo awal.
- Financial tests: PASS — core 31, response 15, export 49, sync 1, DI 8, period-state 18, reconciliation-integrity 8, integrity-fix 15, hardening 3, auth-guard 8, time-budget 9, cron 55.
- Typecheck, build dengan Mongo proses-only, dan `git diff --check`: PASS.
- Full lint: FAIL pada baseline repository `@typescript-eslint/no-explicit-any`; tidak ada indikasi error baru dari perubahan ini.
- Commit/push: `754540f` (`fix: reconcile financial ledger closing balances`) pushed ke `origin/main`.
- Build production Vercel terdeteksi melalui HTTP `200` dan header server Vercel setelah push; status dashboard deployment `Ready` dan read-back data Financial belum dapat diverifikasi tanpa sesi login.
- Production read-back/refresh Februari belum dilakukan. Satu kebutuhan akses: sesi production login atau jalur Financial read-only untuk melanjutkan checkpoint Februari sampai fase `reconcile`.
- Status akhir: **Deploy berhasil tetapi refresh/read-back belum selesai**.

## Audit Buku Besar Februari–Juli berbasis fixture resmi — 16 Agustus 2026

- Enam workbook detail dan enam workbook ringkasan dibuka penuh. Masing-masing hanya memiliki sheet `ledger`, seluruh ringkasan berisi 85 akun, dan tanggal detail hanya berada pada bulan yang sesuai.
- Akun 50000 dan 51000 pada ringkasan resmi cocok dengan agregasi detail untuk Februari–Juli dengan toleransi Rp1. Kredit ringkasan memakai konvensi nilai negatif; detail memakai nilai transaksi, sehingga perbandingan menggunakan nilai absolut kredit.
- Rekap transaksi resmi akun target:

| Bulan | 50000 transaksi | 50000 debit/kredit | 51000 transaksi | 51000 debit/kredit |
|---|---:|---:|---:|---:|
| Februari | 8 | Rp21.890.500 / Rp21.890.500 | 896 | Rp20.614.923,86 / Rp20.614.923,86 |
| Maret | 8 | Rp27.085.081 / Rp27.085.081 | 1.327 | Rp11.724.102,75 / Rp11.724.102,75 |
| April | 8 | Rp14.472.500 / Rp14.472.500 | 1.860 | Rp18.733.211,98 / Rp18.733.211,98 |
| Mei | 7 | Rp16.972.000 / Rp16.972.000 | 2.125 | Rp17.790.602,23 / Rp17.790.602,23 |
| Juni | 12 | Rp16.832.588 / Rp16.832.588 | 2.039 | Rp17.149.646,53 / Rp17.149.646,53 |
| Juli | 10 | Rp29.175.802 / Rp0 | 1.916 | Rp19.114.065,35 / Rp29.175.802 |

- Audit backup AYOSERA: Februari sync masih berhenti di `ledger-details` akun 16 dan belum reconcile. Maret–Juni berstatus completed pada backup, tetapi snapshot Juni/Juli tidak sama dengan fixture resmi; Juni menunjukkan data target berulang dan Juli memakai data lama. Ini bukti snapshot perlu direfresh, bukan alasan untuk mengubah angka manual.
- Tidak ditemukan kebutuhan perubahan kode tambahan. Fix umum pada commit `90e9cac` menghitung saldo sebagai `saldo awal + debit - kredit` (atau debit-kredit tanpa saldo awal), mengecualikan opening row dari mutasi, dan dipakai lintas akun/periode.
- Tidak ada Inventori, stok Olsera, Kategori Penjualan, lock/unlock, atau payload sumber yang diubah.
- Production refresh/read-back belum tersedia karena sesi production belum login. Status tidak boleh disebut PASS. Kebutuhan akses tersisa tepat satu: sesi production yang sudah login untuk menjalankan fase reconcile/rebuild Financial resmi dan membaca kembali Februari–Juli.
- Commit perbaikan yang sudah dipush: `90e9cac fix: reconcile financial ledger closing balances`. Tidak ada commit kode tambahan atau audit Maret yang dibuat.

## Finalisasi production Financial — 16 Agustus 2026

- Commit `90e9cac` dan `8fc7e4e` tersedia di `main`. Endpoint production merespons redirect `307` dari Vercel; ini membuktikan deployment reachable, bukan read-back Financial.
- Sesi browser belum dapat mengontrol tab production yang baru dibuka. Tidak ada kredensial yang diminta atau diproses.
- Tidak ada refresh, reconcile, export, atau write production yang dijalankan. Status Februari–Juli tetap **Belum Bisa Dicek** untuk production.
- Kebutuhan akses tunggal: user login manual pada tab `https://ayosera.vercel.app/login` yang dapat dikontrol, lalu proses Financial resmi dan read-back Februari–Juli dapat dilanjutkan.

## Production refresh Financial Februari–Juli — 16 Agustus 2026

- Login production berhasil melalui sesi browser yang diberikan user.
- Februari selesai: `85/85 akun`, `5.862 baris`, fase rekonsiliasi selesai. Read-back akun 50000 menunjukkan 8 baris, pergerakan Rp0, saldo akhir Rp0. Akun 51000 menunjukkan 896 baris, pergerakan Rp0; saldo akhir ter-render Rp0.
- Maret selesai: `85 akun diproses` setelah melanjutkan checkpoint yang sempat terputus.
- April selesai: `85 akun diproses`.
- Mei masih berjalan pada checkpoint `76/85 akun`, `13.397 baris` saat koneksi kontrol browser terputus. Juni dan Juli belum dijalankan.
- Saat percobaan awal pemilihan periode, UI mempertahankan periode Agustus dan satu sync Agustus terlanjur berjalan sampai selesai `85 akun`. Tidak ada modul Inventori, Kategori Penjualan, lock/unlock, atau angka manual yang disentuh; kejadian ini dicatat agar tidak dianggap sebagai refresh target Februari–Juli.
- Karena Mei belum selesai dan Juni–Juli belum diverifikasi, status production akhir: **Belum Bisa Dicek**. Tidak ada klaim export atau laporan keuangan production cocok untuk bulan yang belum dibaca kembali.
## Penutupan task tersisa dan pembatasan cron — 16 Agustus 2026

- Diagnostic subtotal Financial dihapus dari tampilan UI saja. Data diagnostic internal, payload, angka, dan jalur audit tetap dipertahankan.
- Cron Financial utama tetap diarahkan ke scope bulan berjalan Agustus; Mei, Juni, dan Juli tidak diproses ulang oleh route utama.
- Endpoint historical terpisah yang sempat dibuat pada commit `5164381` dihapus kembali karena aturan final melarang cron historical.
- Pemeriksaan lokal: Financial core 31/31, cron Financial 57/57, typecheck, scoped lint tanpa error, dan `git diff --check` lulus. Lint hanya menyisakan warning existing.
- Production read-back, export nyata Februari–Juli, kategori penuh, telemetry cron production, token lifetime, dan backup eksternal belum dapat dibuktikan pada sesi ini tanpa akses production terautentikasi. Tidak ada klaim PASS dan tidak ada data/Inventori/lock yang diubah.
- Backup bersih lokal dibuat dari `HEAD` pada `backup/ayosera-final-2026-08-16-r1.zip` (11.287.915 byte). Arsip diverifikasi tidak memuat `.env`, `node_modules`, `.next`, `tmp/fixtures`, file Playwright, atau audit user.
## Production read-back lima task — 16 Agustus 2026

| Task | Hasil | Status |
|---|---|---|
| Production | Dashboard terbuka melalui sesi login. Financial Mei, Juni, Juli tampil `Success`; Mei snapshot terakhir 16 Agu 15:06, Juni 15:24, Juli 15:28. Financial UI tidak lagi menampilkan diagnostic subtotal ambigu. | Sebagian Cocok |
| Export Financial Feb–Jul | Menu export tersedia dan daftar laporan mencakup 5 sheet; pembacaan file unduhan nyata seluruh Februari–Juli belum dapat diselesaikan dari sesi browser ini. | Belum Bisa Dicek |
| Kategori Feb–Jul | Halaman production `Success`; kontrol periode kategori tidak menerapkan perubahan melalui sesi ini, sehingga perbandingan penuh tidak boleh disimpulkan. | Belum Bisa Dicek |
| Cron production | Status checkpoint production terlihat, tetapi riwayat durasi/jumlah sukses-gagal/timeout cron-job.org tidak tersedia dari UI yang login. Tidak ada perubahan jadwal atau kode. | Belum Bisa Dicek |
| Token | Olsera Bearer Token tampil aktif, expiry 20/8/2026 (4 hari), sumber JWT expiry. AYO Mobile Token tersedia tetapi opaque tanpa metadata expiry resmi. Tidak ada refresh token yang dapat dibuktikan, sehingga tidak ada implementasi baru. | Cocok untuk metadata |

Financial level-total yang terbaca: Mei pendapatan Rp351.707.500, laba kotor Rp309.545.360,49, laba bersih Rp129.448.027,24, kas akhir Rp594.209.800,29, aset Rp2.519.025.675,61; Juni pendapatan Rp307.267.500, laba kotor Rp268.059.228,07, laba bersih Rp93.507.722,40, kas akhir Rp571.006.178,62, aset Rp2.444.579.021,01; Juli pendapatan Rp295.345.000, laba kotor Rp276.464.934,65, laba bersih Rp274.515.553,95, kas akhir Rp904.149.685,92, aset Rp2.783.647.376,96. Neraca seimbang pada ketiganya. Tidak ada sync, lock, unlock, atau perubahan Inventori.

Sisa task production: 3 kelompok — pembacaan export nyata Februari–Juli, audit kategori penuh Februari–Juli, dan telemetry cron production. Penyebabnya adalah kemampuan download/period control dan telemetry cron tidak tersedia dari sesi/browser yang aktif; tidak ada angka yang ditebak.
## Inventori Desember 2025 — Bootstrap Snapshot (2026-08-16)

- Perubahan kode: `ensureMonthlySnapshotChain` kini memiliki jalur snapshot langsung khusus `2025-12`; tidak mencari anchor 2026, tidak menulis Januari/Februari, dan tetap idempotent melalui repository snapshot existing.
- Bukti sumber: jalur `GET /api/open-api/v1/en/inventory/stockmovement` existing dengan pagination; opening memakai `beginning_qty`, closing memakai `sisa`, dan arus memakai field movement resmi. Endpoint ini tidak menyediakan komponen stock opname terpisah; `sum_outgoing_qty` diperlakukan sesuai kontrak existing sebagai arus keluar yang sudah menggabungkan koreksi Olsera.
- Tests: `npm run test:olsera-inventory-monthly` — 231 lulus; `npm run type-check` — lulus; scoped ESLint — lulus; `git diff --check` — lulus. Build compile lulus, tetapi page-data gagal karena Mongo URI lokal invalid (`MongoParseError`), masalah environment baseline.
- Commit/push: `1ee144b` pushed ke `origin/main`. Tidak ada perubahan Inventori Februari, lock, carry-forward Januari, atau cron historical.
- Production read-back setelah deploy: periode `2025-12` berstatus `Final`, 36 produk, 36 Stok Tidak Terjual, 0 Stok Terjual; UI menampilkan snapshot dan tombol lock tetap hanya tersedia, tidak dijalankan. Export Stock Opname dipicu dari UI, tetapi isi workbook unduhan belum dapat dibaca dari sesi browser.
- Status: **Data API Desember belum lengkap dan perlu bukti tambahan** — khususnya bukti stock opname terpisah dan pembacaan workbook export nyata. Closing Desember belum aman dinyatakan sebagai opening Januari.
- Verifikasi lanjutan 2026-08-16: workbook resmi `summary-2025-12-01__2025-12-31.xlsx` memiliki 1 sheet, 36 baris produk, 36 key unik, tanpa duplikat, dan seluruh formula closing cocok. Total: opening 0, incoming 2.294, retur 0, penjualan 0, keluar 0, opname 0, closing 2.294.
- Production read-back ulang: 36 baris snapshot production cocok dengan workbook pada seluruh kolom tersebut; UI menampilkan 36 produk dan nilai yang sama. `Stock opname Desember = 0` dan dicatat sebagai **Tidak Ada Stock Opname** (tahun 2025 memang tidak memiliki transaksi opname).
- Status final Desember: **Desember 2025 cocok dan siap menjadi opening Januari**. Carry-forward Januari belum dijalankan.
- Verifikasi pemilih periode 2026-08-16: perubahan lokal menambahkan `min="2025-12"` pada input month Inventori; tidak ada perubahan snapshot, data, lock, atau cron. Tests UI/monthly dan typecheck lulus; scoped lint tanpa error; build compile lulus namun page-data tetap gagal pada Mongo URI lokal invalid.
- Production read-back: Desember tetap `Final`, 36 produk, 0 terjual/36 tidak terjual, empat tab dan Export Inventori tersedia. Deployment yang terbaca belum memuat atribut minimum baru; deploy propagation masih perlu diverifikasi.
- Inventori Januari 2026: jalur rebuild khusus kini memakai closing Desember sebagai anchor dan mengabaikan snapshot Januari parsial lama; hanya `2026-01` yang ditulis, tanpa menyentuh Desember/Februari/lock/cron. Commit kode `f2b4551` + guard rebuild parsial `1c1f935`.
- Production read-back setelah export Januari: masih menampilkan 3 produk (`Stok Terjual 2`, `Stok Tidak Terjual 1`, `Stok Keseluruhan 3`), sehingga deployment production belum memuat hasil rebuild 36 produk. Export sudah dipicu melalui UI tetapi hasil production belum berubah.
- Tests: 232 inventory monthly lulus, typecheck/scoped lint/diff check lulus; build compile lulus namun page-data gagal karena Mongo URI lokal invalid.
- Status Januari: **Data Januari belum lengkap dan perlu bukti tambahan**. Jangan jadikan closing Januari sebagai opening Februari.
- Finalisasi production Januari 2026: deployment yang memuat `f2b4551` + `1c1f935` berhasil menjalankan rebuild melalui Export Inventori existing. Production read-back: 37 produk keseluruhan = 36 produk dari closing Desember + 1 produk baru Januari; 2 terjual, 35 tidak terjual, 37 keseluruhan, Riwayat Mutasi terbuka.
- Hasil seluruh baris production: 37 nama unik, opening 2.294, masuk 60, retur 2, penjualan 2, keluar 0, closing 2.354; 0 mismatch rumus `opening + masuk + retur - penjualan - keluar`. Produk Desember tanpa movement tetap terbawa; produk baru opening 0.
- Export Inventori Januari berhasil dipicu dan UI melaporkan `Export selesai.`. Isi biner workbook belum dapat dibaca langsung dari sesi browser, sehingga verifikasi file nyata masih terbatas pada status export dan kecocokan halaman.
- Januari tidak mengubah Desember/Februari, tidak lock, tidak mengubah stok Olsera, dan tidak membuat cron historical.
- Status Januari: **Januari 2026 cocok dan siap menjadi opening Februari**.
- Audit Februari lanjutan: workbook approved dan built-in source sama-sama 31 Terjual/48 Keseluruhan. Production saat ini masih 29 Terjual/19 Tidak Terjual/48 Keseluruhan. Dua penyebab terbukti adalah `BOLA PADEL ODEA ROSE` (production 66/0/66; approved 96/30/66) dan `YONEX SHORTS MEN # SM-J035-2906-RW1-S` (production 15/0/15; approved 24/9/15). Keduanya ada di universe 48 tetapi arus penjualan hilang dari snapshot production lama.
- Perbaikan aman: revision migrasi built-in dinaikkan ke `2026-02-final-corrections-v3`; export Februari memakai jalur migrasi approved terbaru dan tetap hanya menulis 2026-02. Commit `366e2a3`.
- Production export dipicu dan UI melaporkan selesai, tetapi read-back belum berubah dari 29/19/48; deployment belum menerapkan revision baru. Desember/Januari tetap tidak disentuh, tidak lock, tidak mengubah Olsera atau cron.
- Status Februari: **Februari 2026 masih memiliki selisih yang perlu diverifikasi**. Penyesuaian Historis yang dibutuhkan hanya pada dua produk di atas; target approved tetap 31/17/48.
- Percobaan penerapan Februari v3: `origin/main` memuat `366e2a3`, tetapi deployment/domain production belum dapat dibuktikan memakai revision tersebut. Export Februari melalui jalur existing gagal (`Gagal membuat export inventori.`), dan read-back tetap 29/19/48. Tidak ada migration success yang diklaim, tidak ada write manual, dan lock tetap tidak disentuh.
- Status: **Migration v3 belum berhasil diterapkan ke production**. Target tetap 31/17/48; dua produk yang menunggu perbaikan tetap ODEA ROSE dan YONEX SHORTS.

## Verifikasi final migration Februari v3 — 16 Agustus 2026

- `origin/main` memuat commit `3997a90`. SHA deployment Vercel aktif tidak tersedia dari UI production, sehingga tidak ditebak; perilaku production membuktikan jalur revision marker baru aktif.
- Pemanggilan pertama melalui Export Pergerakan Stok resmi berhasil dan memperbarui snapshot Februari: `Stok Terjual 31`, `Stok Tidak Terjual 17`, `Stok Keseluruhan 48`.
- Read-back produk: ODEA ROSE `96 / 30 / 66`; YONEX SHORTS `24 / 9 / 15`; Sniper Power Light Blue `2 / 1 / 1`; GRIP YONEX AC102 `0 / 60 / 60`; XPLO COMFORT tetap ada; ODEA RED tidak digabung.
- Pemanggilan kedua melalui jalur export resmi selesai tanpa perubahan angka; hasil tetap `31/17/48`, tanpa duplikat. Status marker `skipped` tidak ditampilkan oleh UI, sehingga hanya keberhasilan no-change yang dapat dibuktikan dari read-back.
- Rekonsiliasi Februari: `48/48 Cocok`, Berita Acara tidak diperlukan, tidak ada penyesuaian manual. Tombol Kunci Periode tersedia dan tidak diklik.
- Export resmi berhasil dibuat. Isi workbook biner tidak dapat dibaca ulang dari sesi browser ini; status export dicatat terpisah dari verifikasi halaman/server.
- Tests historis, inventory 232, typecheck, scoped lint, dan diff check lulus. Build compile lulus; page-data lokal tetap gagal karena Mongo URI invalid.
- Status akhir: **Februari 2026 cocok dan siap dikunci manual**. Tidak ada perubahan Desember/Januari/periode lain, Olsera, Financial, cron, atau lock.

## Rekonsiliasi Februari memakai pembanding terpisah — 16 Agustus 2026

- Commit `52d7fe8` menambahkan comparator read-only antara snapshot sistem Februari dan source approved `2026-02-final-corrections-v3`; source tidak membaca snapshot production atau Qty katalog saat ini.
- Perbandingan mencakup identitas productId/variantId/SKU serta opening, masuk, retur, penjualan, keluar, dan closing. Mismatch, identitas hilang, duplikat, atau source kosong tidak boleh berstatus Cocok; kondisi tersebut juga menahan lock.
- Production setelah deploy: 48 produk, `48/48 Cocok`, 0 Perlu Dicek, 0 Belum Diisi. BA tidak diperlukan. Tombol Kunci Periode tersedia dan tidak diklik.
- Export resmi berhasil dipicu, tetapi workbook biner belum berhasil ditangkap/dibaca; status export tetap **Belum Terbukti**.

## Audit fixture export dan katalog Februari — 16 Agustus 2026

- Seluruh `tmp/fixtures` diperiksa berdasarkan isi. File export production AYOSERA `Inventori-Februari-2026-production.xlsx` tidak tersedia. File katalog produk Olsera juga tidak tersedia.
- `Inventory ilegal.xlsx` memang memiliki sheet `February Terjual` (31 baris, 31 identitas unik, duplikat 0, rumus dasar lulus) dan `February Keseluruhan` (48 baris, 48 identitas unik, duplikat 0), tetapi workbook ini adalah workbook sumber multi-bulan, bukan bukti export production.
- Pada sheet Keseluruhan, dua nilai tidak cocok dengan approved v3: Sniper Power Light Blue memiliki balance file 2 (target 1) dan GRIP YONEX AC102 memiliki balance file 56 (target 60). Karena itu file tidak dinyatakan sebagai export production yang lulus.
- Audit katalog 48 produk tidak dapat dilakukan tanpa file katalog Olsera; tidak ada status aktif/terhapus yang ditebak.
- Tests Inventori, rekonsiliasi, BA/stock-opname, export, typecheck, dan diff check lulus. Tidak ada perubahan kode atau data dan Februari tetap tidak dikunci.
- Tests comparator, stock-opname/rekonsiliasi, 232 inventory, UI inventory, typecheck, scoped lint, dan diff check lulus. Build compile lulus; page-data lokal gagal karena Mongo URI invalid.
## Implementasi rebuild Inventori Maret 2026 — 16 Agustus 2026

- Diagnosis: guard `isTrustedHistorical` menghentikan refresh Maret dari closing Februari; production sebelumnya terbaca `25 terjual / 11 tidak terjual / 36 keseluruhan`.
- Commit `847d5eb` menambahkan jalur produksi khusus `2026-03` yang mengambil snapshot Februari sebagai anchor dan menjalankan `runForwardBackfillMonth` existing dengan pagination, matching, dan idempotence. Tidak ada hardcode angka atau produk.
- Tests monthly inventory (233), stock-opname (24), rekonsiliasi (84), lock UI (47), typecheck, scoped lint, dan diff check lulus. Build compile lulus; page-data lokal gagal karena Mongo URI lokal invalid.
- Commit sudah dipush ke `origin/main`. Export resmi Maret dipicu dan UI melaporkan selesai, tetapi read-back deployment yang tersedia masih `25/11/36`; deployment baru atau refresh Maret belum terbukti aktif.
- Tidak ada lock, perubahan Desember/Januari/Februari, perubahan stok Olsera, atau perubahan cron. Status: **Audit lokal selesai tetapi production belum terverifikasi**.
