# AYOSERA — Handoff Audit Mismatch Kategori Penjualan Februari 2026

## Audit item-level final

Workspace inspection menemukan export resmi/detail berikut:

- `Omset Kategori-2026-02.xlsx` — agregat kategori harian, bukan detail order/item.
- `Rincian Penjualan-2026-02-27__2026-02-27.xlsx` — detail hanya untuk 27 Februari.
- Tidak ada export `Rincian Penjualan` atau `Transaksi` untuk seluruh 1–28 Februari.

Karena export detail resmi Februari penuh tidak tersedia, pencocokan item-level untuk seluruh bulan tidak dapat dilakukan secara valid. Export 27 Februari juga tidak cukup untuk membuktikan selisih LABERS +1/Rp21.250 dan SEWA RAKET +2/Rp60.000.

### Exact mismatch

Belum ditemukan. Tidak ada item yang boleh ditetapkan sebagai penyebab tanpa pasangan data resmi dengan kunci `orderNo + tanggal + nama item + qty + nominal`.

### Root cause

Belum terbukti. Hipotesis timezone dan `openorder paid` sudah gugur. Kandidat sebelumnya berasal dari `closeorder`, sehingga audit agregat maupun endpoint belum bisa menjelaskan mengapa laporan resmi tidak menghitungnya. Status `Z` pada order list juga belum membuktikan exclusion dari laporan kategori.

### Data yang diperlukan

Ambil dari Olsera UI/API export:

1. `Rincian Penjualan` untuk 2026-02-01 sampai 2026-02-28, seluruh halaman.
2. Kolom order number, tanggal/waktu transaksi, status, nama produk/variant, qty, nominal item, product/category bila tersedia.
3. Jika export tidak memuat status, export/list order Februari yang memuat order id, order number, status, dan tanggal.

Setelah file tersedia, lakukan join item-level terhadap `olsera_order_items`; jangan koreksi aggregate manual sebelum join selesai.

## Status audit

Audit bersifat read-only. Tidak ada database, snapshot, alias, source code, commit, atau push yang diubah.

## Hasil

Selisih yang harus dijelaskan:

- LABERS: +1 qty / Rp21.250
- SEWA RAKET: +2 qty / Rp60.000
- Total: +3 qty / Rp81.250

Audit targeted API dilakukan pada tanggal kandidat 5, 6, dan 18 Februari. Daftar `openorder?is_paid=1` juga dicek untuk setiap tanggal 1–28 Februari:

- `openorder?is_paid=1` kosong pada seluruh tanggal Februari.
- Kandidat LABERS dan SEWA RAKET yang diperiksa berasal dari `closeorder`.
- Tidak ada kandidat nominal tersebut yang terbukti hanya berada di `openorder paid`.

Source code membuktikan bahwa sync produksi AYOSERA mengambil:

1. `closeorder`;
2. `openorder` dengan `is_paid=1`;
3. deduplikasi berdasarkan order id.

Sebaliknya, `scripts/validate-olsera-category.ts` hanya mengambil `closeorder`. Perbedaan filter memang ada, tetapi tidak menjelaskan mismatch Februari karena `openorder paid` kosong pada bulan tersebut.

Exact tiga order penyebab belum terbukti. Dokumen `olsera_order_items` tidak menyimpan provenance endpoint, tetapi targeted API berhasil mengklasifikasikan kandidat yang diuji. Query MongoDB tambahan gagal pada koneksi DNS `querySrv ECONNREFUSED`.

## Kandidat nominal

- LABERS: `DF0226020500000033`, `DF0226020500000048`, dan `DF0226020500000061`; `closeorder`, order status `Z`, tanggal 2026-02-05, item lokal qty 1 / Rp21.250.
- SEWA RAKET: `DF0226020600000096` dan `DF0226020600000109`; `closeorder`, status `Z`, tanggal 2026-02-06, kandidat order total Rp30.000. `DF0226021800000662` juga `closeorder`, status `Z`, tanggal 2026-02-18, order total Rp60.000.
- `openorder paid`: tidak ada hasil untuk seluruh Februari.

Kandidat-kandidat tersebut bukan exact penyebab mismatch karena berada di `closeorder`, source yang juga dipakai laporan resmi. Tidak ada dasar untuk memilih tiga order tertentu dari kandidat-kandidat yang nominalnya sama.

## Status dan tanggal

Audit lokal sebelumnya menunjukkan item kandidat berstatus `A` dan tanggal transaksi Februari. `created_time` berbeda sekitar 7 jam dari `orderDate` karena UTC, tetapi kode produksi tidak memakai `created_time` untuk menentukan bulan. Kode memakai `order_time`/`transaction_time`/`paid_at`, lalu fallback ke `order_date`.

