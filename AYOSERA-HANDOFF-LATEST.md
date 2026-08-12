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
