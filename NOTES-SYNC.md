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

## Anti-duplikat

`booking_id` dipakai sebagai unique key:

- **SQLite** (`lib/sqlite.ts`): kolom `booking_id` adalah `PRIMARY KEY`. Jika
  booking sudah ada → `UPDATE`, kalau belum → `INSERT`. Tidak ada row ganda.
- **MongoDB** (`lib/booking-sync.ts`): `bulkWrite` dengan `updateOne` +
  `upsert: true` di-filter pada `booking_id`.

## Logging

Setiap sync (cron maupun manual) mencatat log:

- **SQLite** tabel `sync_logs`: waktu, type (`scheduled`/`manual`), status,
  total diterima, inserted, updated, duplicate, error.
- **MongoDB** koleksi `syncLogs`: type, status, recordsProcessed, message,
  startedAt, finishedAt (atau errorMessage jika gagal).

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
  `SQLITE_DB_PATH`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `JWT_SECRET`,
  dll (lihat `.env.example`).

> Catatan: di Vercel (filesystem read-only/ephemeral), SQLite tidak persisten.
> MongoDB adalah store utama untuk deployment. SQLite cocok untuk lokal/dev.
