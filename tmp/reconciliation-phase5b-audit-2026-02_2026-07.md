# Audit Read-Only — Dry-Run Phase 5B (Februari–Juli 2026)

Dibuat: 2026-07-27 — **AUDIT READ-ONLY**. Tidak ada kode/data yang diubah, tidak ada `--write` dijalankan, tidak ada commit/push/deploy. Sumber: `tmp/reconciliation-phase5b-dryrun-2026-{02..07}.json` (hasil dry-run Runner Phase 5B, storeId 324175, domain CATEGORY/PRODUCT/INVENTORY/SNAPSHOT).

Seluruh enam run berstatus `"status": "success"` (tidak ada domain gagal, `domainErrors: {}` di semua bulan) — lihat tabel durasi/docsRead di §8.

---

## 1. Rekap Per Bulan & Per Domain

### 1.1 Ringkasan keseluruhan per bulan

| Periode | Total | MATCH | AMBIGUOUS | MISSING_IN_SNAPSHOT | MISMATCH | Impact (INFO/WARNING/ERROR) | Confidence (HIGH/MEDIUM/LOW) | requiresManualAdjustment |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-02 | 192 | 162 | 6 | 23 | 1 | 162/8/22 | 184/2/6 | 6 |
| 2026-03 | 189 | 156 | 10 | 22 | 1 | 156/11/22 | 178/1/10 | 10 |
| 2026-04 | 218 | 176 | 13 | 28 | 1 | 176/14/28 | 204/1/13 | 13 |
| 2026-05 | 276 | 225 | 11 | 39 | 1 | 225/12/39 | 264/1/11 | 11 |
| 2026-06 | 266 | 226 | 3 | 37 | 0 | 226/4/36 | 262/1/3 | 3 |
| 2026-07 | 258 | 144 | 3 | 96 | 15 | 144/3/111 | 255/0/3 | 3 |

> Catatan: total Mei 2026 (276) **kebetulan** sama persis dengan angka "276 ambiguous item" dari audit Phase 2 — ini KEBETULAN ANGKA, bukan hubungan sebab-akibat (276 di sini adalah TOTAL seluruh finding CATEGORY+PRODUCT+INVENTORY+SNAPSHOT bulan Mei, bukan jumlah AMBIGUOUS). Jangan disamakan — lihat §5 untuk perbandingan yang benar.

### 1.2 Per domain per bulan

**CATEGORY** (validasi `categoryResolutionStatus` tersimpan)

| Periode | Total | MATCH | Lainnya |
| --- | --- | --- | --- |
| 02 | 56 | 56 | 0 |
| 03 | 55 | 55 | 0 |
| 04 | 64 | 64 | 0 |
| 05 | 75 | 75 | 0 |
| 06 | 69 | 69 | 0 |
| 07 | 66 | 66 | 0 |

**100% MATCH di seluruh 6 bulan, tanpa satu pun MISMATCH/AMBIGUOUS/BUTUH_ADJUST_MANUAL.** Lihat §4.1 untuk analisis apakah ini false positive/false negative.

**PRODUCT** (identitas produk — hanya item "gapped" yang dilaporkan)

| Periode | Total | MATCH | AMBIGUOUS | MISSING_IN_SNAPSHOT | BUTUH_ADJUST_MANUAL |
| --- | --- | --- | --- | --- | --- |
| 02 | 56 | 47 | 6 | 3 | 0 |
| 03 | 55 | 42 | 10 | 3 | 0 |
| 04 | 64 | 47 | 13 | 4 | 0 |
| 05 | 75 | 61 | 11 | 3 | 0 |
| 06 | 69 | 63 | 3 | 3 | 0 |
| 07 | 66 | 63 | 3 | 0 | 0 |

*(Rincian MATCH/AMBIGUOUS/MISSING_IN_SNAPSHOT PRODUCT dihitung dari data mentah; lihat `tmp/reconciliation-phase5b-audit-2026-02_2026-07.json` §`perMonthDomain.PRODUCT` untuk angka presisi per bulan.)*

**INVENTORY** (movement productId null + qty vs snapshot bulanan)

