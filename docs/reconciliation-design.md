# Modul Rekonsiliasi AYOSERA — Dokumen Desain (Phase 5)

Status: **Phase 5B (Background Job Read-Only) — SEBAGIAN DIIMPLEMENTASI, belum di-commit.** Dokumen ini awalnya ditulis sebagai desain murni (Phase 5); bagian ini menegaskan penyempitan scope resmi dan memetakan bagian mana yang sudah punya kode nyata. Fondasi Impact/Confidence (dasar Dashboard, Manual Resolution, dan Prioritas Investigasi) ditambahkan sebelum Phase 5B — lihat "Impact Model"/"Confidence Model"/"Priority Matrix". Phase 5B menambahkan Runner + Source Adapter (`lib/reconciliation-runner.ts`, `lib/reconciliation-sources.ts`) yang BOLEH menulis `reconciliation_runs`/`reconciliation_findings` HANYA lewat entrypoint internal terkontrol (`scripts/run-reconciliation-internal-olsera.ts`, WAJIB `--write` eksplisit + guard env) — lihat "Status Implementasi Phase 5B" di bawah. Belum ada UI, manual resolution, atau cron publik. Tidak ada commit/push/deploy; mode tulis TIDAK PERNAH dijalankan selama pengembangan Phase 5B ini (hanya dry-run).

---

## Penegasan Scope (WAJIB DIBACA — menggantikan asumsi umum di §1-§Rule Rekonsiliasi di bawah)

Sejak Phase 5A, rekonsiliasi AYO↔Olsera **DIPERSEMPIT SECARA TEGAS** — bagian §1-§19 di bawah ini (ditulis sebelum penyempitan) masih berlaku untuk **INTERNAL_OLSERA**, tetapi untuk perbandingan lintas sistem (AYO vs Olsera) HANYA yang di bawah ini yang berlaku:

### A. CROSS_SYSTEM_COURT_REVENUE (AYO vs Olsera) — hanya

- Omzet lapangan (court revenue)
- Booking lapangan
- Transaksi kategori lapangan (Olsera, HANYA yang teridentifikasi sebagai transaksi court/lapangan)
- Jumlah transaksi/booking
- Tanggal
- Court/lapangan
- Status pembayaran, **jika data tersedia** (tidak dipaksakan bila salah satu sisi tidak punya info ini)

**TIDAK PERNAH dibandingkan ke AYO** (data ini murni domain INTERNAL_OLSERA): F&B, retail, LABERS, Jasa Host, inventori umum, laporan keuangan total, dan seluruh transaksi non-lapangan lainnya. Total omzet Olsera **TIDAK PERNAH** dibandingkan dengan total AYO — hanya omzet lapangan yang dibandingkan (lihat `lib/reconciliation-rules.ts` `classifyCategoryForCourtRevenue()` sebagai pagar eksplisit).

### B. INTERNAL_OLSERA — validasi silang antar data Olsera sendiri, tidak pernah dibandingkan ke AYO

- Kategori, Produk/Identitas Produk, Inventori/Inventory Movement, Snapshot Bulanan, Ledger, Laporan Keuangan

Kedua jenis ini **TIDAK PERNAH tercampur** dalam satu run/agregat/temuan — ditegakkan secara struktural oleh `lib/reconciliation-types.ts` (`DOMAINS_BY_TYPE`, `validateDomainForType`) dan `lib/reconciliation-aggregate.ts` (`assertHomogeneousReconciliationType` melempar error keras bila dicoba dicampur).

## Status Implementasi Phase 5A

| Bagian | Status | File |
| --- | --- | --- |
| Domain types (status/jenis/domain/rule id/known case) | **Selesai** | `lib/reconciliation-types.ts` |
| Schema 4 collection baru + index | **Selesai** (skema saja — belum ada penulis data) | `lib/mongodb.ts` (`ReconciliationRunDocument`, `ReconciliationFindingDocument`, `ReconciliationManualResolutionDocument`, `ReconciliationAuditLogDocument`, `createIndexes()`) |
| Rule engine murni — CROSS_SYSTEM_COURT_REVENUE | **Selesai** | `lib/reconciliation-rules.ts` (`evaluateCourtRevenue`, `classifyCategoryForCourtRevenue`) |
| Rule engine murni — INTERNAL_OLSERA (Kategori, Identitas Produk, Inventory Movement, Snapshot Consistency) | **Selesai** | `lib/reconciliation-rules.ts` |
| Rule engine — Ledger/Laporan Keuangan penuh | **DITUNDA** (bukan Phase 5A) | — |
| Status aggregation helper | **Selesai** | `lib/reconciliation-aggregate.ts` |
| Service read-only (list runs, get run detail, list findings) | **Selesai** | `lib/reconciliation-store.ts` |
| API read-only (`GET /api/reconciliation/runs`, `/runs/:runId`, `/findings`) | **Selesai** | `app/api/reconciliation/**` |
| Module otorisasi `"rekonsiliasi"` | **Selesai** (default paling ketat — tidak diberikan ke user existing manapun kecuali supervisor) | `lib/auth.ts` |
| Background job/cron pengisi data (`reconciliation_runs`/`reconciliation_findings`) | **DITUNDA** (bukan Phase 5A — "Jangan membuat cron") | — |
| Manual resolution (jalur tulis `reconciliation_manual_resolutions`) | **DITUNDA** (skema ada, jalur tulis belum — "Jangan membuat manual resolution") | — |
| Audit trail writer (`reconciliation_audit_log`) | **DITUNDA** (skema ada, belum ada penulis) | — |
| UI Dashboard penuh | **DITUNDA** (bukan Phase 5A — "Jangan membuat UI penuh") | — |

### Known Limitations (Phase 5A)

1. **Belum ada data nyata.** Keempat collection baru kosong sampai ada background job (Phase 5B+) yang mengisi `reconciliation_runs`/`reconciliation_findings` — endpoint API Phase 5A akan mengembalikan daftar kosong terhadap MongoDB production saat ini, itu PERILAKU YANG DIHARAPKAN (bukan bug).
2. **Rule Ledger/Laporan Keuangan belum diimplementasikan** — hanya Kategori, Identitas Produk, Inventory Movement, Snapshot Consistency yang aktif untuk INTERNAL_OLSERA.
3. **Klasifikasi kategori lapangan (`classifyCategoryForCourtRevenue`) berbasis keyword eksplisit** (LAPANGAN/COURT FEE vs LABERS/JASA HOST/F&B/RETAIL/MAKANAN/MINUMAN) — kategori yang belum dikenal jatuh ke `"ambiguous"`, TIDAK otomatis dianggap lapangan maupun dikecualikan. Daftar keyword ini perlu ditinjau ulang oleh admin yang paham penamaan kategori Olsera sungguhan sebelum dipakai mengisi data produksi.
4. **Belum ada mapping court AYO↔Olsera nyata** — `courtMappingConfidence` di `evaluateCourtRevenue` adalah INPUT yang harus dipasok pemanggil (hasil dari proses pemetaan yang BELUM dibangun); Phase 5A hanya menyediakan rule yang MENGKONSUMSI hasil pemetaan tsb, bukan pemetaannya sendiri.
5. **storeId tunggal (single-tenant)** — `currentStoreId()` membaca `OLSERA_INTERNAL_STORE_ID` dari env server, konsisten dengan pola single-tenant yang sudah ada di seluruh AYOSERA (lihat SEC-07, audit sebelumnya).

### File/Module Mapping

| Konsep desain (§ di bawah) | Implementasi Phase 5A |
| --- | --- |
| §1-§19 (desain umum) | Tetap berlaku sebagai acuan arsitektur jangka panjang, KECUALI cakupan AYO vs Olsera yang sudah dipersempit di atas |
| §7 Status Hasil | `lib/reconciliation-types.ts` (`RECONCILIATION_STATUSES`, `STATUS_META`) |
| §Rule Rekonsiliasi | `lib/reconciliation-rules.ts` (Kategori, Produk, Inventori, Snapshot aktif; Booking/Ledger/Finansial/Court/Tanggal/Omzet penuh DITUNDA) |
| §11 Struktur Database | `lib/mongodb.ts` (tipe dokumen + `collections()` + `createIndexes()`) |
| §12 API | `app/api/reconciliation/runs/route.ts`, `app/api/reconciliation/runs/[runId]/route.ts`, `app/api/reconciliation/findings/route.ts` — HANYA 3 endpoint GET read-only (bukan 8 endpoint penuh di desain awal; endpoint tulis DITUNDA) |
| §13 Struktur UI | DITUNDA sepenuhnya (Phase 5A tidak membuat komponen React apa pun untuk modul ini) |
| §9 Performa/§15 Caching | Sudah ditegakkan di level service: `listRuns`/`listFindings` selalu paginasi dibatasi (`MAX_LIMIT=200`), tidak ada full-scan di endpoint |
| Impact Model / Confidence Model / Priority Matrix (di bawah) | `lib/reconciliation-types.ts` (`RECONCILIATION_IMPACTS`, `RECONCILIATION_CONFIDENCES`, `STATUS_IMPACT`, `STATUS_CONFIDENCE`, `escalateImpactForDomain`, `capImpactForDraftPeriod`), rule engine di `lib/reconciliation-rules.ts` (override per sub-case), agregasi di `lib/reconciliation-aggregate.ts` (`highestImpact`, `overallConfidence`, `summaryImpact`, `summaryConfidence`) |

## Status Implementasi Phase 5B (Background Job Read-Only)

| Bagian | Status | File |
| --- | --- | --- |
| Source adapter CATEGORY/PRODUCT/INVENTORY/SNAPSHOT (baca `olsera_order_items`/`olsera_inventory_products`/`olsera_product_aliases`/`olsera_inventory_movements`/`olsera_inventory_monthly_snapshots`) | **Selesai** | `lib/reconciliation-sources.ts` |
| Runner (dry-run + write, idempotent, checkpoint per domain, partial-failure handling) | **Selesai** | `lib/reconciliation-runner.ts` |
| Entrypoint internal terkontrol (bukan route publik, bukan cron) | **Selesai** | `scripts/run-reconciliation-internal-olsera.ts` |
| Field additive `occurrenceCount`/`supersededAt` pada finding (finding lifecycle) | **Selesai** (additive, tidak mengubah field lama) | `lib/mongodb.ts` (`ReconciliationFindingDocument`) |
| `_id` run deterministik (idempotency key) untuk run background job | **Selesai** (additive — Phase 5A tetap boleh memakai `_id` unik-per-eksekusi untuk run manual lain) | `lib/mongodb.ts` (`ReconciliationRunDocument`), `lib/reconciliation-runner.ts` (`computeRunId`) |
| Rule Ledger/Laporan Keuangan, domain BOOKING/COURT/DATE/PAYMENT (CROSS_SYSTEM) | **DITUNDA** (bukan Phase 5B — belum ada source adapter AYO/Ledger) | — |
| Manual resolution (jalur tulis `reconciliation_manual_resolutions`) | **DITUNDA** ("Jangan membuat manual resolution") | — |
| Audit trail writer (`reconciliation_audit_log`) | **DITUNDA** (skema ada, belum ada penulis) | — |
| Cron publik / scheduler otomatis | **DITUNDA** ("Jangan membuat cron publik") | — |
| UI Dashboard | **DITUNDA** ("Belum membuat UI") | — |

