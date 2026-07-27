# Dry-Run Phase 5B — Mei 2026 (storeId 324175)

Status: **TIDAK DAPAT DIEKSEKUSI terhadap database sungguhan dalam sesi ini** — lihat `tmp/reconciliation-phase5b-dryrun-2026-05.json` untuk detail.

## 1. Penyebab

Sesi kerja ini tidak memiliki akses jaringan/DNS keluar ke MongoDB Atlas (`mongodb+srv://cluster0.dqvtxp8.mongodb.net`). Diverifikasi dua cara:

- `curl` langsung ke host cluster: `Couldn't resolve host` (exit code 6 — gagal DNS, bukan gagal auth/kredensial).
- Runner sendiri (`npx tsx --conditions=react-server scripts/run-reconciliation-internal-olsera.ts --period=2026-05 ...`): gagal dengan `MongoServerSelectionError: Server selection timed out after 5000 ms`.

Ini adalah **keterbatasan lingkungan eksekusi**, bukan bug pada Runner/Source Adapter — kode sudah type-check bersih dan seluruh unit test (dengan MongoDB tiruan in-memory) lulus.

## 2. Apa yang SUDAH divalidasi (tanpa database sungguhan)

| Area | Cara validasi | Hasil |
| --- | --- | --- |
| Rule engine (status/impact/confidence) | node:test murni, tanpa I/O | PASS (bagian dari 82 test `test:reconciliation-core`) |
| Source adapter CATEGORY/PRODUCT/INVENTORY/SNAPSHOT | node:test dengan koleksi tiruan in-memory (DI) meniru struktur data nyata | 23 test PASS (`lib/reconciliation-sources.test.ts`) |
| Runner (lifecycle, idempotency, checkpoint, partial failure) | node:test dengan koleksi tiruan in-memory (DI) | 13 test PASS (`lib/reconciliation-runner.test.ts`) |
| CLI guard (dry-run default, --write wajib env) | Verifikasi statis source (`lib/reconciliation-cli.test.ts`) | 5 test PASS |
| Logika klasifikasi PRODUCT | Port LANGSUNG dari `scripts/audit-order-item-identity-2026.ts` (skrip yang sudah memvalidasi baris gapped = 6.271 pada periode 2026-05-01..2026-07-13) | Sub-case sama persis: exact/variant-ambiguous/historical/alias/missing, dengan Known Case ref yang sama (`phase2-ambiguous-276`, `phase3-historical-product-4`) |
| Logika inventory movement productId null | Port dari `scripts/audit-inventory-movement-37.ts` (37 movement) | Known Case ref sama (`phase3-movement-37`), TIDAK PERNAH mengisi productId otomatis (diverifikasi test) |

## 3. Catatan penting soal cakupan angka 276/37/4

Angka 276 (ambiguous)/37 (movement productId null)/4 (historical product) dari audit Phase 2/3 sebelumnya dihitung untuk **rentang 2026-05-01 s/d 2026-07-13** (~2,5 bulan penuh), **bukan** bulan Mei 2026 saja.

Runner Phase 5B men-scope PER PERIODE BULANAN (`period=2026-05` → hanya tanggal 2026-05-01..2026-05-31, sesuai `scope: "monthly"` pada `reconciliation_runs`). Karena itu:

- **Bila database sungguhan tersedia**, total finding domain PRODUCT untuk periode Mei 2026 SAJA diharapkan **lebih kecil** dari 276/4 (karena itu porsi ~1 bulan dari rentang 2,5 bulan), dan total movement `productId null` untuk Mei 2026 saja diharapkan **lebih kecil** dari 37.
- **Ini BUKAN indikasi job tidak valid** — ini konsekuensi struktural dari scoping bulanan by design (lihat `docs/reconciliation-design.md`). Menyamakan angka penuh 276/37/4 dengan hasil satu bulan justru akan jadi tanda ada bug (over-counting), bukan sebaliknya.
- Validasi silang yang benar: jumlahkan hasil run bulanan Mei+Juni+Juli 2026 (tiga run terpisah, tidak boleh dicampur satu run) dan bandingkan totalnya dengan 276/37/4 — ini adalah langkah verifikasi yang direkomendasikan begitu koneksi database tersedia.

## 4. Rekomendasi tindak lanjut

1. Jalankan ulang perintah berikut dari lingkungan dengan akses jaringan ke MongoDB Atlas:
   ```
   npx tsx --conditions=react-server scripts/run-reconciliation-internal-olsera.ts --period=2026-05 --json-output=tmp/reconciliation-phase5b-dryrun-2026-05.json
   ```
2. Ulangi untuk `--period=2026-06` dan `--period=2026-07` (dry-run, TANPA `--write`).
3. Jumlahkan `byDomain.PRODUCT` (status AMBIGUOUS + subCase historical-product) dan `byDomain.INVENTORY` (entityKey `movement-null:*`) dari ketiga run, bandingkan dengan 276/4/37.
4. HANYA setelah dry-run tiga periode ini diverifikasi cocok (dengan penjelasan bila ada selisih wajar, mis. transaksi baru masuk sejak audit awal dijalankan), pertimbangkan mode `--write` — tetap dengan guard `ALLOW_RECONCILIATION_WRITE=1` dan tinjauan manual, TIDAK dilakukan di sesi ini.

Tidak ada tulis ke MongoDB, tidak ada commit/push/deploy dilakukan pada langkah ini.
