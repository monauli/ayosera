# Perbandingan Dry-Run Phase 5B — Sebelum vs Sesudah Perbaikan (Feb–Jul 2026)

Dibuat: 2026-07-27. Sumber "sebelum": `tmp/reconciliation-phase5b-dryrun-2026-{02..07}.json` (hasil sebelum perbaikan sesi ini). Sumber "sesudah": `tmp/reconciliation-phase5b-rerun-2026-{02..07}.json` (hasil setelah 3 perbaikan: draft-period impact cap, storeId:null pada movement, requiresManualAdjustment Known Case 37). **Tidak ada `--write` dijalankan, tidak ada data sumber diubah.**

---

## 1. Ringkasan Per Bulan

| Periode | Total sebelum | Total sesudah | Δ Total | movement-null sebelum | movement-null sesudah | Δ ERROR (impact) | Δ WARNING (impact) | Δ INFO (impact) | Δ requiresManualAdjustment |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-02 | 192 | 222 | +30 | 0 | 30 | 0 | +30 | 0 | +30 |
| 2026-03 | 189 | 299 | +110 | 0 | 110 | 0 | +110 | 0 | +110 |
| 2026-04 | 218 | 400 | +182 | 0 | 182 | 0 | +182 | 0 | +182 |
| 2026-05 | 276 | 311 | +35 | 0 | 35 | 0 | +35 | 0 | +35 |
| 2026-06 | 266 | 268 | +2 | 0 | 2 | 0 | +2 | 0 | +2 |
| 2026-07 | 258 | 259 | +1 | 0 | 1 | **-96** | +1 | **+96** | +1 |

