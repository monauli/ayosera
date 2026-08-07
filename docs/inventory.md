# Modul Inventori — Lifecycle Snapshot Bulanan

## Latar Belakang

Audit (lihat `tmp/ai-handoff.md` "Inventory July-August Product Timing Audit") membuktikan bug sistemik: `ensureMonthlySnapshotChain()` menganggap "bulan sudah punya dokumen" sebagai "bulan ini sudah selesai selamanya" — termasuk untuk bulan yang saat itu masih berjalan. Produk yang dibuat di Olsera setelah tanggal generate pertama tidak pernah masuk ke bulan yang sebenarnya, dan baru muncul di bulan berikutnya sebagai "produk baru". Dokumen ini menjelaskan lifecycle yang menggantikannya.

## Status Periode

`getInventoryPeriodState(year, month, now)` (`lib/olsera-inventory-monthly-snapshot-core.ts`) — satu sumber kebenaran, reuse `jakartaCurrentPeriod` dari `lib/olsera-financial-core.ts` (timezone bisnis Asia/Jakarta yang sama dipakai Laporan Keuangan/Rekonsiliasi, tidak ada timezone kedua):

- **future** — bulan belum dimulai. Tidak pernah digenerate.
- **current** — bulan kalender yang sedang berjalan. **Selalu dinamis** — setiap kali diminta, dihitung ulang dari sumber Olsera terbaru.
- **historical** — bulan sudah lewat. Dipercaya final SETELAH mendapat satu kali finalisasi.

## `finalizedAt` (field baru, backward compatible)

Ditambahkan ke `OlseraInventoryMonthlySnapshotDocument` (`lib/mongodb.ts`), opsional:

- `null` — dokumen ditulis saat bulan itu masih `current` (belum final).
- `Date` — dokumen ditulis saat bulan itu sudah `historical` (dipercaya final, tidak dihitung ulang lagi).
- **absen** (dokumen lama sebelum field ini ada, Feb-Jul 2026) — diperlakukan SAMA seperti `Date` (dipercaya final). Ini SENGAJA: mendeploy fix ini TIDAK memicu hitung ulang massal seluruh histori lama hanya karena field itu tidak ada. Bulan lama yang terbukti stale (lihat audit) dibetulkan lewat proses eksplisit (§ Audit & Rebuild), bukan otomatis.

## `ensureMonthlySnapshotChain()` — Alur Baru

`lib/olsera-inventory-monthly-snapshot-store.ts`:

1. Tentukan `state = getInventoryPeriodState(year, month, now)`. `future` → error langsung, tidak pernah digenerate.
2. Bila `state === "historical"` DAN sudah ada dokumen DAN semuanya `finalizedAt !== null` (termasuk dokumen legacy tanpa field) → **percaya langsung**, tidak memanggil API sama sekali (item C PRD: jangan panggil Olsera setiap page load).
3. Selain itu (belum ada dokumen, ATAU `current`, ATAU `historical` tapi ada `finalizedAt === null`) → **hitung ulang bulan ini**, anchor dari hasil TERBARU bulan sebelumnya — dipanggil REKURSIF (`ensureMonthlySnapshotChain` bulan N-1 dulu), sehingga bulan sebelumnya yang JUGA belum difinalisasi otomatis dibetulkan lebih dulu sebelum dipakai sebagai opening bulan ini. Rekursi dibatasi jumlah bulan kalender nyata sejak baseline Juni 2026 (dalam praktik hanya 1-2 level).
4. Zona mundur (≤ Juni 2026) tidak berubah — tidak ada konsep "current" untuk bulan sejauh itu di masa lalu.

Produk baru yang muncul di tengah bulan otomatis tertangkap — logika `computeMonthlyStepForward` (tidak diubah) sudah benar menambahkan entity baru kapan pun dijalankan ulang untuk bulan yang bersangkutan; bug lama murni karena fungsi itu tidak pernah dipanggil ulang.

## Aturan Kedua Inventori — Sembunyikan Produk Tanpa Aktivitas

Produk dengan `openingQty=0`, tidak ada `incomingQty`/`returnQty`/`salesQty`/`outgoingQty`, dan `closingQty=0` pada suatu bulan **tidak perlu tampil** di dashboard Stok Bulanan, Export Inventori dua-sheet, MAUPUN Laporan Stock Opname Bulanan untuk bulan itu (keputusan bisnis final — sebelumnya Stock Opname dikecualikan, sekarang disamakan). Begitu ada aktivitas apa pun (termasuk restock di bulan berikutnya), produk tampil kembali otomatis.