Dengan demikian, root cause timezone, rollover tanggal, dan perbedaan `closeorder` versus `openorder paid` belum terbukti. Hipotesis openorder paid gugur untuk Februari.

## File penyebab

- `lib/olsera-sync.ts:160` — pengambilan order harian.
- `lib/olsera-sync.ts:311` — aturan tanggal transaksi; `created_time` tidak digunakan.
- `lib/olsera-sync.ts:478` — produksi mengambil close + open paid.
- `scripts/validate-olsera-category.ts:294` — validasi hanya mengambil closeorder.

## Rekomendasi fix paling kecil

Jangan mengubah filter ke `closeorder` saja. Audit ini tidak mendukungnya sebagai fix. Audit berikutnya harus membandingkan detail item dan aturan agregasi/export laporan resmi, termasuk status `Z` dan mapping kategori. Jangan mengubah nominal atau menghapus item secara manual.

## Perubahan

None selain file handoff ini.

## Commit/push

None.

## Next step

Bandingkan export/report resmi Olsera pada level item untuk menemukan tiga item exact. Jangan ubah filter sebelum penyebab terbukti; hasil targeted saat ini menunjukkan kandidat nominal yang ditemukan juga merupakan `closeorder`.

## Kategori Februari — fix generic

Perubahan lokal yang disiapkan:

- `lib/olsera-sync.ts` menormalkan field retur Olsera (`return_qty`, `return_quantity`, `returned_qty`, `refund_qty`, serta field nominal pasangannya) sebelum agregasi dan penyimpanan item. Nilai negatif yang sudah diberikan Olsera dipertahankan.
- Kategori asli dari payload transaksi (`category_name`/`product_category_name`) diprioritaskan, sehingga item `CUSTOM` tidak mengikuti kategori katalog `MINUMAN`.
- `scripts/backfill-olsera-categories.ts` memakai aturan yang sama untuk data historis dan membangun ulang agregat dari item.
- Regression test ditambahkan di `lib/olsera-sync-returns.test.ts`.

Target Februari belum diverifikasi dari database karena koneksi MongoDB lokal gagal `querySrv ECONNREFUSED`. Tidak ada angka target yang diklaim tanpa data.

## Bukti retur resmi dan status finalisasi

Retur resmi yang menjadi regression case:

- `DF0226020500000033`, `ICED LEMON TEA`: sale `+1/Rp21.250`, return `-1/-Rp21.250`, 2026-02-05 12:22:51; net LABERS 0.
- `DF0226021100000399`, `RAKET STANDAR`: sale `+2/Rp60.000`, return `-2/-Rp60.000`, 2026-02-11 22:58:08; `RAKET PREMIUM +1/Rp50.000` tetap valid; net kontribusi order untuk SEWA RAKET adalah 1/Rp50.000.

Pipeline tidak mensintesis retur dari field `return_qty`; setiap baris negatif dari Olsera diproses dan disimpan, lalu mengurangi qty/nominal kategori yang sama. CUSTOM tetap mengikuti kategori asli transaksi.

Regression test exact sudah lulus. Typecheck, build, targeted export tests, dan `git diff --check` juga lulus. Verifikasi angka Februari terhadap database masih BLOCKED oleh `querySrv ECONNREFUSED`; commit dan push harus menunggu verifikasi tersebut.

## Retry verifikasi MongoDB

Retry final dilakukan read-only untuk agregat `olsera_order_items` pada 2026-02-01 s/d 2026-02-28. MongoDB tetap tidak reachable:

`querySrv ECONNREFUSED _mongodb._tcp.cluster0.dqvtxp8.mongodb.net`

Target berikut belum dapat diverifikasi dari database:

- Total 1.439 / Rp62.367.200
- LABERS 446 / Rp14.491.200
- MINUMAN 649 / Rp8.426.000
- SEWA RAKET 186 / Rp6.840.000
- CUSTOM 1 / Rp20.000

Sesuai guard, tidak ada commit dan tidak ada push. Perubahan aman tetap lokal.

## WIP handoff 2026-08-12

- February category MongoDB verification: **BLOCKED** (`querySrv ECONNREFUSED`); target angka belum terverifikasi dari database.
- YONEX historical lineage/sales audit: **UNRESOLVED**; jangan melakukan inventory write atau rekonstruksi tanpa bukti tambahan.
- ODEA closing dan manual adjustment `+64`: **NOT FINAL / UNPROVEN**; jangan deploy atau menerapkan perubahan tersebut.
- Branch WIP ini boleh berisi safe/WIP code dan handoff, tetapi bukan approval production.

