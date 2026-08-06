# Monitoring Integritas Data AYO

Modul ini tersedia lewat menu **Audit & Sinkronisasi**, digerbangi modul akses biasa `"audit"`
(lihat `APP_MODULES` di `lib/auth.ts`) — dicentang/dicabut oleh supervisor lewat menu Pengguna,
sama seperti modul Olsera/Webhook/Rekonsiliasi lainnya. Supervisor otomatis memiliki semua modul
("Semua modul"), termasuk `"audit"`, tanpa perlu dicentang manual. UI (sidebar + komponen) dan API
(`requireModule("audit")` di `app/api/private/integration-monitor/route.ts`) memeriksa permission
yang sama — menyembunyikan menu tidak pernah menjadi satu-satunya pengaman, API selalu menolak
403 bagi akun tanpa modul ini.

> Env `AYOSERA_PRIVATE_TOOLS_USER_IDS` (allowlist user ID) **sudah deprecated dan tidak lagi
> dipakai untuk otorisasi runtime** — `lib/private-integration-monitor.ts` masih menyimpan
> `privateToolsAllowlist`/`isPrivateToolsUser` untuk kompatibilitas mundur (dan test lama), tapi
> tidak ada route yang memanggilnya lagi.

- `AYO Booking` diaudit dengan identitas `booking_id`.
- `AYO Payment Events` diaudit dengan identitas `paymentEventIdentity`: `source_table + booking_id + reservation_payment_id`, atau fallback native `id` yang deterministik.
- Audit membandingkan API AYO dengan MongoDB pada rentang tanggal maksimal 31 hari dan menyimpan ringkasan serta daftar identitas yang hilang di server. Hasil sumber tidak lengkap, duplikat, atau konflik selalu memerlukan review manual.
- Repair hanya dapat memakai audit `GAP_FOUND` yang masih segar (15 menit), hanya untuk daftar identitas tersimpan tersebut, dan tidak menghapus atau menimpa record yang sudah ada.
- Endpoint cron `/api/cron/integration-audit` melakukan audit read-only 30 hari terakhir; ia tidak menjalankan repair atau sync.

## Olsera Sales

Audit Olsera memakai list/detail order dari `lib/olsera-sync.ts` yang sama dengan sync produksi, namun hanya membaca API dan `olsera_order_items`. Order direpresentasikan oleh `orderNo` (identity produksi yang tersimpan pada item) dan item memakai `_id` item Olsera. Repair hanya memakai identity item yang tersimpan dari audit `GAP_FOUND`, dengan `$setOnInsert`; checkpoint, kategori, ledger, inventory, dan data lokal existing tidak diubah.
Berikan akses dengan mencentang modul "Audit & Sinkronisasi" pada user terkait di menu Pengguna. Tanpa modul ini (dan bukan supervisor), akun mendapat 403 dari API dan tidak melihat menu di sidebar.

Cron mingguan dapat memanggil `POST /api/cron/integration-audit` dengan `Authorization: Bearer $CRON_SECRET`. Endpoint ini read-only dan tidak menjalankan Sync AYO/Olsera atau auto-repair tanpa identity sumber yang terverifikasi.