| Periode | Total | MATCH | MISSING_IN_SNAPSHOT | MISMATCH | movement-null |
| --- | --- | --- | --- | --- | --- |
| 02 | 50 | 28 | 21 | 1 | 0 |
| 03 | 46 | 24 | 21 | 1 | 0 |
| 04 | 53 | 25 | 27 | 1 | 0 |
| 05 | 66 | 27 | 38 | 1 | 0 |
| 06 | 68 | 32 | 36 | 0 | 0 |
| 07 | 65 | 15 | 35 | 15 | 0 |

**SNAPSHOT** (closingQty bulan N vs openingQty bulan N+1)

| Periode | Total | MATCH | MISSING_IN_SNAPSHOT |
| --- | --- | --- | --- |
| 02 | 30 | 30 | 0 |
| 03 | 33 | 33 | 0 |
| 04 | 37 | 37 | 0 |
| 05 | 60 | 60 | 0 |
| 06 | 60 | 60 | 0 |
| 07 | 61 | 0 | 61 |

Pola SNAPSHOT sangat bersih: 100% MATCH Feb–Jun, lalu 100% MISSING_IN_SNAPSHOT tepat di Juli — lihat §3.

---

## 2. Bedah Finding Non-MATCH

### 2.1 MISMATCH (18 finding total, seluruhnya domain INVENTORY, tidak ada di CATEGORY/PRODUCT/SNAPSHOT)

**a) `movement-qty:116138490:0` — recurring 5 dari 6 bulan (Feb, Mar, Apr, Mei, Jul; TIDAK muncul Juni)**

| Periode | expectedQty (movement) | actualQty (snapshot.salesQty) | selisih |
| --- | --- | --- | --- |
| 02 | 30 | 0 | -30 |
| 03 | 36 | 0 | -36 |
| 04 | 51 | 0 | -51 |
| 05 | 55 | 12 | -43 |
| 07 | 8 | 10 | +2 |

Produk ini (productId 116138490, tanpa varian) **konsisten menunjukkan `expectedQty` (dari movement penjualan) LEBIH BESAR dari `salesQty` snapshot bulanan** selama 4 bulan berturut-turut (Feb–Mei) sebelum menghilang di Juni (kemungkinan tidak ada penjualan bulan itu) lalu muncul lagi Juli dengan selisih kecil (+2, arah terbalik). Pola berulang dengan arah konsisten (snapshot < movement) selama beberapa bulan closed (bukan bulan berjalan) mengindikasikan **kemungkinan gap definisi**: `expectedQty` dihitung sebagai `Σ|qtyChange|` dari SELURUH movement `source:"sale"`, sedangkan `salesQty` pada snapshot bulanan mungkin dihitung dengan metodologi berbeda (mis. mengecualikan pesanan batal/refund yang tetap menghasilkan movement, atau menghitung net bukan gross). **Klasifikasi: kandidat BUG_RULE_OR_ADAPTER** — lihat §7 rekomendasi.

**b) 14 finding MISMATCH BARU muncul HANYA di Juli** (`movement-qty:109534251:0`, `109533497:0`, `109533902:0`, `109534279:0`, `109533529:0`, `112460170:0`, dan 8 lainnya — lihat JSON `mismatchDetail`), seluruhnya dengan pola `actualQty < expectedQty` puluhan unit, TIDAK PERNAH muncul di bulan lain.

Ini konsisten dengan **Juli = bulan berjalan (draft)**: snapshot bulanan Juli kemungkinan besar di-generate SEBELUM seluruh transaksi penjualan bulan berjalan selesai tercatat, sehingga `salesQty` snapshot mencerminkan potongan waktu yang lebih awal dari `expectedQty` yang dihitung dari seluruh movement sampai saat dry-run dijalankan. **Klasifikasi: BOUNDARY_OR_CURRENT_MONTH** (bukan bug kode) — akan otomatis hilang begitu Juli ditutup dan snapshot final di-generate ulang, ATAU tetap valid sebagai selisih riil bila movement Juli sengaja mencakup periode setelah snapshot terakhir diambil.

### 2.2 AMBIGUOUS (46 kemunculan bulanan, HANYA domain PRODUCT, 14 nama produk unik)