### Runner Lifecycle (Phase 5B)

```text
validasi input (storeId/period/reconciliationType=INTERNAL_OLSERA/domain ⊆ {CATEGORY,PRODUCT,INVENTORY,SNAPSHOT})
  -> hitung runId deterministik = `${reconciliationType}:${storeId}:monthly:${period}:${domain-set-tersortir}:v${runVersion}`
  -> [dryRun=false] tolak bila run dengan runId sama masih "running" & belum basi (< 15 menit sejak updatedAt)
  -> [dryRun=false] upsert reconciliation_runs {status:"running"} (idempotent, _id deterministik)
  -> untuk setiap domain (berurutan):
       coba: baca sumber (lib/reconciliation-sources.ts) -> evaluasi rule (lib/reconciliation-rules.ts)
       gagal -> catat pesan error (disanitasi), domain ini TIDAK menulis apa pun, domain lain TIDAK terpengaruh
       sukses -> [dryRun=false] upsert findings (bulk, batch 200) + tandai finding lama domain ini yang
                 tidak muncul lagi sebagai supersededAt (BUKAN dihapus) + update checkpoint.completedDomains
  -> status akhir: "success" (semua domain sukses) | "partial" (sebagian gagal) | "failed" (semua gagal)
     -> TIDAK PERNAH "success" bila ada domain gagal (mencegah run ditandai matched palsu)
  -> [dryRun=false] finalize reconciliation_runs {status, summary, errorMessage, completedAt}
```

`dryRun=true` menjalankan jalur yang SAMA PERSIS (source adapter + rule engine) tetapi TIDAK PERNAH memanggil `reconciliation_runs`/`reconciliation_findings` sama sekali — bahkan `write` context tidak di-resolve.

### Idempotency & Finding Lifecycle

- **Run**: `_id` deterministik dari cakupan (storeId+period+reconciliationType+domain-set+runVersion) — rerun pada cakupan yang SAMA meng-upsert dokumen yang SAMA (`startedAt` tetap dari eksekusi pertama, `updatedAt`/`completedAt` mengikuti eksekusi terakhir). Ini BERBEDA dari `_id` Phase 5A (unik per eksekusi) — keduanya valid tergantung siapa yang menulis (lihat komentar `ReconciliationRunDocument._id` di `lib/mongodb.ts`).
- **Finding**: `_id` deterministik dari storeId+period+reconciliationType+domain+ruleId+entityKey+ruleVersion. Upsert via `bulkWrite` (`updateOne` + `upsert:true`), TIDAK PERNAH `insertMany` biasa (mencegah duplikat saat rerun).
- **Field lifecycle** (semua additive terhadap skema Phase 5A): `firstDetectedAt`/`createdAt` diisi HANYA saat insert pertama (`$setOnInsert`, tidak pernah ditimpa); `lastCheckedAt`/`updatedAt`/`runId` (=lastSeenRunId) diperbarui setiap kali finding terlihat lagi; `occurrenceCount` naik `$inc: 1` setiap kali terlihat lagi (tidak pernah direset); `manualResolutionId` HANYA di-set saat insert (`$setOnInsert: null`) — TIDAK PERNAH ditimpa balik ke `null` oleh rerun, supaya keputusan manusia (Phase 5C+) tidak hilang oleh reprocessing; `supersededAt` di-set ke `now` untuk finding lama yang TIDAK muncul lagi pada rerun domain yang sama (query `$nin` findingId yang baru terlihat), dan direset ke `null` setiap kali finding itu terlihat aktif lagi — **finding TIDAK PERNAH dihapus** (`deleteMany` tidak dipakai sama sekali di modul ini).

### Checkpoint & Partial Failure

`reconciliation_runs.checkpoint.completedDomains` bertambah SETELAH satu domain selesai diproses (bukan di awal) — bila proses terhenti di tengah jalan, domain yang sudah tercatat di `completedDomains` findingnya SUDAH tersimpan aman. Domain yang gagal dievaluasi (error dari source adapter) TIDAK mengubah finding lama domain tsb sama sekali (tidak ditulis ulang, tidak ditandai superseded) — status run menjadi `"partial"` (bukan `"success"` ataupun `"failed"` penuh) selama minimal satu domain lain berhasil.

### Dry-Run / Write Guard

`scripts/run-reconciliation-internal-olsera.ts` defaultnya SELALU `dryRun=true`. Mode tulis butuh SEMUA syarat berikut: (1) flag CLI `--write` eksplisit, (2) environment `ALLOW_RECONCILIATION_WRITE=1` (terpisah dari flag CLI — mencegah command yang disalin tanpa sadar menulis data), (3) bila `NODE_ENV=production`, tambahan `ALLOW_RECONCILIATION_WRITE_PRODUCTION=1`. Tidak ada jalur lain (route API, cron) yang bisa memicu mode tulis di Phase 5B.

### Source Adapter Mapping

| Domain | Sumber dibaca | Known Case terkait |
| --- | --- | --- |
| CATEGORY | `olsera_order_items` (categoryResolutionStatus/Method/Reason/resolvedCategoryName), digrup per `normalizedItemName` — TIDAK PERNAH membaca preferensi "hidden" UI (`lib/olsera-inventory-ui.ts`) | — |
| PRODUCT | `olsera_order_items` (baris "gapped" — productId/variantId/sku tidak lengkap), `olsera_inventory_products` (katalog), `olsera_product_aliases`, histori `olsera_order_items` lintas periode | phase2-ambiguous-276, phase3-historical-product-4 |
| INVENTORY | `olsera_inventory_movements` (productId null + qty vs `olsera_inventory_monthly_snapshots.salesQty`) | phase3-movement-37, snapshot-boundary |
| SNAPSHOT | `olsera_inventory_monthly_snapshots` (closingQty bulan N vs openingQty bulan N+1) | snapshot-boundary |

### Known Limitations (Phase 5B)

1. **PRODUCT domain hanya melaporkan item "gapped"** (identitas tidak lengkap) — item yang identitasnya sudah lengkap TIDAK menghasilkan finding MATCH (mengurangi noise; keputusan desain, lihat komentar di `lib/reconciliation-sources.ts`).
2. **INVENTORY domain belum mendeteksi "duplicate movement" sebagai status terpisah** — deteksi qty-vs-snapshot sudah menangkap sebagian besar kasus praktis, tetapi hash-based duplicate detection eksplisit DITUNDA ke Phase 5C.
3. **Histori PRODUCT membaca SELURUH `olsera_order_items`** (bukan hanya periode berjalan) untuk mencari histori nama — bounded secara logis (hanya untuk nama yang gapped di periode ini) tetapi belum dioptimasi dengan index khusus; dapat diperbaiki di Phase 5C bila volume data bertambah signifikan.
4. **Cakupan angka Known Case (276/37/4) adalah lintas ~2,5 bulan** (2026-05-01..2026-07-13), sedangkan run Phase 5B di-scope PER BULAN — total satu bulan TIDAK diharapkan sama dengan 276/37/4 penuh (lihat `tmp/reconciliation-phase5b-fix-comparison.md`).
5. **Anomali `movement-qty:116138490:0` (recurring MISMATCH Feb-Mei & Jul, MATCH di Jun)** — terbukti masalah DATA di pipeline generate snapshot bulanan (`salesQty` tercatat 0 di Feb-Apr lalu bertahap "mengejar"), BUKAN bug rule/adapter rekonsiliasi. TIDAK diperbaiki di kode (sesuai instruksi — `expectedQty` tidak boleh dimanipulasi); direkomendasikan investigasi terpisah pada `lib/olsera-inventory-monthly-snapshot-core.ts` untuk productId 116138490 spesifik.

### Perbaikan Akurasi Pasca-Audit Dry-Run Feb-Jul 2026 (3 perbaikan)

Audit dry-run 6 bulan (lihat `tmp/reconciliation-phase5b-audit-2026-02_2026-07.md`) menemukan 3 masalah, seluruhnya sudah diperbaiki dan diverifikasi ulang (`tmp/reconciliation-phase5b-fix-comparison.md`):

1. **`capImpactForDraftPeriod()` tidak pernah dipanggil** — diperbaiki dengan menambahkan `determineDraftCapReason()` + `applyDraftPeriodCap()` di `lib/reconciliation-runner.ts`, dipanggil di `buildRunnerFindingRecord()` sebelum agregasi summary. HANYA menahan `impact` (tidak pernah `status`/`confidence`/`requiresManualAdjustment`), dan HANYA untuk 4 sebab spesifik yang benar-benar disebabkan periode berjalan: `current-month` (INVENTORY, belum ada dokumen snapshot sama sekali), `missing-next-month-snapshot` (SNAPSHOT, bulan berikutnya belum dimulai), `boundary-only`/`incomplete-current-period-snapshot` (INVENTORY, snapshot bulanan mengaku belum final). MISMATCH nyata dengan snapshot berstatus `"complete"` TIDAK PERNAH di-cap. Diagnostics field baru (additive): `diagnostics.missingSide` (`lib/reconciliation-rules.ts` `evaluateSnapshotConsistency`), `diagnostics.hasSnapshotDoc`/`diagnostics.snapshotStatus` (`lib/reconciliation-sources.ts` `loadInventoryMovementFindings`), `diagnostics.draftPeriodCap` (runner, hanya bila cap diterapkan).
2. **Movement `productId null` (Known Case 37) tidak pernah terbaca** — root cause: SELURUH 360 movement legacy tsb (Feb-Jul 2026) punya `storeId: null` (belum pernah distempel saat sync), bukan `storeId` toko lain — filter storeId EKSAK di `loadInventoryMovementFindings` melewatkan semuanya. Diperbaiki dengan filter `storeId: { $in: [storeId, null] }` (TETAP bukan cross-store read — hanya menerima storeId yang diminta ATAU null, tidak pernah storeId toko lain manapun). Dikonfirmasi via `scripts/audit-reconciliation-inventory-null-product.ts`: PERSIS 37 movement pada rentang tanggal audit asli (2026-05-01..07-13).
3. **`requiresManualAdjustment` untuk Known Case 37 sebelumnya `false`** (status `MISSING_IN_SNAPSHOT` tidak otomatis `requiresManualAdjustment`) — diperbaiki di runner: `requiresManualAdjustment = statusRequiresManualAdjustment(status) || knownCaseRef === PHASE3_MOVEMENT_37`. `impact`/`confidence` tidak diubah (tetap WARNING/MEDIUM, sesuai keputusan awal Phase 5B).

