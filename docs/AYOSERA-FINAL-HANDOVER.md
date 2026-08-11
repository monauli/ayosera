# AYOSERA — Final Handover (Phase 5A)

Dokumen ini untuk siapa saja yang meneruskan atau mengoperasikan AYOSERA, termasuk yang tidak membaca kode. Ditulis per 2026-08-12, commit HEAD `7be13b4` di branch `main`.

## 1. Status Sistem

Sistem berjalan dan tersinkronisasi. Ringkasan status per area:

| Area | Status |
| --- | --- |
| Sinkronisasi transaksi AYO | Berjalan (real-time via webhook + cron cadangan) |
| Sinkronisasi penjualan Olsera | Berjalan, Agustus 2026-08-01 s/d 08-12 sudah dicek ulang: 683 order = 683 order lokal, 900 item = 900 item lokal, selisih nominal Rp0 |
| Inventory Olsera (snapshot bulanan) | Berjalan. Perbaikan historis produk ODEA sudah selesai di production |
| Financial/Rekonsiliasi Omzet | Berjalan, sebagian masih perlu verifikasi manual UI (lihat Bagian 13) |
| Phase 3E (audit Agustus) | **CLOSED** — tidak ada gap tersisa |

## 2. Modul Utama

- **Dashboard transaksi AYO** — pemantauan transaksi real-time dari AYO.
- **Sinkronisasi Olsera** — penjualan (`olsera_order_items`), inventori bulanan (`olsera_inventory_monthly_snapshots`), dan data finansial.
- **Rekonsiliasi Omzet** — membandingkan omzet AYO vs Olsera per periode, dengan finalisasi, unggah Berita Acara (BA), dan penguncian periode.
- **Laporan finansial** — Buku Besar, ekspor Excel/PDF.
- **Audit & Sinkronisasi** — halaman untuk memicu dan memantau sinkronisasi manual/otomatis.

## 3. Integrasi

- **AYO API** — transaksi masuk via webhook (dengan verifikasi signature) dan cron cadangan harian.
- **Olsera Open API** — penjualan, stockmovement (inventori), dan data finansial ditarik terjadwal.
- Kredensial integrasi (`AYO_API_TOKEN`, `AYO_PRIVATE_KEY`, `OLSERA_APP_ID`, `OLSERA_SECRET_KEY`, dll.) disimpan sebagai environment variable di Vercel — **tidak pernah ada di repository**.

## 4. Cron (Jadwal Otomatis)

- **Sales (Olsera)**: setiap 10 menit (`*/10 * * * *`)
- **Inventory (Olsera)**: setiap jam pada menit `:25`
- **Financial (Olsera)**: setiap jam pada menit `:45`
- **AYO sync cadangan**: 1x/hari (batasan Vercel Hobby free tier untuk native Vercel Cron — lihat `NOTES-SYNC.md`)

Jadwal di atas dijalankan lewat layanan eksternal cron-job.org yang memanggil endpoint `/api/cron/olsera/{sales,inventory,financial}` dengan header `Authorization: Bearer <CRON_SECRET>`. **Durasi eksekusi nyata per run belum diverifikasi dari lingkungan development ini** — perlu dicek manual di dashboard cron-job.org (lihat checklist operasional).

## 5. Database Utama

MongoDB. Koleksi inti yang relevan untuk operasional:

- `ayo_transactions` — transaksi AYO
- `olsera_order_items` — item penjualan Olsera
- `olsera_inventory_monthly_snapshots` — snapshot inventori bulanan per produk
- `olsera_product_aliases` — pemetaan identitas produk lama→baru (lihat Bagian 7)
- `olsera_inventory_movements` — ledger mutasi (saat ini murni penjualan)
- `reconciliation_*` — data rekonsiliasi omzet per periode
- `sync_logs`, `olsera_sync_log`, `olsera_sync_state` — log & checkpoint sinkronisasi

## 6. Rekonsiliasi (AYO vs Olsera)

Membandingkan omzet AYO dan Olsera per periode (bulanan), dengan:

- Finalisasi periode (Reset Finalisasi)
- Unggah Berita Acara (BA) sebagai bukti selisih yang disetujui
- Toleransi selisih otomatis ±Rp1 untuk kasus pembulatan
- Penguncian periode (Kunci Periode) setelah verifikasi selesai

**Belum semua alur UI ini diverifikasi manual di production pada sesi ini** — lihat checklist Bagian 13.

## 7. Inventory

Snapshot bulanan dihitung per produk per periode (opening/incoming/return/sales/outgoing/closing), dengan dua arah:

- **Backward-fill**: dari anchor Juni 2026 mundur ke Februari
- **Forward-fill**: dari anchor Juni 2026 maju ke bulan berjalan

**Kasus ODEA (selesai, production)**: productId lama `106817649` ("BOLA PADEL ODEA") berubah menjadi productId baru `116138490` ("BOLA PADEL ODEA ROSE") di sisi Olsera. Alias terverifikasi (`confidence: verified`) sudah dibuat di `olsera_product_aliases`, dan histori penjualan bulanan sudah direbuild secara **scoped** (hanya productId ini, tidak menyentuh produk lain):

| Bulan | salesQty final |
| --- | --- |
| Februari 2026 | 30 |
| Maret 2026 | 36 |
| April 2026 | 51 |
| Mei 2026 | 55 |
| Juni 2026 | 46 (anchor, tidak berubah nilainya) |

Produk lain (Yonex `118420650`, ODEA RED `119043265`, dan seluruh katalog lain) dikonfirmasi **tidak berubah** sebelum/sesudah repair ini (dibandingkan byte-per-byte).

Fitur baru yang dipakai untuk repair ini (tersedia untuk kasus identitas-produk-berubah lain di masa depan):
- `scripts/backfill-monthly-snapshot.ts --product-id=<id>` — rebuild historis dibatasi ke satu produk saja.
- Fallback ledger historis: hanya aktif untuk alias `confidence: "verified"`, dan hanya menimpa salesQty bila ledger (`olsera_inventory_movements`) lebih besar dari nilai sumber lain — generik, tidak hardcode ke produk tertentu.

## 8. Financial

Laporan finansial (Buku Besar, dll.) ditarik dari data Olsera. Ekspor Excel/PDF tersedia. **Kolom Saldo pada Buku Besar Detail dan kelengkapannya di ekspor belum diverifikasi manual di UI production** — lihat checklist.

## 9. Monitoring

- `sync_logs` / `olsera_sync_log` mencatat setiap run sinkronisasi (sukses/gagal, jumlah data diproses).
- `data_gap_audit_runs` mencatat hasil audit mingguan (`/api/cron/integration-audit`).
- Tidak ada dashboard monitoring eksternal (Grafana dsb.) di project ini — pemantauan saat ini berbasis koleksi log di MongoDB dan halaman "Audit & Sinkronisasi" di aplikasi.

## 10. Security

- CI GitHub Actions aktif (`.github/workflows/ci.yml`): type-check, unit test, build wajib lulus; lint berjalan tapi belum blocking (baseline lint lama, lihat komentar di file CI).
- Tidak ada secret/credential yang ter-track di repository (diaudit ulang di sesi ini — lihat Bagian "Repository" di laporan Phase 5A).
- Autentikasi admin: JWT + Better Auth, role-based access.
- Endpoint cron dilindungi `CRON_SECRET` (header `Authorization: Bearer`).
- Webhook AYO diverifikasi signature — **status aktivasi penuh production perlu dicek**, jika masih ada blocker eksternal yang belum selesai, itu bukan hal baru dari sesi ini (lihat `tmp/security-audit-2026-07.md` untuk histori Phase 4).
- Upgrade dependency major yang sengaja ditunda (bukan kerentanan kritis terbuka) tidak dianggap isu keamanan aktif — sudah dikaji di Phase 4 sebelumnya.

## 11. Deployment

- Hosting: Vercel.
- Deploy otomatis dari branch `main` (push langsung memicu deploy production — **push HANYA dilakukan setelah approval eksplisit**).
- Environment variable dikelola di Vercel Dashboard, tidak pernah di repo.

## 12. Backup