## Diagnosis MongoDB home PC — 2026-08-12

- **Root cause koneksi awal:** resolver DNS lokal Windows pada `127.0.2.2`/`127.0.2.3` menolak query SRV MongoDB. Node mereproduksi `querySrv ECONNREFUSED`; tidak ada indikasi password, URI, database, atau application logic salah.
- **Pembuktian jaringan:** SRV `cluster0.dqvtxp8.mongodb.net` berhasil di-resolve melalui DNS Google `8.8.8.8` dan Cloudflare `1.1.1.1`.
- **Safest fix:** tidak ada perubahan code/config yang diperlukan. `lib/mongodb-dns.ts` sudah mendeteksi resolver loopback pada development dan memakai `8.8.8.8`/`1.1.1.1` sebagai fallback. Dengan inisialisasi aplikasi normal, MongoDB ping berhasil.
- **Safety:** pemeriksaan hanya `ping`, `find`, dan `aggregate`; tidak ada operasi tulis database. Nilai `.env`/credential tidak dicetak.

### Read-only February verification

Agregat `olsera_sales_by_category` dan agregat item tersimpan untuk `2026-02-01` sampai `2026-02-28` sama-sama menghasilkan:

- LABERS: **447 / Rp14.512.450** (target 446 / Rp14.491.200)
- MINUMAN: **650 / Rp8.446.000** (target 649 / Rp8.426.000)
- SEWA RAKET: **188 / Rp6.900.000** (target 186 / Rp6.840.000)
- CUSTOM: **tidak ada** (target 1 / Rp20.000)
- Total seluruh kategori tersimpan: **1.442 / Rp62.797.450** (target 1.439 / Rp62.367.200)

**Verification: NOT PASS.** Koneksi sudah dapat dipakai, tetapi angka produksi saat ini tidak sama dengan target. Tidak ada code/database change, commit, atau push.

## Dry-run rebuild kategori Februari — 2026-08-12

Dry-run read-only dilakukan dari `olsera_order_items` item-level untuk 2026-02-01..2026-02-28 dengan normalisasi item saat ini, bukan menjadikan `olsera_sales_by_category` sebagai hasil akhir.

### Actual source state

- Item-level source: **1.442 / Rp62.448.450**.
- `olsera_sales_by_category` lama: **1.442 / Rp62.797.450**.
- Selisih: **Rp349.000**, tanpa delta per kategori ketika dibandingkan dengan agregasi item-level. Kesimpulan: stale aggregate/materialized rows, bukan satu item penyebab yang dapat ditunjuk; jangan gunakan aggregate lama untuk rebuild.
- Baris retur negatif belum tersimpan di `olsera_order_items` pada home DB. Known official return evidence belum ter-materialisasi sebagai item rows:
  - LABERS: **-1 / -Rp21.250**
  - SEWA RAKET: **-2 / -Rp60.000**
- `Custom` ditemukan pada `DF0226022700000852`, qty 1 / Rp20.000, tetapi state tersimpan saat ini masih `MINUMAN`.

### Simulated result with WIP logic

Menerapkan secara dry-run (tanpa write) dua perubahan yang sudah didukung WIP:

1. Memasukkan baris retur resmi sebagai nilai negatif.
2. Memetakan item `Custom` ke kategori asli `CUSTOM`, bukan katalog `MINUMAN`.

Hasil simulasi:

- Total: **1.439 / Rp62.367.200** — cocok.
- LABERS: **446 / Rp14.491.200** — cocok.
- MINUMAN: **649 / Rp8.426.000** — cocok.
- SEWA RAKET: **186 / Rp6.840.000** — cocok.
- CUSTOM: **1 / Rp20.000** — cocok.

**Status dry-run: NOT PASS as a database-source verification.** Angka target hanya tercapai pada simulasi yang menambahkan tiga return rows berdasarkan evidence resmi dan memindahkan satu item `Custom`; source DB saat ini belum memuat tiga return rows tersebut dan masih menyimpan `Custom` sebagai MINUMAN. Tidak ada rencana write yang dijalankan, dan tidak ada commit/push.

## Audit source retur Olsera — 2026-08-12

Targeted live API audit dilakukan tanpa browser dan tanpa write, hanya untuk order `DF0226020500000033` (5 Feb) dan `DF0226021100000399` (11 Feb).

### Endpoint yang berhasil

