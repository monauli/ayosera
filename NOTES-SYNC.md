# Sync AYO — Cron & Manual

Dokumen singkat soal sinkronisasi data AYO/Olsera ke database.

## Jadwal

- **Auto-sync (Vercel Cron):** 1x sehari, **jam 00:00 WIB**.
  - Cron Vercel pakai UTC, jadi jadwalnya `0 17 * * *` (lihat `vercel.json`).
  - Vercel Hobby/free hanya mengizinkan cron maksimal **1x per hari** — jangan
    ubah ke `0 * * * *` (per jam) karena akan ditolak Vercel.
  - Saat jalan, cron menarik data **kemarin → hari ini** (zona Asia/Jakarta)
    supaya transaksi hari yang baru selesai ikut tersinkron.
- **Manual sync:** bisa kapan saja, berkali-kali sehari, lewat tombol
  "Sinkronkan Sekarang" di dashboard (Sync Latest / Sync by Date / per bulan).
  Manual sync memanggil `POST /api/sync` dan butuh login admin.

## Endpoint

| Endpoint           | Pemakai        | Auth                                   |
| ------------------ | -------------- | -------------------------------------- |
| `GET /api/cron/sync` | Vercel Cron    | `Authorization: Bearer ${CRON_SECRET}` |
| `POST /api/sync`     | Dashboard admin| Sesi login admin (Better Auth)         |

Keduanya memakai function inti yang sama: `syncProductionListBookings()`
(`lib/production-sync.ts`). Tidak ada duplikasi logika sync.

Contoh response cron sukses:

```json
{
  "success": true,
  "mode": "cron",
  "message": "daily split sync completed; ...",
  "inserted": 0,
  "updated": 0,
  "total": 0
}
```

Contoh response cron gagal (HTTP 500), atau 401 bila secret salah/kosong:

```json
{ "success": false, "mode": "cron", "message": "Error detail" }
```

## Penyimpanan: MongoDB saja

Seluruh data (bookings, sync_logs, users, fields) disimpan **hanya di MongoDB**.
SQLite sudah tidak dipakai (filesystem Vercel ephemeral/read-only). Function
sync inti `upsertBookingItems()` (`lib/booking-sync.ts`) yang menulis ke Mongo,
dipakai bersama oleh cron, manual, dan webhook.

## Anti-duplikat

`booking_id` dipakai sebagai unique key (`lib/mongodb.ts` membuat unique index
pada `booking_id`). `upsertBookingItems()` membandingkan isi (`raw` payload):

- belum ada di DB → **insert** (`upsert`)
- sudah ada & isi identik → **duplicate** (di-skip, tidak ditulis ulang)
- sudah ada & isi berbeda → **update**

Tidak pernah ada row ganda untuk booking yang sama.

## Logging

Setiap sync (cron/manual/webhook) menulis 1 dokumen ke koleksi **`sync_logs`**
di MongoDB berisi: waktu (`startedAt`/`finishedAt`), `type`
(`scheduled`/`manual`/`webhook`), `status` (`success`/`partial`/`failed`),
`totalReceived`, `inserted`, `updated`, `duplicate`, `error`, dan `message`.
Log terbaru muncul di panel aktivitas dashboard.

## Env yang wajib diisi di Vercel

Set di **Project Settings → Environment Variables** (jangan commit nilainya):

- `CRON_SECRET` — secret untuk endpoint cron. Vercel otomatis mengirim header
  `Authorization: Bearer <CRON_SECRET>` ke `/api/cron/sync`. Hanya dipakai di
  server, tidak pernah di-expose ke frontend.
- Env API AYO yang sudah dipakai project:
  - `AYO_BASE_URL`
  - `AYO_VENUE_CODE`
  - `AYO_BRANCH_NAME`
  - `AYO_API_TOKEN`
  - `AYO_PRIVATE_KEY`
- Env database & auth yang sudah ada: `MONGODB_URI`, `MONGODB_DB`,
  `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `JWT_SECRET`, dll
  (lihat `.env.example`).

> Catatan: gunakan MongoDB Atlas (atau Mongo yang bisa diakses dari Vercel)
> karena filesystem Vercel tidak persisten. Semua data sync masuk ke MongoDB.
