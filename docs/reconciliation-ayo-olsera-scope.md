# Rekonsiliasi AYO vs Olsera — Definisi, Scope, dan Formula (Milestone 3)

Status: dokumen resmi Bagian A Milestone 3. Menggantikan asumsi umum "seluruh
omzet AYO harus sama dengan seluruh omzet Olsera" — TIDAK BENAR, lihat scope
di bawah.

Dokumen ini adalah pelengkap `docs/reconciliation-design.md` (Phase 5A/5B).
`docs/reconciliation-design.md` mendesain kontrak generik modul rekonsiliasi
(status/impact/confidence/rule engine); dokumen ini mendefinisikan bagaimana
kontrak itu dipakai KHUSUS untuk `CROSS_SYSTEM_COURT_REVENUE` granular
(hari/court/jam/booking) berdasarkan bukti data production nyata (lihat
"Bukti Data" di bawah — bukan asumsi).

## 1. Scope Resmi

Rekonsiliasi ini HANYA membandingkan **omzet lapangan (court fee)**:

- AYO: seluruh booking yang **revenue-eligible** (lihat `lib/revenue.ts`) —
  tidak cancelled, tidak Rp0, tidak internal-use.
- Olsera: seluruh baris `olsera_order_items` yang kategorinya diklasifikasi
  **"court"** oleh `classifyCategoryForCourtRevenue()` (`resolvedCategoryName`
  `LAPANGAN PADEL` / `LAPANGAN PICKLEBALL` — lihat Bukti Data).

TIDAK PERNAH masuk ke rekonsiliasi ini:

- F&B, retail, LABERS, Jasa Host, dan kategori lain yang secara eksplisit
  dikecualikan oleh `classifyCategoryForCourtRevenue` (`NON_COURT_REVENUE_KEYWORDS`).
- Kategori yang tidak dikenali (`"ambiguous"`) — TIDAK dipaksakan ikut/tidak
  ikut, ditandai `NEEDS_MANUAL_REVIEW` terpisah dari perbandingan omzet.
- Pajak/biaya tambahan yang hanya ada di salah satu sisi.
- Outlet/store selain `OLSERA_INTERNAL_STORE_ID` (satu store, lihat `.env`).
- Ini adalah modul **terpisah** dari `lib/reconciliation-omzet-ledger.ts`
  ("Rekonsiliasi Omzet AYOSERA" berbasis akun ledger 40001+40004 vs 21003).
  Kedua modul boleh menghasilkan angka bulanan yang **berbeda** — ledger sudah
  melalui reklasifikasi akuntansi, modul ini murni kategori transaksi POS.
  Perbedaan antar kedua modul BUKAN bug, didokumentasikan sebagai known
  divergence (lihat §6).

## 2. Bukti Data (Production, dibaca read-only 2026-08-02)

Query read-only terhadap `bookings` dan `olsera_order_items` production
(storeId `324175`), dasar seluruh keputusan desain di dokumen ini:

**AYO `field_name` (distinct, 2026-02-05..2026-08-30):**

| field_name | jumlah booking | catatan |
|---|---|---|
| Court No 1 | 2161 | Padel |
| Court No 2 | 1876 | Padel |
| Court No 3 | 1697 | Padel |
| Court No 4 | 1896 | Padel |
| Pickleball Court No 1 | 630 | Feb–Jun 2026, **digantikan** oleh 2 baris di bawah mulai Jul 2026 |
| Pickleball 1 | 129 | Jul–Agu 2026 |
| Pickleball 2 | 136 | Jul–Agu 2026 |

`Pickleball Court No 1` dan `Pickleball 1`/`Pickleball 2` **tidak tumpang
tindih waktu** — ini penamaan ulang field AYO per Juli 2026, bukan bug/data
hilang. Keduanya sama-sama sport Pickleball.

**Olsera item lapangan (`resolvedCategoryName` `LAPANGAN PADEL` /
`LAPANGAN PICKLEBALL`), sampel `itemName`:**

```
COURT FEES - 1        COURT FEES - 4        COURT FEES - -
COURT FEES - 3         COURT FEES - 5 .. 9   COURT FEES - . / .. / ... / .....
PICKLEBALL COURT FEE - -   (SELALU "-", tidak pernah bernomor)
```

