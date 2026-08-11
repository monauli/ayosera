# AYOSERA — Operations Checklist

Bahasa sederhana, untuk pengecekan rutin. Lihat `docs/AYOSERA-FINAL-HANDOVER.md` untuk detail teknis.

## Harian

- [ ] Cek halaman "Audit & Sinkronisasi" — pastikan tidak ada tanda merah/gagal.
- [ ] Bila ada masalah integrasi (AYO atau Olsera tidak sinkron), cek log sinkronisasi terbaru di sana sebelum eskalasi.

## Bulanan

- [ ] Cek snapshot inventory bulan berjalan sudah lengkap (tidak ada produk berstatus "incomplete" tanpa penjelasan).
- [ ] Cek snapshot financial bulan berjalan sudah lengkap.
- [ ] Cek rekonsiliasi omzet AYO vs Olsera bulan berjalan — selisih dalam toleransi wajar.
- [ ] Bila periode sudah diverifikasi dan disetujui, lakukan Finalisasi/Kunci Periode di halaman Rekonsiliasi.

## Saat Ada Insiden

**Mongo timeout / database tidak bisa diakses**
- Cek status MongoDB (Atlas dashboard atau environment yang dipakai).
- Cek environment variable `MONGODB_URI` masih benar di Vercel.
- Jangan lakukan write manual ke database sebelum penyebab jelas.

**Token Olsera kedaluwarsa / auth gagal**
- Cek `OLSERA_APP_ID` / `OLSERA_SECRET_KEY` di Vercel masih valid.
- Olsera token diperbarui otomatis oleh sistem selama credential dasar masih benar — bila tetap gagal, hubungi tim Olsera untuk konfirmasi credential.

**Masalah di sisi AYO (webhook tidak masuk, API AYO error)**
- Cek dashboard AYO untuk status API mereka.
- Cek log webhook masuk terakhir di sistem.
- Cron cadangan harian akan menarik ulang transaksi yang mungkin terlewat webhook (maks. 1x/hari di tier saat ini).

**Cron gagal jalan (sales/inventory/financial)**
- Cek dashboard cron-job.org untuk status run terakhir (sukses/gagal, durasi).
- Cek log sinkronisasi (`sync_logs` / `olsera_sync_log`) di database untuk detail error.
- Jangan menjalankan ulang backfill/rebuild manual sebelum tahu akar masalahnya — cek dulu dengan script read-only yang tersedia di `scripts/` (audit, bukan repair).

**Data tidak cocok antara Olsera/AYO dan sistem (data mismatch)**
- Jangan langsung melakukan perbaikan/tulis data.
- Jalankan audit read-only dulu untuk memastikan seberapa besar gap-nya dan sejak kapan.
- Laporkan temuan sebelum melakukan perbaikan data production.