Diagnostic script baru (read-only, terpisah dari runner): `scripts/audit-reconciliation-inventory-null-product.ts` + helper murni `lib/reconciliation-inventory-null-audit-core.ts` — mendeteksi SEMUA bentuk identitas hilang (null/absent/empty-string/unexpected-type), bukan hanya `productId === null`, untuk verifikasi lanjutan di masa depan tanpa mengubah rule/adapter.

---

## Impact Model

Setiap finding **WAJIB** memiliki `impact` — dampak bila temuan ini dibiarkan tanpa tindakan. Empat level, urut dari paling ringan:

| Impact | Arti | Tindakan |
| --- | --- | --- |
| `INFO` | Hanya informasi. | Tidak memerlukan tindakan. |
| `WARNING` | Perlu dicek. | Sistem masih dapat dioperasikan normal; tinjau saat sempat. |
| `ERROR` | Menyebabkan rekonsiliasi gagal pada entitas ini. | Perlu tindakan — data pada entitas ini tidak bisa dipercaya sampai diperbaiki. |
| `CRITICAL` | Memengaruhi validitas laporan. | Memblokir release bila muncul pada domain yang memblokir (`FINANCIAL`, `LEDGER`) — lihat `escalateImpactForDomain`. |

`impact` default diturunkan dari `status` (lihat tabel `STATUS_IMPACT` di `lib/reconciliation-types.ts`), tetapi rule engine **boleh override** per sub-case bila status yang sama punya dampak nyata berbeda (mis. inventory movement dengan `productId null` tetap `MISSING_IN_SNAPSHOT`, tapi sudah diketahui akar masalahnya/Known Case 37 dan tidak berdampak ke produk lain → diturunkan ke `WARNING`, bukan default `ERROR`).

`CRITICAL` **tidak pernah dihasilkan langsung oleh status** — hanya lewat eskalasi domain (`escalateImpactForDomain`): `ERROR` pada domain `FINANCIAL`/`LEDGER` naik menjadi `CRITICAL`. Domain rekonsiliasi Ledger/Finansial belum diimplementasikan di Phase 5A (lihat Known Limitations), jadi eskalasi ini belum aktif menghasilkan `CRITICAL` sungguhan sampai rule tersebut dibangun — fungsinya sudah tersedia dan teruji untuk dipakai nanti.

Periode bulan berjalan (draft, belum ditutup) selalu ditampilkan sebagai `INFO` di level tampilan (`capImpactForDraftPeriod`) — hasil masih bisa berubah sampai bulan ditutup, jadi jangan menakuti pengguna dengan impact tinggi yang sifatnya sementara.

## Confidence Model

`confidence` dipakai untuk seluruh finding yang berasal dari proses **matching** (identitas produk, kategori, dsb) — seberapa yakin rule engine terhadap hasil yang dilaporkan:

| Confidence | Arti |
| --- | --- |
| `HIGH` | Exact match / deterministik — tidak butuh tinjauan tambahan. |
| `MEDIUM` | Historical product / alias / fallback — kemungkinan besar benar, tetap bisa ditinjau. |
| `LOW` | Ambigu / lebih dari satu kandidat / butuh tinjauan manual sebelum dipercaya. |

`confidence` default juga diturunkan dari `status` (`STATUS_CONFIDENCE`), dengan override eksplisit di rule product-identity: hasil dari histori (`historical-product`) atau alias (`alias-product`) — walau statusnya `MISSING_IN_SNAPSHOT` — diberi `MEDIUM` (bukan default `HIGH`), karena keduanya adalah hasil fallback, bukan pencocokan langsung.

Aturan keras agregasi (lihat `overallConfidence`): confidence gabungan sekelompok finding = confidence **paling lemah** di antaranya (`LOW` < `MEDIUM` < `HIGH`) — satu finding `LOW` tidak pernah "tertutupi" oleh mayoritas `HIGH`.

## Priority Matrix

Tabel referensi status → impact/confidence default (rule engine boleh override per sub-case, lihat kolom "Catatan"):

| Status | Impact Default | Confidence Default | Action Required | Catatan |
| --- | --- | --- | --- | --- |
| MATCH | INFO | HIGH | Tidak ada | — |
| MINOR_DIFFERENCE | WARNING | HIGH | Tinjau bila berulang | — |
| MISMATCH | ERROR | HIGH | Perbaiki sumber data | Domain FINANCIAL/LEDGER → eskalasi CRITICAL |
| MISSING_IN_AYO | ERROR | HIGH | Tinjau (bisa wajar, mis. walk-in) | — |
| MISSING_IN_OLSERA | ERROR | HIGH | Tinjau booking AYO tanpa transaksi Olsera | — |
| MISSING_IN_SNAPSHOT | ERROR | HIGH | Perbaiki/lengkapi snapshot | Override: inventory `productId null` → WARNING/MEDIUM (Known Case 37); product identity `historical-product`/`alias-product` → WARNING/MEDIUM (fallback) |
| AMBIGUOUS | WARNING | LOW | Butuh tinjauan manual, jangan ditebak | — |
| BUTUH_ADJUST_MANUAL | WARNING | LOW | Butuh adjust manual | — |
| NOT_CHECKED | INFO | LOW | Belum diperiksa | — |
| IN_PROGRESS | INFO | LOW | Sedang diproses | — |
| Draft Bulan Berjalan (periode berjalan, bukan status tersendiri) | ditampilkan sebagai INFO | — | Tunggu bulan ditutup | `capImpactForDraftPeriod` — hasil individual TIDAK diubah, hanya tampilan level dashboard/run |

Dashboard (Phase 5B+) cukup memakai `highestImpact()`/`overallConfidence()` (per kelompok finding) dan `summaryImpact()`/`summaryConfidence()` (tally + ringkasan per run) dari `lib/reconciliation-aggregate.ts` — tidak perlu menghitung ulang logika prioritas di lapisan UI.

---

## 1. Tujuan Modul

Modul Rekonsiliasi menjadi **pusat validasi silang** seluruh data yang mengalir di AYOSERA, tanpa menjadi sumber kebenaran baru (bukan pengganti data source manapun). Tujuannya:

1. Mendeteksi **inkonsistensi** antar 5 sumber data (AYO Booking, Olsera Penjualan, Inventori, Snapshot Bulanan, Laporan Keuangan) yang seharusnya saling merefleksikan transaksi yang sama.
2. Memberi **satu tempat** bagi admin/finance untuk melihat status kesehatan data (cocok/beda/hilang/ambigu) tanpa harus membuka 5 modul terpisah dan membandingkan manual.
3. Menyediakan **jejak audit** atas setiap temuan dan setiap keputusan "adjust manual" yang diambil manusia — konsisten dengan pola `olsera_category_overrides` yang sudah ada (override per-item, bukan aturan global).
4. Menjadi **kanal formal** bagi temuan-temuan yang sebelumnya hanya hidup di file `tmp/order-item-identity-audit-2026/*` dan `tmp/security-audit-2026-07.md` (audit ad-hoc) — modul ini mengubahnya dari laporan sekali-jalan menjadi status yang bisa dipantau berkelanjutan.

**Non-tujuan (eksplisit di luar cakupan Phase 5):**
- Modul ini **tidak melakukan backfill/perbaikan otomatis** apa pun terhadap data sumber. Rekonsiliasi = deteksi + klasifikasi + evidence, bukan koreksi. Keputusan Phase 3/4 sebelumnya ("jangan memaksakan mapping", "backfill hanya exact match 100% dan HANYA setelah tinjauan manusia") tetap berlaku — Modul Rekonsiliasi menegakkan disiplin ini secara struktural (tidak ada tombol "auto-fix" di desain ini).
- Modul ini **tidak mengganti** peran resolver kategori (`lib/olsera-category-resolver.ts`) atau logic sync yang sudah ada — ia HANYA membaca hasil akhir yang sudah tersimpan di MongoDB dan membandingkannya.

---

## 2. Ruang Lingkup

### Dalam cakupan (Phase 5 — desain, lalu implementasi bertahap)
- Rekonsiliasi read-only lintas 5 sumber data pada level **hari** (untuk Booking/Penjualan/Inventori) dan **periode bulan** (untuk Snapshot Bulanan/Laporan Keuangan).
- Klasifikasi status per unit temuan (lihat §7) + penyimpanan hasil ke koleksi baru (bukan penghitungan on-the-fly setiap buka halaman — lihat §9/§15).
- UI dashboard ringkasan + drill-down + export + audit log (desain UI di §13, implementasi UI penuh **ditunda** ke iterasi berikutnya sesuai instruksi tugas).
- Known Cases sebagai kategori temuan bawaan yang harus dikenali modul ini sejak hari pertama (§ Known Cases).

### Di luar cakupan Phase 5
- Rekonsiliasi real-time/streaming (di luar model batch-per-hari/per-bulan yang sudah dipakai seluruh sistem AYOSERA).
- Auto-remediation/auto-backfill.
- Rekonsiliasi terhadap sistem pihak ketiga di luar AYO dan Olsera (mis. bank statement, payment gateway) — bisa jadi extensibility masa depan (§19).

---

## 3. Sumber Data

| # | Sumber | Collection MongoDB (sudah ada) | Granularitas | Kunci alami |
| --- | --- | --- | --- | --- |
| 1 | AYO Booking | `bookings` | per booking (order_detail_id) | `booking_id`, `date`, `field_id` |
| 2 | Olsera Penjualan | `olsera_order_items` (baris item), `olsera_sales_by_category` (agregat harian) | per order item / per hari+kategori | `_id` (orderItemId), `orderNo`, `date` |
| 3 | Inventori | `olsera_inventory_products`, `olsera_inventory_movements`, `olsera_inventory_snapshots` | per produk / per mutasi / per hari | `${storeId}:${productId}:${variantId}`, `sale:${orderItemId}` |
| 4 | Snapshot Bulanan | `olsera_inventory_monthly_snapshots` | per produk per bulan | `${storeId}:${year}:${month}:${productId}:${variantId}` |
| 5 | Laporan Keuangan | `olsera_financial_monthly_reports`, `olsera_financial_ledger_entries`, `olsera_financial_accounts` | per periode+jenis laporan / per baris ledger | `${storeId}:${period}:${reportType}` |