- **Murni aturan tampilan** — histori/dokumen snapshot/produk master TIDAK PERNAH dihapus dari database, perhitungan qty tidak berubah.
- Helper tunggal: `hasInventoryActivity` (`lib/olsera-inventory-ui.ts`) — dipakai BERSAMA oleh dashboard (`components/olsera-inventory-panel.tsx` via `visibleMonthlyInventoryRows`), Export Inventori dua-sheet (`lib/olsera-inventory-two-sheet-export.ts`), DAN Laporan Stock Opname Bulanan (`lib/olsera-inventory-monthly-export.ts`, `buildMonthlyRowsFromMonthlySnapshots`), supaya ketiganya selalu konsisten — satu logic, tidak ada filter yang copy-paste berbeda-beda.
- Baris dengan status ledger `boundary-only`/`incomplete` (data belum lengkap) SELALU dianggap punya aktivitas — tidak pernah disembunyikan hanya karena datanya belum lengkap.
- Berbeda dan independen dari "Hidden Item" (kategori LABERS/JASA HOST, `isHiddenInventoryCategory`) — kedua aturan bisa berlaku bersamaan atau sendiri-sendiri.
- Rencana lanjutan (BELUM diimplementasikan): export terpisah "Barang Habis Terjual" memakai histori yang sama — arsitektur ini sengaja tidak menghapus apa pun supaya export itu bisa dibangun nanti.

## Audit Read-Only Per Periode

```
npm run inventory:audit-periods
npm run inventory:audit-periods -- --from=2026-02 --to=2026-08
npm run inventory:audit-periods -- --json-output=tmp/inventory-audit-periods.json
```

`scripts/audit-inventory-monthly-periods.ts` — selalu read-only (tidak pernah menulis Mongo). Untuk setiap bulan: bandingkan dokumen lokal vs tarikan LIVE `stockmovement` API Olsera pada rentang tanggal bulan yang sama (bukti data langsung, BUKAN menebak dari `createdAt` — audit membuktikan `createdAt` lokal tidak cukup). Klasifikasi (`classifySnapshotPeriod`, `lib/inventory-snapshot-pipeline-audit-core.ts`):

- **OK** — cocok, tidak perlu tindakan.
- **CURRENT_REFRESHABLE** — bulan berjalan, otomatis dihitung ulang tiap diakses.
- **STALE_NEEDS_REBUILD** — ada entity di sumber Olsera yang TIDAK ADA dokumen lokalnya sama sekali (bukti pasti staleness).
- **MANUAL_REVIEW** — qty berbeda tanpa entity yang hilang (kemungkinan productId rename/alias, bukan sekadar stale) — perlu tinjauan manusia sebelum rebuild.

## Rebuild Eksplisit (Aman)

```
node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/backfill-monthly-snapshot.ts --period=2026-07
node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/backfill-monthly-snapshot.ts --from=2026-07 --to=2026-08 --write
```

`scripts/backfill-monthly-snapshot.ts`:

- **DEFAULT dry-run** — tampilkan ringkasan before/after (berapa entity baru/berubah/tidak berubah + detail), TIDAK menulis apa pun.
- **`--write` wajib eksplisit** untuk benar-benar menulis.
- **`--period=YYYY-MM` atau `--from=/--to=` wajib** — tidak ada default "semua bulan", mencegah rebuild tidak sengaja menyentuh bulan yang tidak dimaksud.
- Upsert by `_id` (idempotent) — tidak pernah menghapus collection, tidak pernah menyentuh bulan di luar rentang yang diminta.
- Fail-safe: bila fetch sumber gagal, dilaporkan sebagai error, TIDAK menimpa dokumen lama yang valid dengan data kosong/parsial.

Alur yang disarankan: `inventory:audit-periods` (dry-run) dulu → review bulan mana `STALE_NEEDS_REBUILD` → `backfill-monthly-snapshot.ts` TANPA `--write` untuk lihat detail perubahan → setelah direview, jalankan ulang DENGAN `--write`.

## Data Historis (Feb-Jul 2026)

Belum direbuild dalam sesi implementasi lifecycle fix ini (lihat `tmp/ai-handoff.md` untuk hasil dry-run terbaru) — perlu review manusia dulu sebelum `--write` dijalankan terhadap data production.