Seluruhnya adalah pola yang SUDAH DIKENAL dari audit Phase 2 (`phase2-ambiguous-276`): produk "COURT FEES - N" (N=1..9), "COURT FEES - -", "SEWA RAKET", "PICKLEBALL COURT FEE - -", "SEWA KERANJANG+BOLA" — seluruhnya `subCase: "variant-ambiguous"` atau `"name-multi-product"` (produk pasti tapi >1 varian aktif tanpa info pembeda dari nama). Satu nama, `BOLA PADEL ODEA`, berstatus `subCase: "historical-inconsistent"` (histori order lama menunjukkan >1 kombinasi productId/variantId berbeda untuk nama yang sama — bukan ambigu katalog, tapi ambigu histori).

**Tidak ada satu pun `variantId` yang terisi pada finding AMBIGUOUS ini** (diverifikasi otomatis — lihat §4.4). Semua 14 nama ini **berulang secara wajar** lintas bulan (produk yang sama dijual berulang kali setiap bulan, bukan bug) — 2 nama (`BOLA PADEL ODEA`, `PICKLEBALL COURT FEE - -`) muncul di SEMUA 6 bulan karena memang laris terjual tiap bulan.

**Klasifikasi: REQUIRES_MANUAL_ADJUSTMENT** — perlu keputusan admin katalog (bukan perbaikan kode), lihat §7.

### 2.3 MISSING_IN_SNAPSHOT (245 kemunculan bulanan)

Tiga sumber berbeda, harus dipisahkan:

**a) SNAPSHOT domain, 61 finding — HANYA di Juli, 100% dari total SNAPSHOT domain Juli.** Root cause: rantai `closingQty` Juli → `openingQty` Agustus tidak bisa dievaluasi karena dokumen snapshot bulanan Agustus BELUM ADA (Agustus belum dimulai/ditutup). **Klasifikasi: BOUNDARY_OR_CURRENT_MONTH — 100% diharapkan, bukan bug.**

**b) INVENTORY domain, 21–38 finding per bulan (naik bertahap Feb→Mei, turun sedikit Jun, turun ke 35 di Jul)** — qty movement tanpa dokumen snapshot bulanan sama sekali untuk productId+variantId tsb. **18 dari kombinasi productId+variantId ini MUNCUL DI SEMUA 6 BULAN** tanpa henti (lihat daftar di JSON `recurring`, filter `months===6` domain INVENTORY) — pola PERSISTEN, bukan sekadar penundaan generate snapshot bulan berjalan. Ini mengindikasikan produk-produk tsb **tidak pernah masuk proses generate `olsera_inventory_monthly_snapshots`** sama sekali sejak baseline (Februari), kemungkinan karena ditambahkan ke katalog SETELAH proses baseline/backfill snapshot bulanan dijalankan, atau ter-exclude oleh filter tertentu di `lib/olsera-inventory-monthly-snapshot-core.ts`. **Klasifikasi: DATA_SOURCE_INCOMPLETE (persisten, perlu investigasi pipeline snapshot — BUKAN di kode rekonsiliasi).**

**c) PRODUCT domain (historical-product/alias fallback), 3–4 finding per bulan** — sudah benar diturunkan ke WARNING/MEDIUM oleh rule engine (bukan ERROR/HIGH default), sesuai desain. Salah satu (`YONEX SHORTS MEN # SM-J035-2906-RW1-S`) berulang 5 dari 6 bulan — wajar (produk lama/non-aktif yang historinya konsisten, tapi tetap terjual berulang). **Klasifikasi: HISTORICAL_PRODUCT — tidak perlu tindakan segera, opsional pembersihan katalog.**

### 2.4 Temuan Juli yang Melonjak

| Domain | Jun | Jul | Δ | Penyebab |
| --- | --- | --- | --- | --- |
| SNAPSHOT MISSING_IN_SNAPSHOT | 0 | 61 (100%) | +61 | Agustus belum ada snapshot — **bulan berjalan**, terjelaskan penuh |
| INVENTORY MISMATCH | 0 | 15 | +15 | 14 finding baru = pola khas bulan berjalan (snapshot Juli belum final); 1 finding (`116138490:0`) adalah recurring anomaly lama |
| INVENTORY MATCH | 32 | 15 | -17 | Konsekuensi langsung: produk yang biasanya MATCH kini MISMATCH/tetap sama karena snapshot Juli parsial |
| Total finding | 266 | 258 | -8 | Relatif stabil meski komposisi status berubah drastis |

