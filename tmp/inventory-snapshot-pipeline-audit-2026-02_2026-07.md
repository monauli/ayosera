# Audit Pipeline Snapshot Inventori Bulanan — Februari–Juli 2026

Dibuat: 2026-07-27. Read-only, storeId=324175. Sumber: `scripts/audit-inventory-snapshot-rebuild.ts` (scan penuh per bulan, union entity dari `olsera_inventory_monthly_snapshots` + `olsera_inventory_movements`), klasifikasi murni via `lib/inventory-snapshot-pipeline-audit-core.ts`. Output mentah per bulan: `tmp/inventory-snapshot-pipeline-scan-2026-{02..07}.json`. **Tidak ada `--write`/rebuild/backfill dijalankan — seluruh dokumen snapshot TIDAK berubah.**

## 1. Peta Pipeline (ringkas — detail lengkap di laporan akhir §2)

```
Katalog (olsera_inventory_products) + Alias (olsera_product_aliases)
        │  fetchMatchingContext() — lib/olsera-inventory-monthly-snapshot-store.ts
        ▼
Open API Olsera GET stockmovement (per bulan, per rentang tanggal)
        │  fetchStockMovementRange() — lib/olsera-inventory-stockmovement.ts
        ▼
attachMovementsToProducts() — cocokkan identity→SKU→nama→alias→prefix-generik
        │  lib/olsera-inventory-monthly-core.ts
        ▼
computeMonthlyStepBackward() / computeMonthlyStepForward() — MURNI, formula ledger
        │  lib/olsera-inventory-monthly-snapshot-core.ts
        ▼
olsera_inventory_monthly_snapshots (upsert by _id, idempotent)
```

Anchor rantai: Juni 2026 = baseline resmi (`doc export/INVENTORI.xlsx`, 60 produk fisik tervalidasi total persis). Mundur (Mei→Feb) via `backfillBackwardRange`; maju (Juli→sekarang) via `backfillForwardRange`. Entry point produksi: `scripts/backfill-monthly-snapshot.ts` (belum pernah dijalankan ulang sesi ini — read-only saja).

## 2. Rekap Klasifikasi Per Bulan

| Periode | Total entity | EXPECTED_NO_ACTION | BOUNDARY_CURRENT_MONTH | STALE_SNAPSHOT | SOURCE_DATA_INCOMPLETE | Lainnya |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-02 | 51 | 50 | 0 | 1 | 0 | 0 |
| 2026-03 | 54 | 53 | 0 | 1 | 0 | 0 |
| 2026-04 | 64 | 63 | 0 | 1 | 0 | 0 |
| 2026-05 | 98 | 97 | 0 | 0 | 1 | 0 |
| 2026-06 | 96 | 95 | 0 | 0 | 1 | 0 |
| 2026-07 | 96 | 50 | 45 | 1 | 0 | 0 |

**Catatan penting (koreksi klasifikasi awal):** Scan pertama (sebelum memperhitungkan `trackInventory`) sempat melaporkan 22–38 "STALE_SNAPSHOT" palsu per bulan Feb-Jun — SELURUHNYA terbukti barang **non-stok** (minuman kategori LABERS, SEWA RAKET, PICKLEBALL COURT FEE dengan `trackInventory:false` di katalog) yang **sengaja** tidak masuk rantai ledger bulanan walau tercatat di `olsera_inventory_movements`. Setelah `classifySnapshotEntity` diperbaiki untuk memeriksa `trackInventory`, seluruh entity ini benar terklasifikasi `EXPECTED_NO_ACTION`. Tabel di atas sudah mencerminkan versi terkoreksi.

## 3. Entity yang Butuh Perhatian (bukan EXPECTED_NO_ACTION/BOUNDARY_CURRENT_MONTH)

| Periode | productId | Nama | Klasifikasi | Diff | Root cause singkat |
| --- | --- | --- | --- | --- | --- |
| 02,03,04 | 116138490 | BOLA PADEL ODEA ROSE | STALE_SNAPSHOT | 30/36/51 | productId rename (106817649→116138490) tanpa alias — carry-forward, dokumen lama belum direbuild dgn kode baru |
| 05 | 116138490 | BOLA PADEL ODEA ROSE | SOURCE_DATA_INCOMPLETE | 43 | API sudah match (identity) tapi salesQty API (12) vs ledger independen (55) beda — API "mengejar" bertahap |
| 06 | 118420650 | YONEX SHORTS MEN duplicate | SOURCE_DATA_INCOMPLETE | -3 | Keterbatasan diagnostic script (belum resolusi alias saat agregasi read-only) — BUKAN bug pipeline produksi, sudah diverifikasi manual sebelumnya |
| 07 | 106743466 | YONEX MEN SOCKS | STALE_SNAPSHOT | 1 | Penjualan 3 hari sebelum audit, bulan masih berjalan — wajar |

**Hanya SATU entity (116138490) menunjukkan pola persisten di >1 bulan** — inilah `movement-qty:116138490:0` yang menjadi fokus audit. Tidak ditemukan produk/varian LAIN dengan pola serupa (carry-forward kontradiktif berulang) di seluruh 6 bulan.

## 4. Definisi Kategori & Hasil

- **BUG_PIPELINE**: 0 kasus. Tidak ada bug logika pipeline yang terbukti.
- **STALE_SNAPSHOT**: 4 kasus (semuanya terkait dokumen yang perlu rebuild eksplisit dgn kode yang sudah diperbaiki sesi ini).
- **SOURCE_DATA_INCOMPLETE**: 2 kasus (116138490 Mei, YONEX SHORTS Juni) — dua sumber data independen tidak sepakat, di luar kendali kode.
- **LEGACY_STORE_ID_NULL**: 0 kasus bulan ini (Known Case 37 sudah tertangani `fetchRawSalesActivityByMonth`).
- **PRODUCT_IDENTITY_AMBIGUOUS**: 0 kasus pada dokumen TERSIMPAN (baru muncul otomatis setelah rebuild eksplisit dijalankan untuk 116138490 Feb-Apr).
- **BOUNDARY_CURRENT_MONTH**: 45 kasus (Juli, bulan berjalan — wajar).
- **REQUIRES_MANUAL_ADJUSTMENT**: 0 kasus generik tambahan.
- **EXPECTED_NO_ACTION**: 408 dari total 459 entity-bulan (>95%).

## 5. Rekomendasi

1. **Kode**: sudah diperbaiki (`carryForwardStatusAndDiagnostic` di `lib/olsera-inventory-monthly-snapshot-core.ts`) — carry-forward kontradiktif otomatis ditandai `status:"incomplete"` pada rebuild berikutnya, tanpa menebak angka.
2. **Data (butuh persetujuan, TIDAK dilakukan sesi ini)**: verifikasi manual rename productId 106817649→116138490 (BOLA PADEL ODEA→ODEA ROSE), lalu tambahkan dokumen `olsera_product_aliases` bila terbukti benar.
3. **Rebuild eksplisit (TIDAK dijalankan sesi ini — write mode)**: setelah alias diverifikasi, jalankan `scripts/backfill-monthly-snapshot.ts` (kini otomatis memakai `fetchRawSalesActivityByMonth`) untuk Feb-Apr agar dokumen 116138490 tertandai `incomplete` dan/atau (bila alias sudah ada) langsung dihitung benar via stockmovement API.
4. **Tidak ada tindakan** diperlukan untuk 95%+ entity lain — sudah `EXPECTED_NO_ACTION` (baik karena cocok maupun karena memang barang non-stok).