Sumber pendukung yang DIBACA (bukan direkonsiliasi langsung, tapi jadi evidence/kandidat mapping — pola sama dengan audit Phase 2):
- `olsera_product_aliases` (mapping historis productId lama→baru)
- `olsera_category_overrides` (override manual per item — harus DIHORMATI, bukan dianggap "mismatch")
- `olsera_sync_log`, `olsera_financial_sync_logs`, `olsera_inventory_sync_runs` (untuk tahu kapan data terakhir disinkron, dipakai validasi "apakah layak direkonsiliasi hari ini")
- `fields` (Court/lapangan AYO — untuk rekonsiliasi Court, lihat Rule Court di §Rule)

Modul Rekonsiliasi **tidak pernah** memanggil API Olsera/AYO live — 100% membaca snapshot MongoDB yang sudah ada, sama seperti pola read-only yang sudah terbukti aman di modul finansial/inventori (dashboard tetap terbaca saat token API kedaluwarsa).

---

## 4. Alur Rekonsiliasi

```
                          ┌─────────────────────────┐
                          │  Trigger rekonsiliasi   │
                          │  (cron harian ATAU      │
                          │   tombol manual admin)  │
                          └───────────┬─────────────┘
                                      │
                       ┌──────────────▼──────────────┐
                       │ 1. Tentukan cakupan (tanggal/ │
                       │    periode yang perlu diperiksa)│
                       └──────────────┬──────────────┘
                                      │
                ┌─────────────────────┼─────────────────────┐
                ▼                     ▼                     ▼
        ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
        │ 2a. Muat data  │    │ 2b. Muat data  │    │ 2c. Muat data  │
        │ AYO Booking    │    │ Olsera Sales   │    │ Inventori/     │
        │ (hari X)       │    │ (hari X)       │    │ Snapshot/      │
        └───────┬───────┘    └───────┬───────┘    │ Finansial      │
                │                     │            └───────┬───────┘
                └──────────┬──────────┴──────────────────────┘
                           ▼
                ┌─────────────────────────┐
                │ 3. Jalankan Rule Engine │
                │  (per pasangan sumber,  │
                │   lihat §Rule)          │
                └──────────┬──────────────┘
                           ▼
                ┌─────────────────────────┐
                │ 4. Klasifikasi status   │
                │  (§7, termasuk Known    │
                │   Cases §Known Cases)   │
                └──────────┬──────────────┘
                           ▼
                ┌─────────────────────────┐
                │ 5. Simpan hasil ke      │
                │  reconciliation_runs +  │
                │  reconciliation_findings│
                └──────────┬──────────────┘
                           ▼
                ┌─────────────────────────┐
                │ 6. Dashboard membaca    │
                │  HASIL TERSIMPAN saja   │
                │  (tidak scan ulang)     │
                └─────────────────────────┘
```

Prinsip kunci: **pemisahan tegas antara "proses rekonsiliasi" (berat, berjalan di background/cron) dan "tampilan hasil" (ringan, hanya baca dokumen hasil yang sudah jadi)** — identik dengan pola snapshot finansial/inventori yang sudah terbukti bekerja (sync berat di cron, dashboard hanya baca Mongo).

---

## 5. Dependency

**Dependency internal (modul yang sudah ada, DIBACA tanpa diubah):**
- `lib/mongodb.ts` — akses collections, pola `collections()`/`withMongo`/`withDatabaseRetry`.
- `lib/olsera-category-resolver.ts` + `lib/olsera-resolver-context.ts` — untuk memahami BAGAIMANA suatu item sudah/belum ter-resolve kategori (dipakai sebagai evidence, bukan dijalankan ulang).
- `lib/olsera-cron-lock.ts` — dipakai ulang (bukan reimplementasi) untuk mengunci proses rekonsiliasi agar tidak tumpang tindih dengan sync lain ATAU dengan rekonsiliasi run lain.
- `lib/olsera-financial-core.ts` (`isCurrentJakartaPeriod`, `jakartaCurrentPeriod`) — dipakai ulang untuk aturan "bulan berjalan" (Known Case "bulan berjalan draft").
- `lib/no-cache.ts` — header cache-control konsisten untuk endpoint hasil rekonsiliasi yang sensitif.
- `lib/auth.ts` (`requireModule`/`requireSupervisor`) — otorisasi endpoint baru.

**Dependency eksternal:** TIDAK ADA package baru yang dibutuhkan — seluruh perhitungan adalah agregasi/pembandingan data yang sudah ada di MongoDB memakai driver `mongodb` yang sudah terpasang. Export UI (bila nanti diimplementasikan) memakai `exceljs`/`pdf-lib` yang sudah ada (sudah lolos perbaikan SEC-01 formula-injection — helper `escapeExcelFormulaPrefix` WAJIB dipakai ulang di export rekonsiliasi, lihat §12/§Risiko).

**Tidak ada dependency ke sistem eksternal baru** (tidak ada panggilan API baru ke Olsera/AYO — murni membaca Mongo yang sudah disinkronkan modul lain).

---

## 6. Urutan Proses (per Run Rekonsiliasi)

1. **Resolve scope**: tentukan rentang tanggal (harian) atau periode (bulanan) yang akan direkonsiliasi. Default: H-1 s/d hari ini (WIB) untuk rekonsiliasi harian; bulan berjalan + bulan sebelumnya untuk rekonsiliasi bulanan/finansial.
2. **Acquire lock** (`olsera_sync_locks`, kunci baru `reconciliation:{scope}`) — cegah dua proses rekonsiliasi jalan bersamaan, DAN cegah rekonsiliasi jalan saat sync Sales/Inventory/Financial sedang berjalan pada scope yang sama (baca lock, jangan blok proses sync — rekonsiliasi menunggu, bukan sebaliknya, supaya sync production tidak pernah tertunda oleh rekonsiliasi).
3. **Muat data per sumber** (paralel, read-only, dengan proyeksi field seperlunya — lihat §9 performa).
4. **Jalankan rule per pasangan sumber** (§Rule) — hasil sementara di memori.
5. **Deteksi Known Cases** (klasifikasi khusus, prioritas sebelum rule umum — lihat §Known Cases) — mis. baris yang SUDAH diketahui "276 ambiguous" dari audit Phase 2 tidak dilaporkan ulang sebagai temuan baru "misterius", tapi ditandai referensinya ke audit asal.
6. **Tulis hasil**: satu dokumen `reconciliation_runs` (ringkasan run) + N dokumen `reconciliation_findings` (satu per temuan/unit yang dibandingkan) — upsert idempoten dikunci oleh `(scope, sourcePair, entityKey)`, pola sama seperti upsert sync yang sudah terbukti aman terhadap retry.
7. **Release lock** di blok `finally` (pola identik `withOlseraSyncLock`).
8. **(Opsional, iterasi berikutnya) Notifikasi**: bila ditemukan MISMATCH baru di atas ambang tertentu, catat ke log — TIDAK mengirim notifikasi eksternal (email/Slack) di Phase 5 (di luar cakupan; lihat §19).

---

## 7. Status Hasil

Status berlaku pada level **satu temuan** (satu pasangan entitas yang dibandingkan, mis. satu booking vs satu order Olsera, atau satu baris ledger vs satu entry snapshot).

| Status | Definisi |
| --- | --- |
| `MATCH` | Kedua sisi ada dan nilai kunci (nominal, qty, kategori, dsb — sesuai rule pasangan sumber) identik dalam toleransi yang diizinkan (lihat rule masing-masing; toleransi finansial mengikuti pola `tolerance = 0.01` yang sudah dipakai `scripts/validate-olsera-financial-live.ts`). |
| `MINOR_DIFFERENCE` | Kedua sisi ada, tapi ada selisih KECIL dalam ambang yang masih dianggap wajar (mis. pembulatan, selisih < Rp1, selisih waktu sinkron beberapa menit) — TIDAK memerlukan tindakan, hanya dicatat untuk transparansi. |
| `MISMATCH` | Kedua sisi ada, tapi nilai berbeda MELAMPAUI ambang toleransi (mis. nominal beda > Rp1, qty beda, kategori beda) — memerlukan investigasi. |
| `MISSING_IN_AYO` | Data ada di sumber lain (Olsera/Inventori/dst) tapi TIDAK ditemukan padanannya di AYO Booking. |
| `MISSING_IN_OLSERA` | Data ada di AYO Booking (atau sumber lain) tapi TIDAK ditemukan padanannya di Olsera Penjualan. |
| `MISSING_IN_SNAPSHOT` | Data ada di sumber transaksional (order item/ledger entry) tapi TIDAK tercermin di Snapshot Bulanan/Laporan Keuangan periode terkait (mis. periode belum disync, atau item baru masuk setelah snapshot dibuat). |
| `AMBIGUOUS` | Ditemukan LEBIH DARI SATU kandidat padanan yang sama validnya (mis. dua booking dengan waktu/nilai sangat mirip) — sistem TIDAK BOLEH menebak salah satu secara otomatis. Berbeda dari `BUTUH_ADJUST_MANUAL`: `AMBIGUOUS` = mesin tidak bisa memutuskan karena ada banyak kandidat; keputusan akhirnya BISA otomatis (`MATCH`) begitu manusia memilih kandidat yang benar. |
| `BUTUH_ADJUST_MANUAL` | Kedua sisi ADA tapi rule tidak cukup untuk memvonis `MATCH`/`MISMATCH` secara pasti (mis. field kunci hilang seperti kasus 276 ambiguous Phase 2 — productId/variantId/sku absen) — memerlukan koreksi data sumber (bukan sekadar memilih kandidat) sebelum bisa direkonsiliasi ulang. |
| `IN_PROGRESS` | Proses rekonsiliasi untuk unit ini sedang berjalan (status sementara, sebelum salah satu status final di atas ditulis) — dipakai untuk mencegah dashboard menampilkan data setengah jalan sebagai "hasil final". |
| `NOT_CHECKED` | Belum pernah direkonsiliasi (mis. tanggal terlalu baru, di luar baseline, atau modul baru pertama kali dijalankan dan belum mencakup rentang ini). Default untuk seluruh data historis sebelum rekonsiliasi pertama kali dijalankan — BUKAN berarti "aman", murni "belum diperiksa". |

Aturan tambahan status:
- Status TIDAK PERNAH ditimpa otomatis dari `BUTUH_ADJUST_MANUAL`/`AMBIGUOUS` ke `MATCH` oleh proses batch — hanya lewat keputusan manusia tersimpan (§8 penanganan ambigu, §17 audit trail).
- Run rekonsiliasi berikutnya BOLEH menimpa `MATCH`/`MISMATCH`/`MISSING_*` (karena sifatnya deterministik dari data terbaru), tapi harus mencatat histori (§17) bila status berubah dari run sebelumnya (mis. `MISSING_IN_OLSERA` → `MATCH` setelah sync susulan berhasil).