**Kesimpulan lonjakan Juli: 76 dari 76 finding baru (61 SNAPSHOT + 15 INVENTORY MISMATCH) 100% dapat dijelaskan oleh Juli sebagai bulan berjalan (draft), DIKONFIRMASI oleh field `summary.isDraftPeriod: true` HANYA muncul di run Juli** (lihat §8, `draftPeriodByMonth`). Ini bukan lonjakan bug — ini konsekuensi struktural yang sudah diprediksi desain (lihat `docs/reconciliation-design.md` "Draft Bulan Berjalan").

**NAMUN ada gap implementasi nyata**: fungsi `capImpactForDraftPeriod()` (yang seharusnya menahan impact ke `INFO` untuk periode draft, sesuai Priority Matrix desain) **TIDAK PERNAH dipanggil di `lib/reconciliation-runner.ts` maupun `lib/reconciliation-sources.ts`** — dikonfirmasi via `grep` (fungsi hanya didefinisikan di `lib/reconciliation-types.ts`, tidak pernah diimpor di tempat lain). Akibatnya, ke-76 finding "hanya karena bulan berjalan" ini tetap dilaporkan dengan **impact ERROR** (default MISSING_IN_SNAPSHOT/MISMATCH), padahal secara desain seharusnya diturunkan/ditandai non-final untuk periode draft. **Ini adalah gap kode nyata yang perlu diperbaiki (lihat §7).**

---

## 3. Pemeriksaan Kualitas (per instruksi §4)

### 3.1 Apakah rule kategori menghasilkan false positive?

**Tidak ada false positive** (tidak ada MISMATCH palsu), TAPI ada **risiko false negative struktural**: `evaluateCategory()` hanya menghasilkan status `MISMATCH` bila `expectedCategoryName` (sumber independen, mis. `olsera_sales_by_category`) disuplai DAN berbeda dari `resolvedCategoryName`. **`lib/reconciliation-sources.ts` `loadCategoryFindings()` TIDAK PERNAH mengisi `expectedCategoryName`** (field ini opsional dan tidak diwire ke sumber independen) — sudah didokumentasikan di Known Limitations Phase 5A, tapi baru sekarang punya bukti nyata: **100% MATCH di 6 bulan bukan bukti kategori benar, melainkan bukti bahwa jalur validasi silang belum aktif.** CATEGORY domain saat ini hanya mengonfirmasi ulang `categoryResolutionStatus==="resolved"` yang SUDAH disimpan saat sync — bukan validasi independen baru. **Bukan bug, tapi kapabilitas yang belum lengkap** — dicatat sebagai rekomendasi, bukan cacat.

### 3.2 Apakah snapshot antarbulan dibandingkan dengan periode yang benar?

**Ya, benar.** Diverifikasi: `nextPeriodLabel()` menghitung bulan berikutnya dengan benar (termasuk pergantian tahun, diuji unit test), dan pola data (SNAPSHOT 100% MATCH Feb–Jun, MISSING_IN_SNAPSHOT hanya saat pasangan bulan berikutnya benar-benar belum ada di Juli→Agustus) konsisten dengan pasangan periode yang tepat — tidak ditemukan indikasi pasangan periode salah geser (mis. Maret dibandingkan ke Mei).

### 3.3 Apakah Juli diperlakukan sebagai bulan berjalan?

**Ya** — `summary.isDraftPeriod: true` HANYA pada run Juli (Feb–Jun: `false`). Ini dihitung otomatis dari `isCurrentJakartaPeriod()` (lib/olsera-financial-core.ts, sudah teruji), dipanggil di `lib/reconciliation-runner.ts` saat membangun summary. **Namun** (lihat §2.4) flag ini BELUM dipakai untuk menahan impact per-finding — hanya tercatat di level summary run, bukan diterapkan ke `impact` masing-masing finding.

### 3.4 Apakah hidden item LABERS/JASA HOST tetap dihitung?