Temuan penting: suku kata setelah "COURT FEES -" adalah **teks bebas** yang
diketik kasir saat transaksi (bukan field terstruktur) — dikonfirmasi lewat
`variantId`: satu `variantId` Olsera dibuat OTOMATIS per string unik yang
pernah diketik (mis. `variantId 59866790` HANYA pernah dipasangkan dengan
`"COURT FEES - 1"`). Akibatnya:

- Nomor 1–4 muncul dan **cocok** dengan 4 court Padel AYO yang sebenarnya.
- Nomor 5–9 muncul tapi **TIDAK ADA** court Padel bernomor itu di AYO —
  kemungkinan salah ketik/nomor meja/legacy, BUKAN court sungguhan.
- Placeholder (`-`, `.`, `..`, `...`, `.....`, `,`) muncul jauh lebih sering
  daripada nomor valid — kasir tidak selalu mengisi nomor court.
- Pickleball **tidak pernah** punya suku kata bernomor sama sekali — Olsera
  tidak punya cara membedakan Pickleball 1 vs Pickleball 2 dari data yang ada.

**Kesimpulan (dipakai `lib/court-mapping.ts`):** court-level matching hanya
bisa dilakukan per-lapangan untuk Padel nomor 1–4 yang eksak. Semua baris
Olsera Padel lain (placeholder/nomor 5–9) dikumpulkan ke bucket terpisah
`Padel — Nomor Tidak Teridentifikasi` (tetap masuk total Padel bulanan/harian,
TIDAK masuk perbandingan per-court, ditandai `BUTUH_ADJUST_MANUAL`). Pickleball
HANYA direkonsiliasi di level agregat sport (`Pickleball (Gabungan)`) — bukan
per lapangan — karena Olsera memang tidak menangkap datanya. Ini bukan bug
kode; ini keterbatasan struktur data sumber, didokumentasikan sebagai known
limitation (Bagian E root cause #16 "Belum bisa dipastikan" tidak dipakai di
sini karena penyebabnya SUDAH diketahui — dipetakan ke kategori tersendiri
"OLSERA_COURT_NUMBER_NOT_CAPTURED", lihat `lib/reconciliation-root-cause.ts`).

## 3. Formula

Untuk satu (tanggal, court-bucket):

```
ayoRevenue    = Σ getRevenueAmount(booking)   untuk booking dengan date=tgl, courtKey cocok
ayoCount      = jumlah booking revenue-eligible pada (tgl, courtKey)
olseraRevenue = Σ item.amount                 untuk item Olsera dengan date=tgl, courtKey cocok,
                                                kategori classifyCategoryForCourtRevenue = "court"
olseraCount   = jumlah baris item tsb

difference = olseraRevenue - ayoRevenue   (konvensi sama dengan evaluateCourtRevenue)
status:
  |difference| <= Rp1        -> MATCH
  |difference| <= Rp5.000     -> MINOR_DIFFERENCE (toleransi default, dapat diubah per query)
  selainnya                   -> MISMATCH
  (lihat lib/reconciliation-rules.ts evaluateCourtRevenue untuk kasus AYO-only/
   Olsera-only/ambiguous/unmapped)
```

`item.amount` pada `olsera_order_items` SUDAH bersih (net, termasuk addon,
dikurangi discount) — tidak pernah ditambah addon lagi (lihat komentar field
`amount` di `lib/mongodb.ts`). Tidak ada field refund/void eksplisit pada
item — order yang dibatalkan/di-void di Olsera dihapus/tidak disimpan saat
sync (lihat `lib/olsera-sync.ts`), sehingga secara desain tidak ada baris
"refund" tersisa untuk direkonsiliasi; bila ditemukan indikasi sebaliknya saat
audit Bagian K, dicatat sebagai temuan baru, bukan diasumsikan.

Level 1 (Bulanan) = jumlah seluruh Level 2 (Harian) dalam periode.
Level 2 (Harian) = jumlah seluruh Level 3 (Court) pada tanggal itu.
Level 3 (Court) = dihitung langsung dari formula di atas per court-bucket.
Level 4 (Jam/slot) dan Level 5 (Booking/transaksi): lihat §4 — bersifat
drill-down informasional, BUKAN finding otomatis tersimpan (tidak ada
identifier bersama untuk dipaksakan match 1:1).

## 4. Level 4 (Jam) dan Level 5 (Booking) — Batasan Jujur