Backup source project (tanpa `node_modules`, `.next`, `.git`, dan file `.env*`/secret) dibuat sebagai file ZIP terpisah, **tidak dikomit ke repository**. Lihat `docs/AYOSERA-BACKUP-MANIFEST.md` untuk nama file, isi, dan checksum backup terbaru.

## 13. Manual Verification Checklist (Production)

Item berikut **belum** diverifikasi secara manual di UI production pada sesi ini — jangan menganggap sudah selesai sampai dicek langsung:

### A. Rekonsiliasi Maret
- [ ] Reset Finalisasi berfungsi
- [ ] Upload BA berfungsi
- [ ] OCR membaca nominal Rp740.000 dengan benar
- [ ] Status menjadi COCOK
- [ ] Nominal final tampil Rp198.595.000
- [ ] Alasan tersimpan dengan benar
- [ ] Close/reopen periode tetap tersimpan setelah reload
- [ ] Jumlah history sesuai
- [ ] Preview BA bekerja
- [ ] Kunci Periode berfungsi setelah verifikasi selesai

### B. Rekonsiliasi April
- [ ] BA Rp740.000 (pengurangan) tersimpan
- [ ] Selisih sistem menunjukkan −Rp739.999
- [ ] Status COCOK (dalam toleransi ±Rp1)

### C. UI Umum
- [ ] Halaman Audit & Sinkronisasi — Dark Mode tampil benar
- [ ] Warning finansial — Light Mode tampil benar
- [ ] Header tidak terpotong di semua halaman terkait
- [ ] Tabel Transaksi AYO — kolom Nominal mudah ditemukan
- [ ] Halaman Rekonsiliasi — Light & Dark Mode keduanya benar
- [ ] File picker + nama file tampil dengan benar saat upload

### D. Buku Besar Detail
- [ ] Kolom Saldo tampil di tabel
- [ ] Ekspor Excel memiliki kolom Saldo
- [ ] Ekspor PDF memiliki kolom Saldo
- [ ] Akun/periode yang pernah dikomplain sebelumnya dicek ulang
- [ ] Total Debit dan Total Kredit tidak salah sama (bug lama yang harus dipastikan tidak berulang)

### E. Inventory
- [ ] Yonex — baris "duplicate" tampil sesuai ekspektasi
- [ ] ODEA ROSE (`116138490`) — histori Feb-Juni tampil di UI sesuai tabel Bagian 7
- [ ] ODEA RED (`119043265`) — tetap tampil terpisah, tidak tercampur dengan ODEA ROSE

### F. Cron
- [ ] Durasi eksekusi nyata tiap jadwal cron-job.org dicek manual di dashboard cron-job.org (tidak tersedia dari environment development ini)

## 14. Known Limitations

- Lint belum sepenuhnya bersih (baseline error/warning lama, non-blocking di CI — lihat komentar di `.github/workflows/ci.yml`).
- Beberapa upgrade dependency major sengaja ditunda (keputusan Phase 4, bukan bug terbuka).
- Vercel Hobby/free tier membatasi native Vercel Cron ke 1x/hari — jadwal lebih sering (sales/inventory/financial) berjalan lewat layanan eksternal cron-job.org, bukan Vercel Cron.
- Checklist manual UI di Bagian 13 belum dieksekusi penuh — jangan asumsikan "selesai" sebelum dicentang.

## 15. Recovery Notes

- **Kode**: restore dari Git (`origin/main`, commit HEAD tercatat di setiap laporan sesi) atau dari backup ZIP (lihat manifest, Bagian 12).
- **Database**: MongoDB — gunakan backup/snapshot database sendiri (di luar scope backup source code ini); dokumen ini tidak mencakup backup data produksi.
- **Environment variable**: harus di-input ulang manual dari penyimpanan aman tim (Vercel Dashboard atau password manager) — tidak pernah ada salinannya di backup source code maupun repository.
- **Jika terjadi insiden data mismatch pada inventory/reconciliation**: gunakan script read-only audit yang sudah ada di `scripts/` (mis. `audit-inventory-monthly-periods.ts`, `test-olsera-day-audit.ts`) untuk diagnosis sebelum melakukan write apa pun.