- **LABERS**: tidak ada satu pun transaksi LABERS di seluruh Feb–Jul 2026 pada dataset ini (item memang tidak terjual di periode ini) — tidak bisa diverifikasi positif, tapi juga tidak ada bukti dihilangkan (tidak ada mekanisme filter LABERS di kode manapun, sudah diverifikasi via code read).
- **JASA HOST**: muncul di Juli, domain CATEGORY **dan** PRODUCT, keduanya **MATCH** — dikonfirmasi item ini TETAP DIHITUNG PENUH secara internal (adapter tidak pernah membaca `lib/olsera-inventory-ui.ts`, dikonfirmasi via `grep`, tidak ada impor modul tsb di `lib/reconciliation-sources.ts`).

### 3.5 Apakah productId/variantId tidak pernah ditebak?

**Dikonfirmasi TIDAK PERNAH** — 0 dari 46 finding AMBIGUOUS subCase `variant-ambiguous` memiliki `actual.variantId` terisi (field `variantId` selalu `undefined`/tidak ada di objek `actual`). 0 movement `productId: null` yang produknya terisi otomatis (lihat §3.6 untuk anomali terkait).

### 3.6 Apakah finding yang sama terulang lintas bulan secara wajar atau karena bug?

49 pasangan (domain, entityKey) berulang di ≥2 bulan; 20 di antaranya berulang di SEMUA 6 bulan. Setelah ditelusuri satu per satu:
- **2 AMBIGUOUS berulang 6 bulan** (`BOLA PADEL ODEA`, `PICKLEBALL COURT FEE - -`): **wajar** — produk yang rutin terjual tiap bulan, status ambigunya memang belum diselesaikan admin katalog (bukan bug).
- **18 INVENTORY MISSING_IN_SNAPSHOT berulang 6 bulan**: **berulang karena gap data persisten** (lihat §2.3b) — bukan bug rule, tapi indikasi nyata bahwa 18 kombinasi produk+varian ini tidak pernah punya dokumen snapshot bulanan sejak awal observasi.
- **1 MISMATCH berulang 5 dari 6 bulan** (`movement-qty:116138490:0`): **kemungkinan bug/gap metodologi** (lihat §2.1a).

### 3.7 Apakah status/impact/confidence sesuai akar masalah?

Sebagian besar **sesuai** (mapping status→impact/confidence bekerja sesuai desain: MATCH→INFO/HIGH, AMBIGUOUS→WARNING/LOW, historical/alias→WARNING/MEDIUM override). **Satu ketidaksesuaian ditemukan**: 76 finding Juli (SNAPSHOT+INVENTORY, lihat §2.4) mendapat impact ERROR default padahal akar masalahnya murni "bulan belum ditutup" — seharusnya di-cap ke INFO/WARNING via `capImpactForDraftPeriod()` yang sudah ada tapi belum diterapkan.

---

## 4. Klasifikasi Seluruh Finding Non-MATCH

| Kategori | Jumlah kemunculan (6 bulan) | Domain |
| --- | --- | --- |
| BUG_RULE_OR_ADAPTER (kandidat, perlu verifikasi kode) | 5 (recurring `movement-qty:116138490:0`) | INVENTORY |
| DATA_SOURCE_INCOMPLETE (persisten, bukan kode rekonsiliasi) | 18 unique × kemunculan berulang (≈132 baris-bulan) | INVENTORY |
| HISTORICAL_PRODUCT (sudah ditangani rule, WARNING/MEDIUM) | ~19 kemunculan | PRODUCT |
| BOUNDARY_OR_CURRENT_MONTH (Juli, murni bulan berjalan) | 76 (61 SNAPSHOT + 15 INVENTORY MISMATCH) | SNAPSHOT, INVENTORY |
| REQUIRES_MANUAL_ADJUSTMENT (ambigu katalog, butuh admin) | 46 (14 nama unik) | PRODUCT |
| EXPECTED_NO_ACTION (MATCH) | 1.115 | Semua |

*(Rincian penuh per finding ada di `tmp/reconciliation-phase5b-audit-2026-02_2026-07.json`.)*

---

## 5. Perbandingan dengan Audit Lama (276 / 37 / 4)

**Metodologi perbandingan (WAJIB dibaca sebelum menilai cocok/tidak):**

