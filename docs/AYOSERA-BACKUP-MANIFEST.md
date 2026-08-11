# AYOSERA — Backup Manifest

## Latest Backup

- **Tanggal**: 2026-08-12
- **Commit HEAD**: `7be13b40469437d3adf76d507042809e858630c0`
- **Branch**: `main`
- **Nama file**: `AYOSERA-BACKUP-2026-08-12.zip`
- **Lokasi**: `%USERPROFILE%\Desktop\AYOSERA-BACKUP-2026-08-12.zip`
- **Metode**: `git archive --format=zip -o AYOSERA-BACKUP-2026-08-12.zip HEAD` (hanya file yang ter-track Git pada commit HEAD)
- **SHA256**: `42ab964b595166fd0336d8ebdb76436ebdfac1e350e734627f6ebf9db4e8ea42`

## Included

- Source code (`app/`, `lib/`, `components/`, `scripts/`)
- `package.json` + lockfile
- Dokumentasi (`docs/`, `README.md`, `CLAUDE.md`, `NOTES-SYNC.md`)
- Konfigurasi aman (`vercel.json`, `tsconfig.json`, `next.config.*`, `.github/workflows/`, `.env.example` — placeholder saja, tanpa nilai asli)
- Total 494 file ter-track pada commit ini

## Excluded (otomatis, karena `git archive` hanya menyertakan file ter-track)

- `node_modules/`
- `.next/` (build artifact)
- `.git/`
- `.env`, `.env.local`, `.env.*.local` (tidak pernah ter-track — lihat `.gitignore`)
- `tmp/` (file audit/scratch sementara — di-gitignore)
- File ekspor mentah di root (`*.xlsx`, `*.pdf`) — di-gitignore, hasil ekspor scripts, bukan source
- Cache, log build (`*.tsbuildinfo`, `npm-debug.log*`, dll.)
- `.vercel/`
- `.claude/settings.local.json`

Diverifikasi: isi ZIP di-scan ulang setelah dibuat (`unzip -l | grep -i env|secret|credential`) — hanya `.env.example` (placeholder) dan file kode non-secret (`lib/auth-secret.ts`, `lib/auth-secret.test.ts`) yang cocok pola pencarian tersebut. Tidak ada credential asli di dalam backup.

## Cara Restore (Singkat)

1. Ekstrak ZIP ke folder kosong.
2. `npm install` untuk memasang dependency (lockfile sudah termasuk dalam backup).
3. Salin ulang environment variable secara manual dari penyimpanan aman tim (Vercel Dashboard atau password manager) ke `.env.local` — **tidak ada di backup ini**.
4. `npm run build` untuk memastikan build berhasil.
5. Untuk restore penuh sebagai repository Git: `git init`, tambahkan remote `origin` ke `https://github.com/monauli/ayosera.git`, lalu `git fetch` + checkout commit yang sesuai (backup ZIP ini bukan pengganti clone Git penuh — histori commit tidak termasuk dalam ZIP).
6. Restore database MongoDB dilakukan terpisah dari backup source code ini (gunakan backup/snapshot database sendiri).