AYO `start_time` = jam slot booking SEBENARNYA (jadwal main). Olsera
`orderDate` membawa jam order (`order_time`) = jam transaksi dibuat di kasir —
BUKAN jam main, bisa di awal/akhir sesi tergantung kapan kasir menutup order.
**Tidak ada identifier bersama** (booking AYO tidak membawa referensi order
Olsera atau sebaliknya).

Karena itu Level 4/5 diimplementasikan sebagai **drill-down read-only**, bukan
rule matching otomatis:

- Level 4: AYO dikelompokkan per jam slot asli (`start_time`); Olsera
  ditampilkan per jam order (`orderDate` time) pada tanggal+court-bucket yang
  sama, berdampingan — pengguna membandingkan visual, sistem TIDAK mengklaim
  "jam X AYO = jam X Olsera".
- Level 5: kandidat pasangan booking↔transaksi ditawarkan HANYA sebagai saran
  (candidate correlation: tanggal+court-bucket sama, nominal sama persis, jam
  order dalam ±60 menit dari jam mulai booking) dengan `mappingConfidence`
  eksplisit `"LOW"`/`"MEDIUM"` — TIDAK PERNAH `"HIGH"` dan TIDAK PERNAH
  status `MATCH` otomatis. Bila tidak ada kandidat yang memenuhi syarat,
  statusnya `NOT_COMPARABLE`, bukan dipaksakan.

## 5. Status Taxonomy yang Dipakai

Modul ini memakai ulang `ReconciliationStatus` (`lib/reconciliation-types.ts`,
sudah ada, 10 nilai) — TIDAK membuat enum status baru. Pemetaan ke istilah
Bahasa Indonesia/Inggris pada instruksi tugas:

| Istilah tugas | `ReconciliationStatus` |
|---|---|
| MATCH | `MATCH` |
| MATCH WITH ROUNDING | `MINOR_DIFFERENCE` (selisih <= toleransi) |
| AYO ONLY | `MISSING_IN_OLSERA` |
| OLSERA ONLY | `MISSING_IN_AYO` |
| AMOUNT MISMATCH | `MISMATCH` (`difference.revenue` yang mendominasi, lihat `diagnostics.revenueStatus`) |
| COURT MISMATCH | `AMBIGUOUS` (courtMappingConfidence ambiguous) atau `BUTUH_ADJUST_MANUAL` (unmapped) — dibedakan lewat `diagnostics.reason`, bukan status terpisah |
| CATEGORY MISMATCH | `AMBIGUOUS` dengan `diagnostics.reason` "klasifikasi kategori tidak pasti" |
| DATE MISMATCH | tidak berlaku pada granularity ini (perbandingan sudah per-tanggal); relevan hanya di Level 5 sebagai bagian evaluasi kandidat (`diagnostics.dateGapDays`) |
| CANCEL/REFUND DIFFERENCE | root cause classifier (`lib/reconciliation-root-cause.ts`), bukan status — lihat §6 |
| NEEDS MANUAL REVIEW | `BUTUH_ADJUST_MANUAL` / `AMBIGUOUS` (`requiresManualAdjustment(status) === true`) |
| NOT COMPARABLE | `NOT_CHECKED` (dipakai HANYA untuk Level 4/5 candidate correlation yang tidak punya kandidat layak) |

Alasan reuse (bukan enum baru): 10 status yang ada sudah lengkap secara
semantik dan sudah diuji (`lib/reconciliation-types.test.ts`,
`lib/reconciliation-rules.test.ts`); menambah enum paralel akan memecah
kontrak generik yang dipakai `reconciliation-store.ts`/`reconciliation-manual-resolution.ts`/UI
findings yang sudah ada.

## 6. Root Cause Classification (Bagian E)

Lihat `lib/reconciliation-root-cause.ts` untuk implementasi. 16 kategori tugas
dipetakan ke `rootCauseId` + `confidence` (`HIGH`/`MEDIUM`/`LOW`) + evidence
count, dievaluasi dari `RuleEvaluation` (`evaluateCourtRevenue` output) +
sinyal tambahan (status booking AYO, `categoryResolutionStatus` Olsera,
apakah court-bucket adalah `Padel — Nomor Tidak Teridentifikasi`/`Pickleball
(Gabungan)`). Setiap root cause WAJIB evidence (jumlah kasus, periode,
nominal) — tidak ada root cause tanpa data pendukung.