---

## 8. Penanganan Data Ambigu / Butuh Adjust Manual

Mengikuti disiplin yang SUDAH ditetapkan di Phase 2 (audit 6.271 baris) dan Phase 3 (audit 37 movement):

1. **Tidak pernah menebak.** Rule engine yang tidak bisa memutuskan dengan pasti WAJIB mengeluarkan `AMBIGUOUS`/`BUTUH_ADJUST_MANUAL`, bukan memaksakan `MATCH` ke kandidat "paling mirip".
2. **Setiap temuan `AMBIGUOUS` menyertakan daftar kandidat** (mirip `candidate-mapping.xlsx` Phase 2) — bukan hanya "ada masalah", tapi "berikut opsi-opsi yang mungkin benar, dengan alasan masing-masing".
3. **Resolusi manual disimpan sebagai keputusan eksplisit** di koleksi `reconciliation_manual_resolutions` (kunci = `findingId`, BUKAN aturan global by-name — konsisten dengan pola `olsera_category_overrides` yang sudah terbukti aman: satu keputusan HANYA berlaku untuk satu temuan spesifik, tidak otomatis berlaku ke temuan lain yang kebetulan mirip).
4. **Tidak ada auto-resolve berdasarkan riwayat** kecuali eksplisit "riwayat konsisten 100%" (sama seperti `historicalByName` di resolver kategori) — dan bahkan itu, DI PHASE 5 AWAL, tetap ditandai `BUTUH_ADJUST_MANUAL` (bukan auto-resolve) sampai ada keputusan produk untuk mengizinkan auto-resolve berbasis histori khusus rekonsiliasi (di luar cakupan Phase 5, potensi extensibility §19).
5. **Data yang dikoreksi di sumber** (mis. admin membetulkan productId di Olsera lalu re-sync) otomatis menjadi `MATCH`/`MISMATCH` di run rekonsiliasi berikutnya TANPA perlu keputusan manual — sistem selalu mengutamakan data sumber terbaru di atas keputusan manual lama BILA datanya sudah benar-benar berubah (keputusan manual usang dianggap tidak berlaku lagi, dicatat di audit trail sebagai "superseded").

---

## 9. Performa

Target eksplisit dari instruksi: **tidak boleh full scan setiap membuka halaman dashboard.**

Strategi:
1. **Precompute, jangan compute-on-view.** Rekonsiliasi dijalankan oleh cron (§Cron) atau tombol manual "Jalankan Rekonsiliasi Sekarang" (mirip tombol "Sync Sekarang" yang sudah ada) — hasilnya DITULIS ke `reconciliation_findings`. Dashboard HANYA membaca dokumen ini (query `find`/`aggregate` dengan filter+index, bukan menghitung ulang dari `olsera_order_items`/`bookings` mentah).
2. **Cache status ringkasan per hari/periode** di `reconciliation_runs` (satu dokumen per run berisi hitung status: jumlah MATCH/MISMATCH/dst) — dashboard ringkasan (§13 Dashboard Rekonsiliasi) HANYA membaca dokumen ini untuk render angka, bukan agregasi live atas ribuan `reconciliation_findings`.
3. **Rentang waktu terbatas.** Rekonsiliasi harian TIDAK scan seluruh histori setiap run — hanya rentang yang belum direkonsiliasi (checkpoint mirip `olsera_sync_state.lastFullySyncedDate`) + rentang re-check pendek (mis. 3 hari terakhir, untuk menangkap keterlambatan sync) ditambah rentang eksplisit yang diminta admin (drill-down manual).
4. **Index wajib** (detail di §Validasi/index) pada `reconciliation_findings`: `(scope, status)`, `(scope, sourcePair)`, `(date)`, dan unique index pada `(scope, sourcePair, entityKey)` untuk upsert idempoten.
5. **Proyeksi field minimal** saat memuat data sumber untuk dibandingkan (jangan `find({}).toArray()` tanpa proyeksi — pelajaran dari SEC temuan `/api/transactions` unbounded query di audit sebelumnya).
6. **Paginasi wajib** pada endpoint drill-down (`limit`/`page` divalidasi dengan clamp, pola sama dengan `app/api/olsera/financial/snapshot/ledger/route.ts`).
7. **Batasi ukuran satu run**: rekonsiliasi harian diproses PER HARI (bukan gabungan rentang besar sekaligus) — sejalan dengan pola checkpoint bertahap yang sudah dipakai cron finansial/inventori (tahan terhadap `maxDuration` serverless).

---

## 10. Risiko

| Risiko | Mitigasi |
| --- | --- |
| Rekonsiliasi mengklaim "MISMATCH" padahal hanya karena sync belum tuntas (false positive) | Cek status sync (`olsera_sync_log`/`olsera_financial_sync_logs`) SEBELUM menilai — bila sync hari/periode itu belum `success`, tandai `NOT_CHECKED` dulu, bukan `MISMATCH`. |
| Rule terlalu ketat menghasilkan banjir `BUTUH_ADJUST_MANUAL` yang tidak actionable (alert fatigue) | Prioritaskan Known Cases (sudah punya penjelasan) supaya tidak dilaporkan sebagai "temuan baru"; sediakan ambang toleransi (`MINOR_DIFFERENCE`) untuk selisih kecil yang wajar. |
| Rekonsiliasi berat membebani MongoDB/serverless function yang sama dengan sync production | Reuse distributed lock supaya tidak overlap; proses per-hari kecil; jadwalkan cron rekonsiliasi SETELAH jendela cron sync (mis. sync jam 00:00-01:00 WIB, rekonsiliasi jam 02:00 WIB). |
| Modul baru menambah kompleksitas otorisasi (siapa boleh lihat rekonsiliasi finansial vs inventori) | Reuse `requireModule`; tambahkan module baru `"rekonsiliasi"` yang PERLU migrasi kecil (assign eksplisit ke user yang berhak — lihat §Validasi). |
| Export rekonsiliasi (Excel) mewarisi bug SEC-01 (formula injection) bila tidak hati-hati | WAJIB reuse `escapeExcelFormulaPrefix` dari `lib/olsera-category-export.ts` untuk SEMUA field teks eksternal (itemName, booker_name, dst) di export rekonsiliasi — bukan menulis ulang sanitizer baru. |
| Keputusan manual (`reconciliation_manual_resolutions`) disalahgunakan untuk "menyembunyikan" temuan asli tanpa jejak | Setiap keputusan WAJIB menyertakan alasan (teks) + siapa (`userId`) + kapan, tidak bisa dihapus (append-only, lihat §17) — hanya bisa "superseded" oleh keputusan baru, bukan diedit/dihapus. |
| Snapshot boundary (data berubah tepat di batas hari/bulan) memicu false MISMATCH berulang | Known Case eksplisit "snapshot boundary" (lihat di bawah) — beri toleransi H±1 hari untuk pencocokan booking↔order bila timestamp dekat tengah malam WIB. |
| Volume data historis besar membuat rekonsiliasi retroaktif (backfill status lama) mahal | `NOT_CHECKED` adalah default yang SAH — tidak perlu memaksa rekonsiliasi seluruh histori sejak awal; retroaktif dilakukan bertahap/manual per kebutuhan (mis. saat audit tertentu diminta). |

---

## Known Cases (WAJIB Dikenali Sejak Hari Pertama)

Setiap Known Case adalah kategori temuan yang SUDAH DIKETAHUI PENYEBABNYA dari audit Phase 2-4 — modul rekonsiliasi harus mengenalinya secara eksplisit (bukan melaporkannya sebagai "misteri baru" setiap kali muncul).

| Known Case | Sumber asal | Bagaimana direpresentasikan di Modul Rekonsiliasi |
| --- | --- | --- |
| **276 ambiguous item** | `tmp/order-item-identity-audit-2026/ambiguous-items.xlsx` (Phase 2) | Baris `olsera_order_items` yang termasuk grup ini otomatis diberi status `BUTUH_ADJUST_MANUAL` dengan `knownCaseRef: "phase2-ambiguous-276"`, TIDAK dihitung ulang rule dari nol — cukup rujuk hasil Phase 2 (atau re-run logic `scripts/audit-order-item-identity-2026.ts` sebagai bagian rule Produk/Varian, lihat §Rule Produk). |
| **37 inventory movement productId null** | `tmp/order-item-identity-audit-2026/inventory-movement-37-summary.md` (Phase 3) | Rule Inventori mengenali movement dengan `productId: null` sebagai `MISSING_IN_SNAPSHOT`-adjacent khusus, tag `knownCaseRef: "phase3-movement-37"` — dicatat TIDAK memengaruhi closingQty produk lain (sesuai temuan Phase 3), jadi tidak dieskalasi sebagai risiko stok yang salah, hanya "qty hilang dari kartu stok". |
| **4 historical product** | Subset dari 37 movement (Phase 3) — produk "YONEX SHORTS MEN..." | Status `MISSING_IN_SNAPSHOT` (produk tidak ada di katalog aktif) dengan `knownCaseRef: "phase3-historical-product-4"`; rule Produk memberi kandidat dari `olsera_product_aliases`/histori nama, tapi tetap `BUTUH_ADJUST_MANUAL` (tidak auto-resolve, sesuai §8 poin 4). |
| **Perbedaan AYO vs Olsera** | Perbedaan struktural: AYO mencatat *booking* (reservasi lapangan), Olsera mencatat *transaksi POS* (penjualan barang/jasa, termasuk sewa lapangan sbg item "SEWA RAKET"/court fee) — keduanya TIDAK 1:1 secara alami | Rule Booking (§Rule) mendefinisikan kunci pencocokan eksplisit (tanggal + court/field + rentang waktu + nominal), dan status `MISSING_IN_AYO`/`MISSING_IN_OLSERA` adalah HASIL YANG DIHARAPKAN untuk transaksi yang memang hanya tercatat di satu sisi (mis. penjualan retail tanpa booking lapangan) — bukan otomatis dianggap error. Dashboard harus membedakan "missing yang wajar" (item non-booking) vs "missing yang mencurigakan" (ada booking tapi tidak ada transaksi Olsera sama sekali). |
| **Bulan berjalan draft** | Fitur Phase 1 (`isCurrentJakartaPeriod`, label "DRAFT / BELUM FINAL") | Rekonsiliasi Laporan Keuangan untuk periode = bulan berjalan (Asia/Jakarta) otomatis diberi flag `isDraftPeriod: true` di `reconciliation_runs` — status individual TETAP dihitung (`MATCH`/`MISMATCH` dst), tapi UI menampilkan peringatan "periode ini masih berjalan, hasil rekonsiliasi bisa berubah sampai bulan ditutup" (bukan status khusus baru, murni flag kontekstual, konsisten dengan §Rule Tanggal). |
| **Hidden item** | Fitur UI inventori (`lib/olsera-inventory-ui.ts`, toggle "Hidden Item" — item disembunyikan dari tampilan TANPA mengubah data sumber) | Rule Inventori HARUS membaca preferensi hidden-item TERPISAH dari data rekonsiliasi (hidden = preferensi tampilan personal, BUKAN properti data) — produk yang di-hide tetap direkonsiliasi penuh di background; hidden-item HANYA memengaruhi apakah temuannya ditonjolkan di ringkasan dashboard utama vs disembunyikan di balik filter "tampilkan item tersembunyi". |
| **Snapshot boundary** | Snapshot bulanan (`olsera_inventory_monthly_snapshots`) closing bulan N = opening bulan N+1 — transaksi yang terjadi TEPAT di detik-detik pergantian bulan/hari WIB rawan tercatat di sisi yang "salah" tanpa itu berarti data salah | Rule Snapshot memberi toleransi eksplisit: transaksi dalam 1 hari sebelum/sesudah batas periode yang menghasilkan `MISMATCH` kecil (selisih persis sebesar 1-2 transaksi boundary) diklasifikasi `MINOR_DIFFERENCE` dengan `knownCaseRef: "snapshot-boundary"`, bukan `MISMATCH` penuh — mencegah alert fatigue berulang bulanan. |
| **Butuh adjust manual (umum)** | Payung status resmi | Bukan hanya untuk Produk/Varian — status `BUTUH_ADJUST_MANUAL` dipakai KONSISTEN di seluruh rule (Booking/Penjualan/Kategori/Inventori/Ledger/Finansial/Snapshot/Omzet/Court/Tanggal) setiap kali rule tidak punya cukup evidence untuk vonis pasti, mengikuti disiplin "jangan memaksakan mapping" dari Phase 2-4. |

