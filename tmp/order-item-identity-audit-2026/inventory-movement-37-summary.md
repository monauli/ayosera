# Review Read-Only — 37 Inventory Movement dengan productId Null (source: sale)

Dibuat otomatis: 2026-07-27T04:58:21.955Z — AUDIT READ-ONLY. Tidak ada update/backfill/sync dijalankan.

## Ringkasan

- Total movement `source: "sale"` dengan `productId: null` dalam periode temuan (2026-05-01 s/d 2026-07-13): **37**
- Order unik (orderNo): **27**
- Nama item/produk unik: **9**
- Total qty (dari order item terkait): **50**
- Total nilai penjualan (amount, dari order item terkait): **7.800.000**
- Rentang tanggal: **2026-05-01 s/d 2026-06-24**

## Kandidat mapping (verifikasi independen terhadap katalog saat ini)

- Exact match independen (nama cocok tepat 1 kombinasi produk+varian di katalog): **0**
- Ambiguous independen (nama cocok >1 kombinasi produk+varian): **0**
- Tidak ada kandidat sama sekali (independen, tanpa alias juga): **33**

## Keterkaitan dengan audit Fase 2 (6.271 baris / 276 ambiguous)

- Seluruh 37 baris ini termasuk dalam 6.271 baris hasil audit identitas Fase 2? **YA — seluruhnya**
- Seluruh 37 baris ini termasuk dalam 276 baris "ambiguous" Fase 2 (Exact Product Variant Ambiguous + Butuh Adjust Manual)? **TIDAK SEMUA — 33 dari 37 baris ("COURT FEES - N", klasifikasi Exact Product Variant Ambiguous). 4 baris sisanya berklasifikasi "Historical Product" (nama "YONEX SHORTS MEN ...", produk tidak ada di katalog aktif tapi punya alias/histori — kategori TERPISAH dari 276 ambiguous, tapi SAMA-SAMA butuh konfirmasi manual sebelum backfill sesuai rekomendasi Fase 2).**

## Potensi dampak ke closingQty / reconciliation

- Movement dengan `productId: null` TIDAK ikut dihitung ke kartu stok/closingQty produk manapun (baik yang benar maupun salah) karena `productId` adalah kunci join utama snapshot bulanan (`olsera_inventory_monthly_snapshots`) dan konsistensi stok (`getInventoryConsistency`). Artinya: 37 baris ini **tidak mendistorsi stok produk yang SALAH** (tidak ada produk yang closingQty-nya jadi keliru akibat baris ini), tapi **qty penjualan sebesar 50 unit dari transaksi tsb TIDAK tercermin di kartu stok produk manapun** — closingQty produk terkait berpotensi terlihat LEBIH TINGGI dari kondisi fisik sebenarnya sebesar qty yang hilang ini, sampai baris ini dipetakan secara manual.
- Risiko ini BUKAN masalah baru dari Fase 1 (fitur DRAFT laporan keuangan) dan tidak memengaruhi modul laporan keuangan/omzet/kategori sama sekali.

## Batasan audit

- Audit ini murni READ-ONLY: tidak ada `updateOne`/`updateMany`/`bulkWrite`/`insertOne`/`deleteOne`/sync dijalankan.
- Tidak ada perbaikan data movement/order item yang dilakukan.
- Rekomendasi: perbaikan 37 baris ini menunggu keputusan manual yang sama dengan 276 baris ambiguous Fase 2 (butuh konfirmasi admin katalog/kasir untuk memastikan varian/produk yang benar sebelum backfill apa pun).