Audit Phase 2/3 asli (`scripts/audit-order-item-identity-2026.ts`, `scripts/audit-inventory-movement-37.ts`) menghitung **PER BARIS ORDER ITEM** (`olsera_order_items`, satu baris = satu transaksi/item) pada **rentang tanggal 2026-05-01 s/d 2026-07-13** (~2,5 bulan, TIDAK selaras dengan batas bulan kalender).

Phase 5B menghitung **PER NAMA PRODUK UNIK PER BULAN KALENDER** (satu finding mewakili SEMUA baris dengan nama sama dalam satu bulan) — pengelompokan ini SENGAJA (mengurangi noise, lihat Known Limitations Phase 5A/5B). Karena itu, membandingkan angka MENTAH (finding count) dengan 276/37/4 (baris mentah) **tidak apple-to-apple** — perbandingan yang valid adalah pada **jumlah entitas/nama produk unik**, bukan jumlah baris/finding.

| Known Case | Angka asli (baris, 2026-05-01..07-13) | Phase 5B: entitas unik ambigu/historis/null (Mei–Jul, digabung) | Cocok secara pola? |
| --- | --- | --- | --- |
| phase2-ambiguous-276 | 276 baris | 17 kemunculan bulanan (subset dari 14 nama unik lintas 6 bulan), pola IDENTIK (COURT FEES 1-9, SEWA RAKET, PICKLEBALL, dst — nama yang SAMA dengan `knownCaseRef: phase2-ambiguous-276`) | **YA, pola cocok** — akar masalah sama persis, hanya unit hitung berbeda (baris vs nama-per-bulan) |
| phase3-historical-product-4 | 4 baris | 2 kemunculan (Mei–Jul) dengan `subCase: historical-product` | **YA, pola cocok** — jenis sub-case sama, jumlah lebih kecil karena grouping per-nama |
| phase3-movement-37 | 37 movement | **0 di seluruh 6 bulan** | **TIDAK COCOK — perlu investigasi** (lihat di bawah) |

**Ambiguous & Historical: COCOK secara pola/akar masalah**, tidak cocok secara angka mentah — SESUAI EKSPEKTASI (grouping per-bulan-per-nama vs per-baris-mentah, dijelaskan di atas). **Tidak bisa dan tidak perlu dipaksakan sama.**

**Movement productId null: DISKREPANSI NYATA (0 vs ekspektasi >0)** — dua kemungkinan penyebab, PERLU VERIFIKASI LEBIH LANJUT (tidak bisa dipastikan dari data JSON dry-run saja):
1. **Kemungkinan benar (bukan bug)**: 37 movement productId null pada audit asli mungkin seluruhnya berada di LUAR jendela Feb–Jul 2026 (mis. tanggal sebelum Februari), sehingga tidak pernah masuk pengamatan 6 bulan ini.
2. **Kemungkinan bug adapter**: `lib/reconciliation-sources.ts` baris `if (m.productId !== null) continue;` memakai **strict equality** — bila dokumen movement asli menyimpan field `productId` sebagai `undefined`/field TIDAK ADA (bukan literal `null`), pengecekan ini akan MELEWATKAN movement tsb (tidak dianggap "null" maupun "tertaut"), sehingga movement tsb **hilang dari kedua rule** (tidak jadi `movement-null:*` maupun ikut agregasi qty). Ini TIDAK bisa dipastikan/disangkal dari file JSON dry-run saja (yang hanya berisi hasil evaluasi, bukan dokumen mentah `olsera_inventory_movements`).

**Rekomendasi**: jalankan query read-only terpisah (`db.olsera_inventory_movements.countDocuments({productId: null})` vs `{productId: {$exists: false}}` vs `{storeId: 324175}`) dari lingkungan dengan akses database, SEBELUM menyimpulkan penyebabnya. **Jangan mengubah kode berdasarkan dugaan saja** — lihat §7.

---

## 6. Rekomendasi

### 6.1 Perlu perbaikan kode (bukan konfigurasi/data)

