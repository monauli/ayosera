# Perbandingan Sebelum vs Sesudah — Perbaikan Pipeline Snapshot Inventori Bulanan

Dibuat: 2026-07-27. **Tidak ada `--write`/rebuild/backfill dijalankan** — seluruh dokumen `olsera_inventory_monthly_snapshots` di production TIDAK BERUBAH sesi ini. Perbandingan di bawah adalah preview (read-only, `scripts/audit-inventory-snapshot-rebuild.ts`) apa yang AKAN berubah bila rebuild eksplisit dijalankan dengan kode baru.

## 1. Preview Snapshot — Entity 116138490 (BOLA PADEL ODEA ROSE)

| Periode | Status tersimpan (sebelum) | Status bila direbuild dgn kode baru | salesQty (tidak berubah) | Bukti mentah (sumAbsQty) |
| --- | --- | --- | --- | --- |
| 2026-02 | complete | **incomplete** | 0 | 30 |
| 2026-03 | complete | **incomplete** | 0 | 36 |
| 2026-04 | complete | **incomplete** | 0 | 51 |
| 2026-05 | complete (source=stockmovement-backward, bukan carry-forward — cap tidak berlaku) | complete (tetap, diklasifikasikan SOURCE_DATA_INCOMPLETE terpisah) | 12 | 55 |

**Penting**: `salesQty` TIDAK PERNAH diubah oleh perbaikan ini — hanya label `status` (dan `diagnostics`) untuk dokumen carry-forward yang kontradiktif dengan bukti independen. Ini murni perbaikan akurasi metadata, bukan perbaikan angka.

## 2. Movement Known Case 37 (storeId:null legacy)

**Tetap terbaca, tidak ada regresi.** `fetchRawSalesActivityByMonth` (baru, sesi ini) dan `loadInventoryMovementFindings` (Phase 5B, sesi sebelumnya) sama-sama memakai filter `storeId: {$in: [storeId, null]}` secara independen — konsisten satu sama lain.

## 3. Rerun Phase 5B Rekonsiliasi (Feb-Jul) — Verifikasi Tidak Ada Regresi

| Periode | Finding sebelum | Finding sesudah | Summary identik? |
| --- | --- | --- | --- |
| 2026-02 | 222 | 222 | Ya |
| 2026-03 | 299 | 299 | Ya |
| 2026-04 | 400 | 400 | Ya |
| 2026-05 | 311 | 311 | Ya |
| 2026-06 | 268 | 268 | Ya |
| 2026-07 | 259 | 259 | Ya |

**Kesimpulan**: TIDAK ADA perubahan pada hasil Phase 5B — sesuai ekspektasi, karena perbaikan sesi ini hanya menyentuh kode generator snapshot (`lib/olsera-inventory-monthly-snapshot-*.ts`), bukan modul rekonsiliasi, dan tidak ada rebuild/write yang mengubah dokumen snapshot yang dibaca Phase 5B. Juli tetap diperlakukan sebagai bulan draft (impact di-cap sesuai desain sesi sebelumnya). Tidak ada penurunan impact palsu, tidak ada finding valid yang hilang.

## 4. Kesimpulan

1. Perbaikan kode (carry-forward status + fetchRawSalesActivityByMonth) TERVERIFIKASI bekerja benar via preview read-only — akan menandai entity 116138490 (Feb-Apr) dan entity serupa (bila muncul di masa depan) sebagai `incomplete`, BUKAN menebak/mengubah angka.
2. TIDAK ADA regresi pada Modul Rekonsiliasi Phase 5B (hasil identik persis, diverifikasi ulang).
3. TIDAK ADA rebuild/backfill/write dijalankan — dokumen production tetap seperti semula, menunggu verifikasi manual alias sebelum rebuild eksplisit.
