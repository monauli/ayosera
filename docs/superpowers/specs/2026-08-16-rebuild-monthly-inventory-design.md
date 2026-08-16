# Rebuild Monthly Inventory Design

## Goal

Menambahkan proses supervisor reusable untuk dry-run dan rebuild snapshot Inventori satu periode, diverifikasi hanya pada Maret 2026.

## Scope and safety

- `Periksa Dulu` read-only; tidak menulis snapshot atau backup.
- `Proses` hanya menerima satu periode, menolak periode terkunci, dan hanya mengganti snapshot periode tersebut.
- Sumber angka memakai closing bulan sebelumnya dan seluruh stock movement Olsera ter-pagination; katalog hanya identitas.
- Snapshot lama disalin ke backup sebelum replace; kegagalan tidak menghapus snapshot lama.
- Upsert berdasarkan identity snapshot existing sehingga rerun idempotent dan tidak duplikat.
- Export tetap read-only dan tidak memanggil rebuild.
- UI lock di halaman Inventori dihapus; lock backend dan kontrol Rekonsiliasi Inventori tetap.
- Pekerjaan produksi hanya Maret 2026; tidak ada carry-forward April.

## Architecture

`rebuildMonthlyInventory` memakai helper matching, pagination, formula, dan repository snapshot existing. Mode `dryRun` mengembalikan diagnostics, diff, dan candidate rows tanpa mutasi. Mode `write` melakukan lock guard, backup, replace/upsert target month, lalu membaca ulang target. Endpoint supervisor memanggil service; panel Rekonsiliasi Inventori menampilkan dry-run dan mengaktifkan Proses hanya saat aman.

## Difference report

Diagnostics yang berbeda atau perlu konfirmasi ditulis ke workbook `tmp/reports/AYOSERA-Selisih-Inventori-Bulanan-2026.xlsx` jika Google Drive tidak terhubung. Workbook memiliki Ringkasan, Maret, April, Mei, Juni, Juli, Agustus; sheet bulanan hanya berisi perbedaan.

## Verification

Regression tests mencakup dry-run no-write, previous closing anchor, carry-forward, new products, pagination, null variant, deduplication, opname signs, formula, rerun, lock guard, backup/failure safety, month isolation, and hidden Inventory lock button. Run inventory, snapshot, reconciliation, stock-opname, export, typecheck, scoped lint, build, and diff check. Production read-back is limited to March and does not lock it.