- `GET /api/open-api/v1/id/order/closeorder?start_date=...&end_date=...` — menemukan kedua order; keduanya `status=Z`.
- `GET /api/open-api/v1/id/order/closeorder/detail?id={numeric-order-id}` — detail resmi berhasil diambil.
- `GET /api/open-api/v1/id/order/openorder?...&is_paid=1` — HTTP 404 pada kedua tanggal; tidak ada open paid.
- `GET /api/open-api/v1/en/inventory/stockmovement?start_date=2026-02-05&end_date=2026-02-11` — HTTP 200, tetapi hanya agregat per produk; `sum_return_qty` bernilai 0 pada seluruh 20 row dan tidak ada order number.

### Detail resmi dua order

- `DF0226020500000033`: order amount **Rp21.250**, item `ICED LEMON TEA`, qty **+1**, amount **+Rp21.250**, status item `A`. Detail tidak memiliki `return_qty`, `return_amount`, refund object, return transaction, atau baris negatif.
- `DF0226021100000399`: item `RAKET STANDAR`, qty **+2**, amount **+Rp60.000**, status item `A`; juga `RAKET PREMIUM` +1 / Rp50.000. Detail tidak memiliki field/baris retur.

### Endpoint retur/refund/transaction yang dicoba

`GET /return`, `/refund`, `/order/return`, `/order/refund`, `/transaction`, `/order/detail`, dan `/id/stockmovement` semuanya HTTP 404 (`Not Found Resource`). Kandidat report stockmovement yang relevan hanya tersedia pada prefix `/en/inventory/stockmovement` dan tidak menyediakan linkage order-level untuk retur.

### Kesimpulan dan rekomendasi

Source retur resmi **belum ditemukan** pada Open API yang tersedia. Dua target retur hanya dapat dibuktikan dari evidence/export resmi sebelumnya, bukan dari endpoint live yang berhasil diaudit. Belum ada endpoint generic yang aman untuk dipakai AYOSERA agar retur otomatis ikut sync.

`normalizeOlseraItem` sudah mendukung field generic `return_qty`/`return_quantity`/`returned_qty`/`refund_qty` dan pasangan nominalnya; rekomendasi perubahan paling kecil adalah mempertahankan normalizer tersebut, lalu menambahkan adapter hanya setelah Olsera menyediakan endpoint/export retur dengan order/item linkage. Jangan hardcode dua order dan jangan menganggap `sum_return_qty` stockmovement sebagai retur penjualan item.

Status: **BLOCKED — source retur API tidak tersedia/terbukti.** Tidak ada database write, commit, atau push.

## Approved February correction applied — 2026-08-12

Production correction was applied only for February 2026 using official Olsera export / manual-verified evidence.

- Two returns are stored in `olsera_sales_corrections`, not `olsera_order_items` or inventory movements, with explicit provenance and negative qty/amount.
- `Custom` order `DF0226022700000852` is now per-item `manual_override` → `CUSTOM`.
- February `olsera_sales_by_category` was rebuilt from item-level rows plus the two correction documents; the previous aggregate was not used as the source.
- RAKET PREMIUM remains +1 / Rp50.000. No YONEX, ODEA, inventory, or other-month changes were included.

Final verified result:

- Total: **1.439 / Rp62.367.200**
- LABERS: **446 / Rp14.491.200**
- MINUMAN: **649 / Rp8.426.000**
- SEWA RAKET: **186 / Rp6.840.000**
- CUSTOM: **1 / Rp20.000**

In-memory category export verification produced the same 17-sheet totals and grand total. Targeted correction/provenance and export-safety tests passed. Typecheck passed; build/push/deployment verification pending.

## Finalization status — 2026-08-12

- Final targeted/relevant tests, typecheck, production build, and `git diff --check`: **PASS**.
- Final commit pushed to `origin/main`: `3a0ee4b57691b49f949bbff0c62bec9ae43b25d7`.
- GitHub CI for that commit: **success**.
- Production February totals were verified against the production MongoDB state before push. Direct Vercel HTTP verification from the home PC remains unavailable because the configured production endpoint could not be reached; no production claim is made beyond the database verification.

## February export correction finalization — 2026-08-12

- `Rincian Penjualan` now merges the generic `olsera_sales_corrections` source, so approved historical returns render as negative rows; it does not hardcode February/order IDs in the export route.
- `Pembagian Hasil LABERS` now consumes the same correction source before calculating the percentage split.
- February generated export verification: Rincian **1.439 / Rp62.367.200**; LABERS **Rp14.491.200**; Padel 17,5% **Rp2.535.960**; Labers 82,5% **Rp11.955.240**; `Custom` remains `CUSTOM`.
- Export regression tests, relevant tests, typecheck, build, and `git diff --check`: **PASS**. No category aggregate, other month, YONEX, ODEA, or inventory logic was changed.