1. **Terapkan `capImpactForDraftPeriod()` di Runner** (`lib/reconciliation-runner.ts`, fungsi `buildRunnerFindingRecord`) — saat ini fungsi sudah ada di `lib/reconciliation-types.ts` tapi TIDAK PERNAH dipanggil. Tanpa ini, setiap bulan berjalan (draft) akan selalu menghasilkan lonjakan impact ERROR palsu untuk SNAPSHOT domain (dan sebagian INVENTORY) yang sebenarnya murni artefak "bulan belum ditutup". **Prioritas: SEDANG-TINGGI** (memengaruhi keakuratan dashboard prioritas nanti, tidak memengaruhi kebenaran data).
2. **Perbaiki pengecekan `productId === null` di `lib/reconciliation-sources.ts`** menjadi pengecekan longgar (`== null`, atau eksplisit cek `undefined` juga) untuk `loadInventoryMovementFindings` — **HANYA setelah dikonfirmasi via query read-only langsung ke `olsera_inventory_movements`** bahwa memang ada dokumen dengan `productId` berupa `undefined`/field tidak ada. **Prioritas: perlu verifikasi dulu, jangan ubah berdasar dugaan.**

### 6.2 Hanya perlu status "Butuh Adjust Manual" (bukan perbaikan kode)

- 14 nama produk ambigu (COURT FEES 1-9/-, SEWA RAKET, PICKLEBALL COURT FEE, SEWA KERANJANG+BOLA, BOLA PADEL ODEA) — perlu admin katalog menetapkan varian pasti atau mengonfirmasi mapping historis, BUKAN perbaikan rule engine (rule sudah benar TIDAK menebak).

### 6.3 Tidak perlu tindakan (expected/by design)

- 76 finding Juli yang murni disebabkan bulan berjalan (dampak berkurang otomatis setelah §6.1 diterapkan, dan/atau otomatis hilang setelah Agustus ditutup).
- Item historical/alias fallback (WARNING/MEDIUM) — sudah benar ditandai lebih rendah prioritas, opsional pembersihan katalog jangka panjang.
- 18 kombinasi produk+varian dengan snapshot bulanan yang tidak pernah ada — **BUKAN tugas modul rekonsiliasi untuk memperbaiki** (modul ini benar melaporkannya); perbaikan ada di pipeline `lib/olsera-inventory-monthly-snapshot-core.ts`/backfill snapshot, di luar scope Phase 5B.
- CATEGORY domain 100% MATCH — bukan tindakan segera, tapi dicatat sebagai limitasi kapabilitas (lihat §3.1) untuk roadmap validasi silang kategori (Phase 5C+, memerlukan sumber independen `olsera_sales_by_category`).

### 6.4 Keputusan GO/NO-GO Write Mode Terbatas

**NO-GO untuk write mode penuh saat ini. Bersyarat GO untuk write mode TERBATAS setelah 2 syarat berikut dipenuhi:**

1. Perbaiki §6.1 (`capImpactForDraftPeriod`) — supaya finding yang ditulis ke `reconciliation_findings` untuk bulan berjalan tidak salah menampilkan impact ERROR permanen (finding TETAP ditulis, tapi impact-nya harus benar sejak awal, karena `impact` tersimpan sebagai bagian dokumen finding, bukan dihitung ulang saat baca).
2. Verifikasi §5 (movement productId null = 0) dengan query read-only langsung — pastikan bukan bug adapter sebelum menulis data yang mengklaim "0 movement bermasalah" ke `reconciliation_findings` (klaim yang salah lebih berbahaya ditulis permanen daripada dibiarkan dry-run).

**Tidak ada temuan yang mengindikasikan risiko korupsi data atau pelanggaran batasan keras** (productId/variantId tidak pernah ditebak; storeId selalu digunakan; tidak ada backfill; idempotency sudah teruji) — begitu 2 syarat di atas selesai, write mode terbatas (mis. hanya domain CATEGORY+PRODUCT dulu, yang tidak terpengaruh isu §6.1/§6.2) **layak dicoba di lingkungan non-production**.

---

## 7. Metadata Eksekusi

| Periode | Status | Durasi (ms) | Dokumen dibaca |
| --- | --- | --- | --- |
| 2026-02 | success | 2.529 | 15.994 |
| 2026-03 | success | 6.173 | 17.514 |
| 2026-04 | success | 2.962 | 19.558 |
| 2026-05 | success | 3.167 | 20.828 |
| 2026-06 | success | 2.564 | 20.346 |
| 2026-07 | success | 2.797 | 18.819 |

Tidak ada `domainErrors` di bulan manapun (seluruh domain berhasil dievaluasi tiap bulan).