## 7. Known Divergence — Modul Ledger vs Modul Kategori

`app/reconciliation` (Rekonsiliasi Omzet AYOSERA, ledger 40001+40004) dan
modul granular ini (kategori POS) BOLEH menghasilkan total bulanan yang tidak
identik, karena:

- Ledger sudah melalui proses reklasifikasi akuntansi (40004 → 21003) yang
  tidak mengubah kategori transaksi POS.
- Ledger bisa memuat koreksi/jurnal manual yang tidak berasal dari transaksi
  POS kategori lapangan.
- Modul granular mengecualikan baris yang kategorinya "ambiguous" dari total
  Olsera (lihat §1) — ledger tidak melakukan pengecualian ini.

Kedua angka ditampilkan berdampingan di menu supervisor (§ Bagian H) dengan
label sumber masing-masing — TIDAK digabung menjadi satu angka "benar".

## 8. Audit End-to-End (Bagian B/C) — Ringkasan Temuan

**AYO (`lib/booking-mapper.ts` → `bookings`):**

- Duplicate booking dicegah struktural: `_id` Mongo default + upsert oleh
  `order_detail_id`/`booking_id` di `lib/booking-sync.ts` (bukan insert
  polos) — tidak ditemukan duplikat saat sampling.
- Cancelled/zero/internal sudah konsisten dikeluarkan dari revenue lewat
  `lib/revenue.ts` (satu-satunya gate, dipakai ulang di seluruh dashboard,
  export, dan modul ini — tidak ada logic eligibility kedua yang bisa
  divergen).
- Reschedule (`changeType: "rescheduled"`, `previousSchedule`) mengubah
  `date`/`start_time` booking ITU SENDIRI menjadi jadwal baru — rekonsiliasi
  granular memakai `date` TERKINI (jadwal main efektif), bukan tanggal
  dibuat, konsisten dengan field yang sama dipakai dashboard.
- `booking_session.ts` (pengelompokan multi-slot untuk tampilan) TIDAK
  dipakai modul ini — setiap booking (per slot jam) tetap dihitung individual
  saat SUM revenue, karena `getRevenueAmount` dijumlahkan per baris; total
  tidak berubah baik dihitung per-slot maupun per-sesi (SUM assosiatif) —
  dikonfirmasi oleh test `lib/booking-session.test.ts` yang sudah ada
  (`totalRevenue` sesi = jumlah `getRevenueAmount` tiap slot).
- `booking_source` (`order`/`reservation`) keduanya revenue-eligible bila
  lolos `isRevenueEligibleTransaction` — tidak ada pengecualian source di
  formula (sesuai instruksi: source bukan kriteria eligibility).

**Olsera (`lib/olsera-sync.ts`/`lib/olsera-category-resolver.ts` →
`olsera_order_items`):**

- Duplicate item dicegah struktural: `_id` = `orderitems[i].id` dari Olsera
  (unique per baris), upsert saat sync — tidak ada duplicate count.
- 6.271 baris historis kehilangan `productId`/`variantId`/`sku` (temuan lama,
  dicatat di instruksi tugas) — TIDAK disentuh/backfill di milestone ini
  (lihat §Bagian F). Baris court-fee yang disampling (§2) SEMUA punya
  `productId`/`variantId` terisi — indikasi gap 6.271 baris itu didominasi
  kategori non-lapangan; dikonfirmasi kuantitatif saat audit production
  (Bagian K), bukan diasumsikan di sini.
- Kategori: `categoryResolutionStatus` `"resolved"`/`"unresolved"` sudah
  tersimpan saat sync (lihat sampel §2 — seluruh baris court-fee sampel
  `"resolved"` via method `"product-id"`). Baris `"unresolved"` TIDAK
  dimasukkan ke sisi Olsera formula (fallback ke `AMBIGUOUS`, lihat §5).
- Refund/void: tidak ada field status pada `OlseraOrderItemDocument` — order
  yang dibatalkan di Olsera dikeluarkan saat sync (lihat komentar
  `lib/olsera-sync.ts` ~baris 639), bukan disimpan dengan flag. Jika audit
  Bagian K menemukan bukti sebaliknya (order refund yang tetap tersimpan),
  itu dicatat sebagai temuan baru root cause "Refund/cancel/reversal" — lihat
  `lib/reconciliation-root-cause.ts`.