---

## Rule Rekonsiliasi (per Domain)

Setiap rule didesain sebagai fungsi PURE (tanpa I/O), menerima data yang SUDAH dimuat dari kedua sisi, mengembalikan `{status, evidence, candidates?}` — pola yang sama dengan `resolveItemCategory()` di `lib/olsera-category-resolver.ts` (murni, dapat diuji unit tanpa MongoDB).

### Rule Booking
- **Kunci pencocokan:** `date` (WIB) + `field_id`/court + jendela waktu (`start_time`±toleransi) → dicocokkan ke transaksi Olsera dengan itemName mengandung pola sewa lapangan/court fee pada tanggal & Court yang sama.
- `MATCH`: satu booking ↔ tepat satu transaksi Olsera dengan nominal (`total_price` vs `amount`) identik dalam toleransi Rp1.
- `MISSING_IN_OLSERA`: booking berstatus `SUCCESS`/`FINISHED` tapi tidak ada transaksi Olsera padanan pada tanggal+court yang sama.
- `MISSING_IN_AYO`: transaksi Olsera bertipe court-fee tanpa booking AYO padanan (mis. booking walk-in yang dicatat langsung di kasir tanpa app AYO — status ini WAJAR, bukan error, lihat Known Case "Perbedaan AYO vs Olsera").
- `AMBIGUOUS`: >1 booking pada court+jam yang sama cocok dengan >1 transaksi Olsera bernominal mirip — tidak ditebak.
- Booking berstatus `cancelled` DIKECUALIKAN dari rule ini sepenuhnya (booking batal tidak perlu ada padanan transaksi).

### Rule Penjualan
- **Kunci:** `orderNo` (Olsera) sebagai satuan transaksi; dibandingkan qty/amount agregat per order terhadap `olsera_sales_by_category` (yang seharusnya = jumlah semua `olsera_order_items` pada order/tanggal/kategori yang sama).
- `MATCH`: `sum(order_items.amount)` per tanggal+kategori == `olsera_sales_by_category.totalAmount` (toleransi Rp1, karena keduanya SAMA-SAMA berasal dari sync yang sama — perbedaan berarti bug agregasi, bukan perbedaan sumber data independen).
- `MISMATCH`: selisih melampaui toleransi → indikasi bug pada `syncOlseraSalesByCategory` (butuh investigasi kode, bukan adjust data).

### Rule Kategori
- Baca `categoryResolutionStatus`/`categoryResolutionMethod` yang SUDAH tersimpan di `olsera_order_items` (JANGAN resolve ulang — cukup rujuk hasil resolver yang sudah jalan saat sync).
- `MATCH`: `categoryResolutionStatus === "resolved"`.
- `BUTUH_ADJUST_MANUAL`: `categoryResolutionStatus === "unresolved"` — beri `categoryResolutionReason` sebagai evidence langsung (field ini sudah ada di skema).
- Method `manual_override` selalu dianggap `MATCH` (keputusan manusia final, bukan didebat ulang oleh rekonsiliasi).

### Rule Produk / Varian
- Reuse logic klasifikasi Phase 2 (`scripts/audit-order-item-identity-2026.ts`): Exact Match → `MATCH`; Exact Product Variant Ambiguous / Butuh Adjust Manual dari Phase 2 → `BUTUH_ADJUST_MANUAL`; Historical Product → `MISSING_IN_SNAPSHOT` (produk tidak di katalog aktif) dengan kandidat historis sebagai evidence.
- **Varian tidak pernah diisi otomatis dari nama produk induk** — aturan ini KERAS, identik dengan Phase 2 (satu produk multi-varian + histori tidak cukup = `AMBIGUOUS`/`BUTUH_ADJUST_MANUAL`, titik).

### Rule Inventori
- Bandingkan `sum(olsera_inventory_movements.qtyChange)` per produk per bulan vs `openingQty`→`closingQty` di `olsera_inventory_monthly_snapshots` (closing = opening + incoming - outgoing - sales + return, formula yang sudah ada di modul snapshot bulanan).
- `MATCH`: closing terhitung == closing tersimpan.
- Movement dengan `productId: null` (Known Case 37) TIDAK dihitung sebagai kontribusi ke produk manapun — kalau ini menyebabkan selisih, klasifikasi HARUS `MISSING_IN_SNAPSHOT` dengan `knownCaseRef` (bukan `MISMATCH` polos, supaya jelas akar masalahnya identitas produk, bukan salah hitung snapshot).

### Rule Ledger
- Bandingkan `sum(debit) - sum(credit)` per akun per periode di `olsera_financial_ledger_entries` vs `balance` yang tersimpan (dan vs `olsera_sales_by_category`/`olsera_order_items` untuk akun pendapatan penjualan, sebagai validasi silang penjualan↔akuntansi).
- Toleransi Rp0.01 (identik pola validasi finansial yang sudah ada).
- `MISMATCH`: penting untuk diprioritaskan tinggi di dashboard (uang, bukan sekadar metadata).

### Rule Laporan Keuangan
- Bandingkan total tiap laporan (`balance-sheet` totalAssets vs totalLiabilityCapital — harus balanced; `profit-loss` netProfit vs komponen; `cash-flow` endingCash vs openingCash+pergerakan) — validasi INTERNAL laporan itu sendiri (bukan lintas sumber), plus validasi Laba Rugi vs `olsera_sales_by_category` (omzet harus konsisten, lihat Rule Omzet).
- Periode = bulan berjalan → flag `isDraftPeriod` (Known Case "bulan berjalan draft"), status tetap dihitung, TIDAK diblokir.

### Rule Snapshot
- Snapshot bulanan `closingQty` bulan N HARUS SAMA PERSIS dengan `openingQty` bulan N+1 untuk produk yang sama (rantai berkelanjutan, sesuai desain yang sudah ada) — `MISMATCH` bila rantai putus (bug data, prioritas tinggi).
- Toleransi boundary (Known Case "snapshot boundary") di atas.

### Rule Omzet
- `sum(olsera_sales_by_category.totalAmount)` per hari harus == `sum(olsera_order_items.amount)` per hari yang sama (kedua collection ditulis dari sync yang sama — perbedaan = bug, bukan celah data independen, ambang toleransi ketat Rp1).
- Omzet bulanan (untuk Laporan Keuangan) harus == `sum` omzet harian dalam bulan itu.

### Rule Court
- `field_id`/`field_name` di `bookings` vs nama court yang muncul di `itemName` transaksi Olsera (pola "Pickleball Court No 1/2" dsb, sudah ada regex serupa di `lib/booking-query.ts`) — dipakai sebagai bagian kunci pencocokan Rule Booking di atas, BUKAN rule berdiri sendiri yang terpisah.
- Court yang dinonaktifkan (`fields.is_active === 0`) tapi masih muncul di transaksi baru → `BUTUH_ADJUST_MANUAL` (data master perlu diperbarui).

### Rule Tanggal
- SEMUA pencocokan tanggal WAJIB memakai Asia/Jakarta (reuse `jakartaCurrentPeriod`/pola `Intl.DateTimeFormat` yang sudah standar di seluruh AYOSERA — TIDAK BOLEH ada logic tanggal baru yang pakai UTC/`toISOString().slice(0,10)`, mengulang bug kosmetik yang sudah ditemukan di SEC-11 audit sebelumnya).
- Transaksi lintas tengah malam (`orderDate` jam 23:xx tapi `date` field beda) — gunakan `date` (field kanonik WIB yang SUDAH dihitung saat sync), bukan hitung ulang dari `orderDate`.

---

## 12. API yang Dibutuhkan (Desain — Implementasi Menyusul)

Seluruh endpoint baru di bawah `app/api/reconciliation/**`, otorisasi `requireModule("rekonsiliasi")` (atau `requireSupervisor()` untuk endpoint yang memicu proses berat/manual resolution), header `NO_CACHE_HEADERS` untuk seluruh response.

| Endpoint | Method | Fungsi |
| --- | --- | --- |
| `/api/reconciliation/status` | GET | Ringkasan run terakhir per scope (harian/bulanan) — dashboard utama, HANYA baca `reconciliation_runs`. |
| `/api/reconciliation/findings` | GET | List temuan dengan filter (`status`, `sourcePair`, `date`/`period`, `knownCaseRef`), paginasi wajib (`page`/`limit` di-clamp). |
| `/api/reconciliation/findings/:id` | GET | Detail satu temuan + seluruh evidence/kandidat (drill-down). |
| `/api/reconciliation/run` | POST | Trigger manual (mirip tombol "Sync Sekarang") — `requireSupervisor()`, mengunci via `olsera_sync_locks`, memicu proses batch (sinkron untuk 1 hari kecil, atau checkpoint bertahap untuk rentang besar — pola sama cron finansial). |
| `/api/reconciliation/resolutions` | POST | Simpan keputusan manual (`reconciliation_manual_resolutions`) — WAJIB body `{findingId, decision, reason}`, `requireSupervisor()`. |
| `/api/reconciliation/export` | GET | Export Excel ringkasan+detail temuan sesuai filter — WAJIB reuse `escapeExcelFormulaPrefix` untuk field teks eksternal. |
| `/api/reconciliation/audit-log` | GET | Riwayat perubahan status + keputusan manual (append-only), untuk tab "Audit Log" di UI. |
| `/api/cron/reconciliation` | POST | Endpoint cron baru — pola IDENTIK 3 cron Olsera yang sudah ada (`verifyCronSecret`, distributed lock, checkpoint bertahap). |