**Interpretasi:**
- Kenaikan total finding Feb–Jun (30/110/182/35/2) **sepenuhnya** berasal dari movement `productId null` yang SEKARANG terbaca (Perbaikan #2) — sebelumnya 0, sekarang sesuai jumlah movement `storeId:null` legacy per bulan.
- Juli: total finding nyaris tidak berubah (+1, satu movement legacy baru), TAPI **komposisi impact berubah drastis**: 96 finding yang sebelumnya ERROR sekarang INFO (Perbaikan #1 — draft-period impact cap).

## 2. Movement `productId null` (Perbaikan #2 — Verifikasi Angka 37)

| Periode | Sebelum | Sesudah |
| --- | --- | --- |
| 2026-02 | 0 | 30 |
| 2026-03 | 0 | 110 |
| 2026-04 | 0 | 182 |
| 2026-05 | 0 | 35 |
| 2026-06 | 0 | 2 |
| 2026-07 | 0 | 1 |
| **Total (6 bulan kalender penuh)** | **0** | **360** |

**Angka 37 (rentang asli 2026-05-01 s/d 2026-07-13) DIKONFIRMASI COCOK PERSIS** via query diagnostic langsung (`scripts/audit-reconciliation-inventory-null-product.ts`, lihat §3 laporan akhir) — 37 movement dalam rentang tanggal PERSIS tsb, seluruhnya `storeId: null`. Jumlah kalender-bulan-penuh Mei+Jun+Jul sesudah perbaikan (35+2+1=38) sedikit lebih besar dari 37 karena mencakup tanggal 14–31 Juli juga (di luar rentang audit asli yang berhenti di 13 Juli) — **selisih 1 ini WAJAR** (bukan indikasi salah), sesuai metodologi cakupan tanggal yang berbeda.

## 3. Mismatch Berulang `movement-qty:116138490:0` (Perbaikan #3 — TIDAK diubah kodenya)

| Periode | Sebelum | Sesudah | Berubah? |
| --- | --- | --- | --- |
| 2026-02 | MISMATCH/ERROR (expected 30, actual 0) | MISMATCH/ERROR (sama) | Tidak |
| 2026-03 | MISMATCH/ERROR (expected 36, actual 0) | MISMATCH/ERROR (sama) | Tidak |
| 2026-04 | MISMATCH/ERROR (expected 51, actual 0) | MISMATCH/ERROR (sama) | Tidak |
| 2026-05 | MISMATCH/ERROR (expected 55, actual 12) | MISMATCH/ERROR (sama) | Tidak |
| 2026-06 | MATCH/INFO (expected 46, actual 46) | MATCH/INFO (sama) | Tidak |
| 2026-07 | MISMATCH/ERROR (expected 8, actual 10) | MISMATCH/ERROR (sama) | Tidak |

**Sesuai investigasi**: root cause anomali ini adalah `salesQty` pada `olsera_inventory_monthly_snapshots` yang tercatat 0 (Feb–Apr) lalu bertahap "mengejar" (12 di Mei, 46=cocok persis di Jun, +2 di Jul) untuk SATU produk spesifik (productId 116138490) — pola ini adalah **DATA_SOURCE_INCOMPLETE di pipeline generate snapshot bulanan** (bukan bug rule/adapter rekonsiliasi). **Tidak ada kode yang diubah untuk kasus ini** — `expectedQty` TIDAK dimanipulasi, status/impact TETAP mencerminkan kondisi nyata. Direkomendasikan sebagai `DATA_SOURCE_INCOMPLETE`, perlu investigasi terpisah pada `lib/olsera-inventory-monthly-snapshot-core.ts`/proses backfill snapshot untuk productId ini secara spesifik.

## 4. Finding Juli yang Terkena Draft-Period Cap (Perbaikan #1)

| Reason | Jumlah finding di-cap |
| --- | --- |
| `missing-next-month-snapshot` (SNAPSHOT domain, Agustus belum ada) | 61 |
| `current-month` (INVENTORY domain, belum ada dokumen snapshot Juli sama sekali) | 35 |
| **Total di-cap (ERROR → INFO)** | **96** |

`summary.impactSummary` Juli: **sebelum** `{"INFO":144,"WARNING":3,"ERROR":111}` → **sesudah** `{"INFO":240,"WARNING":4,"ERROR":15}`. `highestImpact` TETAP `ERROR` (karena 15 finding MISMATCH nyata — lihat §5 — TIDAK di-cap, benar sesuai desain: bukan berasal dari boundary/incomplete).

**Verifikasi kunci**: 15 finding MISMATCH INVENTORY Juli **TIDAK ikut di-cap** — dikonfirmasi bahwa snapshot bulanan untuk ke-15 produk tsb sudah berstatus `"complete"` (bukan `"incomplete"`/`"boundary-only"`), sehingga selisihnya BUKAN sekadar artefak bulan berjalan dan tetap dilaporkan penuh sebagai ERROR — **status/confidence/requiresManualAdjustment finding-finding ini TIDAK berubah oleh perbaikan #1** (hanya `impact` yang bisa berubah, dan hanya bila benar-benar disebabkan bulan berjalan).

## 5. Ringkasan Impact/Confidence Per Bulan (Sesudah Perbaikan)

| Periode | impactSummary (INFO/WARNING/ERROR) | confidenceSummary (HIGH/MEDIUM/LOW) | highestImpact | overallConfidence |
| --- | --- | --- | --- | --- |
| 2026-02 | 162/38/22 | 184/32/6 | ERROR | LOW |
| 2026-03 | 156/121/22 | 178/111/10 | ERROR | LOW |
| 2026-04 | 176/196/28 | 204/183/13 | ERROR | LOW |
| 2026-05 | 225/47/39 | 264/36/11 | ERROR | LOW |
| 2026-06 | 226/6/36 | 262/3/3 | ERROR | LOW |
| 2026-07 | 240/4/15 | 255/1/3 | ERROR | LOW |

`overallConfidence` tetap LOW di semua bulan (didominasi 1 finding AMBIGUOUS/BUTUH_ADJUST_MANUAL per bulan yang memang confidence-nya LOW — sesuai desain "confidence gabungan = paling lemah").

---

## 6. Kesimpulan

1. **Perbaikan #1 (draft-period impact cap) bekerja sesuai desain** — 96 finding Juli turun dari ERROR ke INFO, HANYA untuk yang benar-benar disebabkan bulan berjalan (missing next-month snapshot / belum ada dokumen snapshot sama sekali), TIDAK menyentuh 15 MISMATCH nyata di bulan yang sama.
2. **Perbaikan #2 (storeId:null) berhasil menemukan 360 movement yang sebelumnya tidak terlihat sama sekali** — dikonfirmasi PERSIS 37 pada rentang tanggal asli 2026-05-01..07-13. Root cause: movement legacy tsb tidak pernah distempel `storeId` saat sync (bukan bug productId-detection).
3. **Anomali `movement-qty:116138490:0` TIDAK diubah** — terbukti masalah data (snapshot salesQty) bukan bug kode, sesuai instruksi untuk tidak memanipulasi `expectedQty`.
4. **Tidak ada status finding yang berubah secara palsu** — seluruh perbaikan HANYA menyentuh: (a) `impact` (untuk kasus draft-period yang terbukti), (b) visibilitas movement yang sebelumnya tersembunyi (bukan mengubah hasil evaluasinya), (c) `requiresManualAdjustment` untuk Known Case 37 (yang memang seharusnya true sejak awal).
