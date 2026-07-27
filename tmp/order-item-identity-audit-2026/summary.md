# Audit Read-Only — Identitas Produk olsera_order_items (Periode 2026-05-01 s/d 2026-07-13)

Dibuat otomatis: 2026-07-27T04:42:08.794Z — AUDIT READ-ONLY, tidak ada tulis ke MongoDB, tidak ada sync/backfill.

## 1. Konfirmasi jumlah baris

- Baris dalam periode order 2026-05-01..2026-07-13: **6271**
- Baris yang kehilangan productId dan/atau variantId dan/atau sku ("gapped"): **6271**
- Klaim awal: 6.271 baris — **TERKONFIRMASI, cocok persis**

## 2. Klasifikasi

| Klasifikasi | Jumlah |
| --- | --- |
| Exact Match | 5991 |
| Butuh Adjust Manual | 243 |
| Exact Product, Variant Ambiguous | 33 |
| Historical Product | 4 |

- **Exact Match**: 5991
- **Ambiguous** (Exact Product Variant Ambiguous + Butuh Adjust Manual): 276
- **Unresolved** (Product Missing + Duplicate Candidate): 0

## 3. Cakupan

- Order unik (orderNo): 4940
- Transaksi unik: 4940 (skema `olsera_order_items` tidak punya field `transactionId` terpisah — `orderNo` dipakai sebagai identitas transaksi)
- Nama produk unik: 83
- Total omzet (amount) baris terdampak: 378.514.500
- Total qty baris terdampak: 8.197

## 4. Dampak

### Omzet & kategori (export Omzet Kategori, Kategori Penjualan, Export Rincian/Item, LABERS)

Berdasarkan pembacaan kode (`lib/omzet-export.ts`, `lib/olsera-item-export.ts`, `lib/olsera-labers-export.ts`, `lib/olsera-category-export.ts`, `lib/omset-kategori-export.ts`):
- Total omzet/qty dihitung dari field `amount`/`qty` yang tersimpan LANGSUNG di baris `olsera_order_items` — **tidak bergantung** pada `productId`/`variantId`/`sku`. Field-field ini tetap ada & benar pada 6.271 baris tsb, sehingga **angka omzet TIDAK terdampak**.
- Kategori dihitung lewat `lib/olsera-category-resolver.ts` (`resolveItemCategory`) yang punya urutan fallback: originalCategoryName → productId → variantId → alias → SKU → barcode → nama exact → histori nama → unresolved. productId/variantId/sku HANYA salah satu dari banyak jalur; nama (`itemName`) & histori tetap tersedia untuk baris gapped ini.
- Dari data tersimpan (`categoryResolutionStatus`): **6271 dari 6271 baris** sudah punya status `resolved` (kategori aman apa adanya, sudah dihitung saat sync tanpa perlu backfill). **0 baris** berstatus TIDAK resolved — kategori baris ini masih "Tidak Diketahui"/butuh review, TERLEPAS dari audit identitas produk ini (lihat unresolved-items.xlsx & impact-analysis.xlsx untuk daftarnya).
- LABERS export (`lib/olsera-labers-export.ts`) memproyeksikan productId/variantId/sku tapi TIDAK memakainya dalam agregasi (hanya `resolvedCategoryName`/`amount`/`addonPrice`) — **tidak terdampak**.

**Kesimpulan omzet/kategori: AMAN**, dengan catatan 0 baris yang memang belum resolved (independen dari gap productId/variantId/sku ini, bukan disebabkan olehnya).

### Inventori / reconciliation per produk

- `lib/olsera-inventory.ts` membangun `olsera_inventory_movements` (source: sale) dari `olsera_order_items`, MEMBACA productId/variantId LANGSUNG dari baris tersimpan (`resolvedProductId` lalu `productId`/`variantId`), dan HANYA fallback ke pencocokan nama exact bila id tidak ada (`selectMovementProduct` di `lib/olsera-inventory-core.ts`).
- Untuk 6.271 baris gapped ini: **6234 baris** sudah punya dokumen movement DENGAN productId tertaut (mutasi stok tetap akurat — fallback pencocokan nama di `selectMovementProduct` berhasil, independen dari gap di order item), **37 baris** movement-nya ADA tapi `productId: null` (nama tidak cocok unik di katalog saat sync inventori — mutasi stok baris ini TIDAK tertaut ke produk manapun), dan **0 baris** BELUM punya dokumen movement sama sekali.
- **Kesimpulan inventori: TERDAMPAK untuk subset baris di atas** — reconciliation stok PER PRODUK untuk 37 baris (unmatched + belum ada movement) berisiko kurang akurat, sisanya (6234 baris) sudah tertaut benar meskipun order item-nya sendiri masih kehilangan productId/variantId/sku. Total qty/omzet keseluruhan tetap benar terlepas dari ini.

### Varian & LABERS

- Baris dengan klasifikasi **Exact Product, Variant Ambiguous** (33 baris) SENGAJA tidak diberi variantId — nama produk induk tidak cukup untuk memastikan varian yang benar bila produk punya >1 varian aktif. Ini murni masalah identitas produk (SKU/varian di katalog gudang), BUKAN masalah omzet.
- LABERS (bagi hasil) tidak memakai productId/variantId/sku — lihat di atas.

## 5. Rekomendasi

1. **Backfill otomatis HANYA untuk baris "Exact Match" (5991 baris)** — satu-satunya kelompok dengan pemetaan productId+variantId+sku 100% pasti dari katalog dan/atau histori yang konsisten.
2. **Historical Product (4 baris)**: backfill bisa dipertimbangkan HANYA setelah verifikasi manual bahwa produk tsb memang sudah nonaktif/dihapus dari katalog namun histori identitasnya tunggal & konsisten — bukan otomatis penuh, beri tanda "perlu konfirmasi admin katalog".
3. **Exact Product, Variant Ambiguous, Butuh Adjust Manual, Name Match Only, Product Missing, Duplicate Candidate — JANGAN dibackfill otomatis.** Perlu Adjust Manual oleh admin/kasir yang mengerti transaksi asli (cek struk asli / cross-check Olsera dashboard), terutama untuk produk multi-varian.
4. **Tidak perlu tindakan darurat pada omzet/kategori/LABERS** — sudah terbukti aman secara struktural (tidak bergantung pada field yang hilang).
5. **Perlu tindakan pada inventori**: baris dengan movement `unmatched`/`ambiguous-name` atau tanpa movement sebaiknya direview terpisah sebagai bagian dari audit stok, karena mempengaruhi akurasi kartu stok per produk.
6. Audit ini TIDAK melakukan backfill apa pun. Semua angka di atas berasal dari state MongoDB saat ini (read-only) dan kode yang berlaku saat ini (dibaca, tidak diubah).

## 6. Artefak

- `raw-evidence.json` — seluruh baris + kandidat mapping mentah, untuk verifikasi ulang.
- `affected-items.xlsx` — seluruh 6271 baris + klasifikasi.
- `exact-matches.xlsx` — subset Exact Match (kandidat backfill otomatis).
- `ambiguous-items.xlsx` — subset Exact Product Variant Ambiguous + Butuh Adjust Manual.
- `unresolved-items.xlsx` — subset Product Missing + Duplicate Candidate.
- `candidate-mapping.xlsx` — satu baris per kandidat pemetaan (katalog/alias/histori) per orderItemId.
- `impact-analysis.xlsx` — ringkasan angka dampak (tabel di atas dalam bentuk xlsx).