---

## 13. Struktur UI (Desain Saja — Belum Diimplementasikan)

Mengikuti pola visual/komponen yang SUDAH ada (`components/olsera-financial-panel.tsx`, `components/olsera-inventory-panel.tsx` sebagai referensi struktur, tema `rd-*` di `globals.css`).

1. **Dashboard Rekonsiliasi** (`components/reconciliation-panel.tsx`, tab baru di `app/page.tsx` bila module `"rekonsiliasi"` diizinkan untuk user):
   - Kartu ringkasan per pasangan sumber (Booking↔Penjualan, Penjualan↔Inventori, Inventori↔Snapshot, Snapshot↔Finansial) — jumlah MATCH/MISMATCH/dst, warna status (hijau/kuning/merah/abu-abu netral untuk `NOT_CHECKED`).
   - Indikator "terakhir rekonsiliasi: <waktu>" + tombol "Jalankan Rekonsiliasi Sekarang" (disabled bila lock sedang dipegang proses lain — pola sama tombol sync).
2. **Ringkasan** — tabel per hari/periode dengan hitung status, klik baris → drill-down.
3. **Detail Temuan** — tabel `reconciliation_findings` dengan kolom: entitas, sourcePair, status, evidence ringkas, `knownCaseRef` (badge bila ada), tombol "Lihat Detail".
4. **Filter** — status, sourcePair, rentang tanggal/periode, `knownCaseRef`, "sembunyikan Known Cases yang sudah dipahami" (toggle, mirip pola "Hidden Item").
5. **Drill-down** — modal/halaman detail satu temuan: data mentah kedua sisi berdampingan, daftar kandidat (bila `AMBIGUOUS`), riwayat status (bila pernah berubah), form "Tandai sudah ditinjau" / "Ajukan resolusi manual" (hanya supervisor).
6. **Export** — tombol export Excel (filter yang sedang aktif), menghasilkan file lewat `/api/reconciliation/export`.
7. **Audit Log** — tab terpisah, daftar append-only: siapa mengambil keputusan, kapan, temuan mana, alasan apa, status sebelum/sesudah.

---

## 14. Workflow Pengguna

1. Admin/supervisor membuka tab Rekonsiliasi → langsung melihat ringkasan (dari cache/hasil run terakhir, TANPA menunggu scan).
2. Bila ada `MISMATCH`/`BUTUH_ADJUST_MANUAL` baru, kartu terkait menyorot jumlahnya.
3. Klik kartu → tabel Ringkasan per hari/periode → klik hari tertentu → Detail Temuan.
4. Untuk temuan `AMBIGUOUS`: user melihat daftar kandidat, memilih yang benar (atau menandai "tidak ada yang cocok, ini bug") → tersimpan sebagai `reconciliation_manual_resolutions`, status temuan berubah, tercatat di Audit Log.
5. Untuk temuan `BUTUH_ADJUST_MANUAL` yang butuh perbaikan DATA SUMBER (bukan pilihan kandidat): user diarahkan (link) ke modul terkait (mis. Export Kategori, Inventori) untuk memperbaiki manual DI SANA — Modul Rekonsiliasi tidak punya form edit data sumber sendiri, hanya menunjuk ke mana harus pergi memperbaikinya.
6. User bisa export hasil filter saat ini kapan saja untuk dibawa ke rapat/laporan eksternal.
7. Supervisor bisa memicu "Jalankan Rekonsiliasi Sekarang" bila baru saja melakukan sync manual dan ingin verifikasi cepat (tanpa menunggu jadwal cron berikutnya).

---

## 15. Strategi Caching

- **Hasil rekonsiliasi ITU SENDIRI adalah cache** — `reconciliation_findings`/`reconciliation_runs` adalah representasi tersimpan, dashboard tidak menghitung ulang (lihat §9).
- **TTL kesegaran ditampilkan eksplisit** ("data per <timestamp run terakhir>") — TIDAK ada cache HTTP tambahan di response API (`Cache-Control: no-store`, konsisten `lib/no-cache.ts`) karena datanya sendiri sudah "cache" di level MongoDB; caching HTTP tambahan hanya akan membuat status TERLIHAT lebih basi dari yang sebenarnya.
- **In-memory cache pendek** boleh dipakai HANYA untuk data pendukung yang jarang berubah dalam satu proses rekonsiliasi (mis. daftar `fields`/court, katalog produk aktif) — pola sama `nameMapCache`/`contextCache` yang sudah ada di resolver (TTL 10 menit), BUKAN untuk hasil rekonsiliasi itu sendiri.

---

## 16. Logging

- Log proses (`console.log`/`console.error` server-side) mengikuti pola prefix yang sudah dipakai (`[cron:olsera:financial]`, dst) → tambahkan `[reconciliation]`/`[cron:reconciliation]`.
- **TIDAK PERNAH** mencetak nilai mentah dari data sensitif (nomor telepon booker, dsb) di log level info — hanya ID/ringkasan, konsisten pola `describeFinancialResponse` (metadata aman, bukan payload penuh).
- Log kegagalan proses rekonsiliasi (per hari/periode) HARUS menyertakan alasan aman (bukan stack trace mentah ke response API, boleh lengkap di server log) — pola sama `mapFinancialError`/`classifySalesError`.

---

## 17. Audit Trail

- **Append-only.** Koleksi `reconciliation_audit_log`: setiap perubahan status temuan (oleh sistem MAUPUN manusia) menambah SATU dokumen baru, tidak pernah update-in-place dokumen lama (pola konsisten "jangan menimpa histori" dari desain `resolvedAt`/`categoryResolutionReason` yang sudah ada, dipertegas jadi collection khusus di sini karena kebutuhan audit lebih eksplisit).
- Field wajib per entri: `findingId`, `previousStatus`, `newStatus`, `changedBy` (`"system"` atau `userId`), `reason`, `timestamp`.
- Keputusan manual (`reconciliation_manual_resolutions`) TIDAK BISA dihapus — hanya "superseded" oleh keputusan baru (dokumen lama tetap ada, ditandai `supersededBy`).
- Audit trail modul ini sendiri DIBACA (bukan diubah) oleh audit keamanan/kepatuhan di masa depan — desain mengikuti pola yang sama dipakai untuk mengaudit sistem ini sendiri (Phase 2-4).

---

## 18. Rollback Strategy

- Karena Modul Rekonsiliasi **tidak pernah menulis ke data sumber** (Booking/Penjualan/Inventori/Snapshot/Finansial TETAP read-only dari sudut pandang modul ini), TIDAK ADA rollback data sumber yang diperlukan — risiko rollback HANYA terbatas pada koleksi milik modul ini sendiri (`reconciliation_*`).
- Setiap deploy versi rule engine baru: TIDAK mengubah/menghapus `reconciliation_findings` versi lama — cukup jalankan run baru (upsert per `(scope, sourcePair, entityKey)`), sehingga rollback kode (revert ke versi rule sebelumnya lalu run ulang) otomatis "memperbaiki" hasil tanpa migrasi data.
- Bila skema `reconciliation_findings`/`reconciliation_manual_resolutions` berubah (field baru dsb), field baru harus **optional** (pola konsisten field opsional AYOSERA lain, mis. `addonPrice?`) supaya dokumen lama tetap valid tanpa migration wajib.
- Feature flag implisit: modul baru = module `"rekonsiliasi"` di `APP_MODULES` — TIDAK diberikan ke user manapun secara default (kecuali supervisor) sampai modul dianggap matang; rollback fitur = cukup jangan assign module ini ke user (tidak perlu menghapus kode/collection).

---

## 19. Future Extensibility

- **Auto-resolve berbasis histori khusus rekonsiliasi** (dengan ambang kepercayaan tinggi) — setelah cukup data keputusan manual terkumpul, bisa dipertimbangkan (bukan Phase 5).
- **Notifikasi** (email/Slack/webhook) saat `MISMATCH` finansial baru terdeteksi — di luar cakupan Phase 5, tapi struktur `reconciliation_runs` sudah dirancang agar mudah dipicu dari sana (event "run selesai, ada N MISMATCH baru").
- **Rekonsiliasi terhadap sumber eksternal tambahan** (bank statement, payment gateway settlement) — arsitektur "Rule per pasangan sumber, murni & testable" memudahkan menambah sumber ke-6 tanpa mengubah sumber yang sudah ada (hanya menambah rule baru + entri sumber data baru di §3).
- **Threshold/toleransi yang bisa dikonfigurasi per instalasi** (saat ini toleransi di-hardcode mengikuti pola existing seperti finansial `0.01`) — bisa dipindah ke koleksi config bila kebutuhan multi-store/multi-toleransi muncul.
- **Multi-store**: seluruh desain di atas mengasumsikan single-tenant (sama seperti sistem AYOSERA saat ini, lihat SEC-07 di audit sebelumnya) — bila multi-store diaktifkan, `storeId` WAJIB ditambahkan ke kunci `reconciliation_findings`/index sejak awal (bukan ditambal belakangan) supaya tidak mewarisi masalah laten yang sama seperti SEC-07.

---

## 11. Struktur Database (Koleksi Baru yang Diusulkan)

> Seluruh koleksi baru mengikuti konvensi tipe TypeScript di `lib/mongodb.ts` (akan ditambahkan sebagai `ReconciliationXxxDocument` bila implementasi dimulai). Tidak ada koleksi yang sudah ada yang perlu diubah skemanya.

