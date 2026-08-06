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

## Cek & Tutup Gap Data — hanya di Audit & Sinkronisasi

Halaman Pengguna (`components/users-panel.tsx`) dulu punya panel "Cek & Tutup Gap Data" sendiri
yang me-resync Olsera per-hari lewat `POST /api/olsera/sync` (mekanisme lama, tanpa perbandingan
identity). Panel itu **sudah dihapus** dari halaman Pengguna — fungsinya tumpang tindih secara
maksud (sama-sama "menutup gap Olsera") dengan audit identity-level yang lebih akurat di panel ini.
`POST /api/olsera/sync` sendiri **tidak dihapus/diubah** — masih dipakai oleh flow sync utama
(`app/page.tsx`) dan cron (`app/api/cron/olsera-sync/route.ts`), hanya tombol pemicunya di halaman
Pengguna yang dihilangkan. Cek/Tutup Gap sekarang hanya ada di satu tempat: panel ini.

## Status AYO Mobile Token

`AYO_MOBILE_TOKEN` **bukan JWT** — token opaque hasil ekstraksi manual dari sesi AYO Mobile
(lihat `mobileToken()` di `lib/ayo-payment-events.ts`). Tidak ada endpoint refresh/import otomatis
di codebase ini, tidak ada klaim `exp`/`iat`, dan tidak ada masa berlaku resmi yang diterbitkan AYO
untuk token ini — jadi sistem **tidak pernah menebak tanggal kedaluwarsanya**.

Model status (`classifyAyoMobileToken` di `lib/private-integration-monitor.ts`), dari bukti nyata saja:

| Status | Label UI | Kapan |
| --- | --- | --- |
| `ACTIVE` | Aktif | Ada klaim `exp` JWT, belum dekat, belum lewat |
| `EXPIRING_SOON` | Akan Kedaluwarsa | Klaim `exp` JWT ≤ `AYO_TOKEN_EXPIRING_SOON_DAYS` (7 hari, terpusat) |
| `EXPIRED` | Kedaluwarsa | Klaim `exp` JWT sudah lewat |
| `EXPIRY_UNKNOWN` | Expiry Tidak Diketahui | Token ada, opaque, tidak ada bukti negatif — **ini bukan error** |
| `MANUAL_IMPORT_REQUIRED` | Perlu Import Manual | `AYO_MOBILE_TOKEN` kosong |
| `INVALID` | Token Tidak Valid | Bentuknya JWT tapi tidak terbaca, atau checkpoint terakhir menunjukkan penolakan (401/unauthorized) |
| `UNAVAILABLE` | Tidak Tersedia | Checkpoint terakhir menunjukkan kegagalan jaringan/infra — **bukan** token yang salah |

Status operasional (last successful check/last error) dibaca dari checkpoint sync existing —
koleksi `ayo_payment_event_sync_state` (`_id: "ayo-payment-events-auto-sync"`, diisi oleh
`lib/ayo-payment-events-auto-sync.ts`) — **bukan** dari panggilan baru ke API AYO. `GET
/api/private/integration-monitor` tidak pernah memanggil AYO hanya untuk memeriksa status token,
jadi tidak ada risiko rate-limit/beban tambahan ke AYO dari halaman ini.

Catatan penting:
- Status operasional (aktif/tidak) dan status expiry adalah **dua hal berbeda**: token bisa saja
  masih dipakai dan berhasil (checkpoint sukses) walau expiry-nya tidak diketahui — itulah kenapa
  `EXPIRY_UNKNOWN` bukan `MANUAL_IMPORT_REQUIRED` maupun error.
- `MANUAL_IMPORT_REQUIRED` hanya muncul bila token benar-benar tidak dikonfigurasi (kosong) — bukan
  sekadar karena formatnya bukan JWT.
- `importedAt` tidak pernah ditampilkan sebagai tebakan — field ini `null` selama tidak ada sumber
  yang benar-benar mencatat kapan token di-import (saat ini belum ada).
- Raw token, header `Authorization`, dan payload sensitif lain **tidak pernah** dikembalikan oleh
  endpoint ini maupun ditampilkan di UI.
