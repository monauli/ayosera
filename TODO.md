# AYOSERA — Status Pengerjaan & Todo List Pencegahan

Dokumen ini mencatat seluruh pengerjaan yang telah diselesaikan, sisa tugas koordinasi eksternal, dan sistem pencegahan yang dibangun agar masalah selisih dan token kedaluwarsa tidak terulang kembali di masa depan.

---

## 1. Yang Sudah Selesai Dikerjakan (Done)

- [x] **Pemisahan Add-on Sewa Raket dari Revenue Lapangan di Dashboard** (Commit `bc146c5`)
  - Add-on raket kini dikurangkan dari pendapatan lapangan di Dashboard (Court 3 dipotong Rp550rb, Court 2 dipotong Rp300rb). Add-on tetap dilaporkan di export Excel.
- [x] **Perbaikan 27 Booking AYO & Kasus Rp99.000 (Langi 23 Okt)** (Commit `514d4d8`, `ed30768`)
  - 4 booking Langi 23 Okt dinaikkan dari Rp87.000 ke Rp99.000 per booking.
  - Booking Langi 18 Okt (Rp150rb) dan Semi 25 Okt (Rp50rb) yang sempat Rp0 karena terlambat bayar sudah tersinkron.
  - Seluruh 27 booking Oktober yang tertunda sudah berhasil diperbarui ke database.
- [x] **Sistem Rotating Backlog Sync AYO** (Commit `514d4d8`, `ed30768`)
  - Setiap cron berjalan (4x sehari), sistem otomatis mengaudit dan menarik ulang irisan 6 hari lampau secara bergilir (dari tanggal 1 bulan lalu sampai H-2) untuk booking dan payment events sekaligus.
- [x] **Sistem Rotating Backlog Audit Olsera** (Commit `2304220`)
  - Cron Olsera otomatis mengaudit 3 tanggal lampau per putaran. Jika ada order yang diedit/di-void belakangan di Olsera, sistem otomatis mendeteksi dan menarik ulang.
- [x] **Integritas Sewa Raket Sesuai Olsera**
  - Koreksi manual yang membingungkan dihapus; sistem AYOSERA mengikuti laporan riil Olsera apa adanya. Total Sewa Raket Oktober: Rp14.010.000 (345 qty).
- [x] **Rekonsiliasi Omzet Oktober Cocok 100% (Selisih Rp0)**
  - Court: Rp166.701.500 = Rp166.701.500.
  - Pickleball: Rp36.285.000 = Rp36.285.000.
  - Total selisih: **Rp0 (Cocok)**.
- [x] **Perbaruan Token Olsera Internal & Validasi Production**
  - Token baru berhasil dipasang dan lolos tes di server production. Sync Olsera Financial & Sales berjalan normal tanpa error 401.

---

## 2. Fitur Pencegahan Baru yang Dibangun Hari Ini (Done Today)

- [x] **Early-Warning Banner Token Kedaluwarsa di Dashboard Admin**
  - Dashboard sekarang otomatis menampilkan banner peringatan mencolok jika masa berlaku token Olsera tersisa ≤ 7 hari (`AKAN_KEDALUWARSA`) atau jika token mati (`KEDALUWARSA` / `UNAUTHORIZED`).
  - Dilengkapi tombol langsung *"Buka Status Integrasi"* untuk memeriksa status token tanpa menunggu sync macet.
- [x] **Transparansi Status Rekonsiliasi untuk Jurnal Penutup**
  - Menghilangkan kepanikan status `PERLU_DICEK` saat uang sudah cocok.
  - Jika selisih nominal Rp0 tetapi jurnal penutup (`CL...`) belum ada, pesan status secara jelas menyatakan:
    *"Nominal cocok (selisih Rp0). Menunggu tim akuntansi membuat jurnal tutup buku akun 40001 di Olsera sebelum periode dapat dikunci."*

---

## 3. Sisa yang Menunggu Pihak Eksternal (Pending Ribka & Tim)

- [ ] **Tutup Buku Oktober di Olsera (Tim Akuntansi Ribka):**
  - Membuat jurnal penutup (nomor transaksi berawalan `CL...`) untuk akun 40001 di Olsera.
  - Setelah dibuat, cron AYOSERA akan menariknya otomatis dan tombol **Kunci Periode** Oktober bisa diaktifkan.
- [ ] **Konfirmasi Angka Final ke Ribka:**
  - Court No 3: Rp37.262.000 (Rp37.812.000 kotor − add-on raket Rp550.000, sudah mencakup 2 booking baru +Rp198.000).
  - Padel: Total 4 court AYOSERA (Rp166.701.500) sudah persis sama dengan jurnal Olsera. Penyesuaian ada di file Excel Ribka.
  - Sewa Raket: Rp14.010.000 (sesuai Olsera).
- [ ] **Update `.env.local` di Laptop Developer (Opsional):**
  - Salin token baru dari Vercel ke variabel `OLSERA_INTERNAL_TOKEN` di `.env.local` jika ingin menjalankan sync keuangan langsung dari laptop.

---

## 4. Backlog Pencegahan Lanjutan (Future Ideas)

- [ ] Notifikasi webhook/email otomatis saat token tersisa < 3 hari.
- [ ] Dialog pembaruan token langsung dari antarmuka Web Admin (tanpa harus buka dashboard Vercel).
- [ ] Permohonan resmi ke pihak Olsera untuk membuka endpoint Laporan Keuangan di Open API resmi (menggunakan `app_id` & `secret_key` agar tidak memerlukan perpanjangan token 30 hari sekali).