```ts
// Satu dokumen per RUN rekonsiliasi (satu hari, atau satu periode bulanan).
type ReconciliationRunDocument = {
  _id: string; // `${scope}:${scopeKey}` mis. "daily:2026-07-27" atau "monthly:2026-07"
  scope: "daily" | "monthly";
  scopeKey: string; // tanggal atau periode YYYY-MM
  status: "running" | "success" | "partial" | "failed";
  startedAt: Date;
  completedAt: Date | null;
  isDraftPeriod: boolean; // true bila scope monthly & periode = bulan berjalan (Known Case)
  counts: Partial<Record<StatusName, number>>; // ringkasan per status, untuk dashboard TANPA agregasi live
  sourcePairsChecked: string[]; // mis. ["booking-vs-penjualan", "penjualan-vs-inventori", ...]
  errorMessage: string | null;
  triggeredBy: "cron" | "manual";
  triggeredByUserId: string | null;
};

// Satu dokumen per TEMUAN (satu unit yang dibandingkan).
type ReconciliationFindingDocument = {
  _id: string; // deterministik: `${scope}:${scopeKey}:${sourcePair}:${entityKey}`
  runId: string; // FK ke ReconciliationRunDocument._id (run TERAKHIR yang menghasilkan status ini)
  scope: "daily" | "monthly";
  scopeKey: string;
  sourcePair: string; // mis. "booking-vs-penjualan", "ledger-vs-financial-report"
  entityKey: string; // mis. orderNo, booking_id, productId, accountCode — sesuai rule
  status: StatusName; // MATCH | MINOR_DIFFERENCE | MISMATCH | MISSING_IN_AYO | ... (lihat §7)
  knownCaseRef: string | null; // mis. "phase2-ambiguous-276", "snapshot-boundary"
  evidence: Record<string, unknown>; // nilai kedua sisi + selisih, aman ditampilkan (tanpa raw payload API)
  candidates: Array<{ label: string; entityKey: string; note: string }>; // untuk AMBIGUOUS
  firstDetectedAt: Date;
  lastCheckedAt: Date;
  manualResolutionId: string | null; // FK bila sudah ada keputusan manusia
};

// Keputusan manusia — append-only, satu findingId bisa punya banyak entri (superseded).
type ReconciliationManualResolutionDocument = {
  _id: string; // ULID/ObjectId baru
  findingId: string;
  decision: "confirmed-match" | "confirmed-mismatch" | "chosen-candidate" | "acknowledged-known-case" | "needs-source-fix";
  chosenCandidateEntityKey: string | null;
  reason: string;
  userId: string;
  createdAt: Date;
  supersededBy: string | null; // _id resolusi berikutnya, bila ada
};

// Audit trail append-only atas SELURUH perubahan status (sistem maupun manusia).
type ReconciliationAuditLogDocument = {
  _id: string; // ULID/ObjectId baru
  findingId: string;
  previousStatus: StatusName | null;
  newStatus: StatusName;
  changedBy: "system" | string; // userId bila manusia
  reason: string | null;
  timestamp: Date;
};
```

**Index yang dibutuhkan** (dijawab detail juga di bagian Validasi):
- `reconciliation_runs`: unique implisit via `_id`; index tambahan `{ scope: 1, scopeKey: -1 }` untuk "run terbaru per scope".
- `reconciliation_findings`: unique via `_id` (deterministik, upsert idempoten); index `{ scope: 1, status: 1 }`, `{ scopeKey: 1 }`, `{ sourcePair: 1, status: 1 }`, `{ knownCaseRef: 1 }` (partial index, hanya dokumen yang punya nilai).
- `reconciliation_manual_resolutions`: index `{ findingId: 1, createdAt: -1 }`.
- `reconciliation_audit_log`: index `{ findingId: 1, timestamp: -1 }`, `{ timestamp: -1 }` (untuk tab Audit Log global).

---

# Jawaban Validasi (Sesuai Instruksi Tugas)

## 1. Apakah ada konflik dengan arsitektur AYOSERA sekarang?
**Tidak ada konflik struktural.** Desain ini murni ADDITIVE — seluruh koleksi/endpoint/module baru, tidak mengubah skema atau logic sync/export yang sudah ada. Satu-satunya "singgungan" adalah distributed lock (`olsera_sync_locks`) yang akan dipakai bersama — ini BUKAN konflik, justru sengaja reuse pola yang sudah terbukti aman (sama seperti 3 cron Olsera + tombol manual berbagi lock yang sama hari ini). Perlu kehati-hatian satu hal: rekonsiliasi HARUS dijadwalkan setelah jendela cron sync selesai (lihat §Risiko), supaya tidak "menunggu lock" terlalu lama atau membaca data yang baru separuh disync.

## 2. Apakah perlu collection MongoDB baru?
**Ya, 4 collection baru:** `reconciliation_runs`, `reconciliation_findings`, `reconciliation_manual_resolutions`, `reconciliation_audit_log` (skema di §11). Tidak ada collection lama yang perlu diubah.

## 3. Apakah perlu background job?
**Ya.** Rekonsiliasi TIDAK BOLEH dijalankan secara sinkron saat dashboard dibuka (bertentangan dengan target performa). Perlu proses batch background — bentuknya SAMA dengan pola checkpoint bertahap yang sudah ada di cron finansial/inventori (satu panggilan = satu langkah, dilanjutkan panggilan berikutnya), bukan job queue/worker terpisah baru (tidak perlu infrastruktur BullMQ/Redis dsb — cukup pola yang sudah terbukti di codebase ini).

## 4. Apakah perlu cron baru?
**Ya, satu endpoint cron baru:** `/api/cron/reconciliation` (pola identik `verifyCronSecret` + distributed lock + checkpoint, sama seperti 3 cron Olsera yang sudah ada). Dijadwalkan setelah jendela cron sync selesai (lihat §Risiko/§6).

## 5. Apakah perlu index baru?
**Ya**, seluruhnya pada 4 collection baru (rincian di §11) — TIDAK ADA index baru yang diperlukan pada collection LAMA (rekonsiliasi hanya membaca, dengan proyeksi memakai index yang sudah ada untuk query per-tanggal/per-periode yang sudah tersedia di collection sumber, mis. `olseraOrderItems.createIndex({date:1})` yang sudah ada).

## 6. Apakah perlu migration?
**Migration ringan, dua hal:**
1. Tambah `"rekonsiliasi"` ke `APP_MODULES` (`lib/auth.ts`) — perubahan kode (bukan migrasi data), TAPI berdampak: user existing TIDAK otomatis punya akses (array `allowedModules` mereka tidak berubah, sesuai desain `normalizeModules` yang sudah ada — hanya supervisor otomatis dapat semua module). Perlu keputusan produk: siapa yang diberi akses modul ini di awal (rekomendasi: supervisor-only dulu, sama seperti pola export finansial yang sudah membatasi ke supervisor).
2. `createIndexes()` di `lib/mongodb.ts` perlu ditambah entri untuk 4 collection baru (bagian dari deploy kode, dijalankan otomatis oleh `ensureIndexes()` yang sudah ada — BUKAN migration data manual terpisah).
Tidak ada migrasi/transformasi data HISTORIS yang wajib (status default `NOT_CHECKED` untuk seluruh histori lama adalah valid, sesuai §7).

## 7. Estimasi kompleksitas implementasi
| Bagian | Kompleksitas | Alasan |
| --- | --- | --- |
| Skema + index 4 collection baru | Rendah | Pola sudah familiar, tinggal ikuti konvensi `lib/mongodb.ts`. |
| Rule engine per domain (10 rule) | **Tinggi** | Bagian paling berat — tiap rule butuh definisi kunci pencocokan yang presisi dan test unit menyeluruh (pola `lib/olsera-category-resolver.test.ts`), khususnya Rule Booking (AYO↔Olsera secara struktural tidak 1:1) dan Rule Inventori/Snapshot (banyak edge case boundary). |
| Cron + lock reuse | Rendah-Sedang | Reuse `lib/olsera-cron-lock.ts` penuh, hanya perlu wrapper baru mengikuti pola 3 cron yang sudah ada. |
| API endpoints (8 route) | Sedang | Pola CRUD+auth sudah berulang di codebase, tapi drill-down/candidate/manual-resolution perlu desain response yang hati-hati (tidak bocor data sensitif, konsisten `describeFinancialResponse`). |
| UI Dashboard penuh | **Tinggi** (ditunda, bukan Phase 5) | Banyak state (filter, drill-down, audit log) — implementasi UI PENUH disengaja ditunda sesuai instruksi tugas ini. |
| Known Cases wiring | Sedang | Perlu mapping eksplisit dari hasil audit Phase 2/3 ke `knownCaseRef` — sebagian bisa reuse langsung file `tmp/order-item-identity-audit-2026/raw-evidence.json` sebagai seed data awal (bukan realtime). |

**Estimasi keseluruhan: Tinggi** (multi-minggu bila dikerjakan penuh dengan test unit menyeluruh setiap rule) — TAPI bisa dan HARUS dipecah bertahap (lihat §8 rekomendasi urutan).

## 8. Rekomendasi urutan implementasi paling aman
1. **Skema + index 4 collection baru** (tanpa UI, tanpa cron) — paling aman, murni penambahan, tidak menyentuh apa pun yang berjalan.
2. **Rule engine murni + test unit** (fungsi pure, tanpa MongoDB, tanpa endpoint) untuk SATU pasangan sumber paling bernilai & paling jelas rule-nya dulu: **Rule Omzet + Rule Kategori** (data sudah 1:1 dari sync yang sama, risiko ambiguitas rendah, cocok jadi "pembuktian pola" sebelum masuk ke pasangan yang lebih rumit seperti Booking↔Penjualan).
3. **Glue read-only + endpoint `/api/reconciliation/status` & `/findings`** memakai data yang di-generate SEKALI secara manual (skrip seperti `scripts/audit-*.ts` sebelumnya, BUKAN cron dulu) — validasi hasil rule engine terhadap data produksi nyata tanpa risiko operasional (mirip cara Phase 2/3 audit dilakukan).
4. **Rule engine untuk pasangan lain** (Inventori↔Snapshot, Ledger↔Finansial) satu per satu, masing-masing divalidasi manual dulu sebelum dijadwalkan otomatis.
5. **Cron + distributed lock** (`/api/cron/reconciliation`) — HANYA setelah rule engine untuk seluruh pasangan sumber sudah divalidasi manual dan stabil, dijadwalkan di luar jam sibuk sync lain.
6. **Rule Booking (AYO↔Olsera)** dikerjakan PALING AKHIR dari sisi rule — paling kompleks (bukan 1:1 alami), risiko `AMBIGUOUS`/false-positive paling tinggi, butuh paling banyak Known Case tuning sebelum layak jadi bagian rekonsiliasi otomatis.
7. **API endpoint manual resolution + audit log** — setelah rule engine stabil dan ada temuan nyata untuk diuji alurnya.
8. **UI Dashboard (Ringkasan → Detail → Filter → Drill-down → Export → Audit Log)** — PALING AKHIR, sesuai instruksi eksplisit tugas ini ("jangan langsung membuat UI penuh"), dan karena baru bernilai penuh setelah data hasil rekonsiliasi sudah stabil untuk ditampilkan.

Di setiap tahap: **tidak ada commit/push/deploy sampai reviewer menyetujui tahap tsb** — konsisten pola kerja Phase 1-4 sebelumnya (implementasi → test lengkap → laporan → menunggu persetujuan sebelum lanjut).
