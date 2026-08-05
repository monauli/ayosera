# Monitoring Integritas Data AYO

Modul privat ini hanya tersedia untuk user ID yang ada di `AYOSERA_PRIVATE_TOOLS_USER_IDS`.

- `AYO Booking` diaudit dengan identitas `booking_id`.
- `AYO Payment Events` diaudit dengan identitas `paymentEventIdentity`: `source_table + booking_id + reservation_payment_id`, atau fallback native `id` yang deterministik.
- Audit membandingkan API AYO dengan MongoDB pada rentang tanggal maksimal 31 hari dan menyimpan ringkasan serta daftar identitas yang hilang di server. Hasil sumber tidak lengkap, duplikat, atau konflik selalu memerlukan review manual.
- Repair hanya dapat memakai audit `GAP_FOUND` yang masih segar (15 menit), hanya untuk daftar identitas tersimpan tersebut, dan tidak menghapus atau menimpa record yang sudah ada.
- Endpoint cron `/api/cron/integration-audit` melakukan audit read-only 30 hari terakhir; ia tidak menjalankan repair atau sync.

## Olsera Sales

Audit Olsera memakai list/detail order dari `lib/olsera-sync.ts` yang sama dengan sync produksi, namun hanya membaca API dan `olsera_order_items`. Order direpresentasikan oleh `orderNo` (identity produksi yang tersimpan pada item) dan item memakai `_id` item Olsera. Repair hanya memakai identity item yang tersimpan dari audit `GAP_FOUND`, dengan `$setOnInsert`; checkpoint, kategori, ledger, inventory, dan data lokal existing tidak diubah.
Aktifkan modul privat dengan `AYOSERA_PRIVATE_TOOLS_USER_IDS=id-1,id-2`. Nilai kosong menonaktifkan modul untuk semua pengguna, termasuk supervisor.

Cron mingguan dapat memanggil `POST /api/cron/integration-audit` dengan `Authorization: Bearer $CRON_SECRET`. Endpoint ini read-only dan tidak menjalankan Sync AYO/Olsera atau auto-repair tanpa identity sumber yang terverifikasi.
