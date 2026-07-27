# Reconciliation Phase 5E — Operational Readiness

## Readiness checklist

Phase 5E tidak menjalankan write. Sebelum controlled write masa depan, supervisor memeriksa endpoint `GET /api/reconciliation/readiness`: konektivitas MongoDB, index reconciliation, feature flag, default dry-run, snapshot terakhir, run terakhir, dan audit log. Panel readiness hanya tampil untuk supervisor pada halaman Rekonsiliasi.

## Feature flag dan write flow

`RECONCILIATION_WRITE_ENABLED` hanya aktif bila bernilai literal `1`; unset atau nilai lain berarti **disabled**. Endpoint manual-resolution write/revoke menolak dengan 403 ketika flag mati. CLI runner juga memerlukan bersama-sama: `--write`, `--confirm-write`, `RECONCILIATION_WRITE_ENABLED=1`, `ALLOW_RECONCILIATION_WRITE=1`, dan guard production yang sudah ada. Default tetap dry-run.

`POST /api/reconciliation/write-preview` adalah read-only. Ia menerima target, period, finding/run, `dryRun`, explicit confirmation, dan idempotency key; mengembalikan target, koleksi terdampak, perkiraan aksi, warning, blocker, dan request fingerprint. Tidak ada endpoint Phase 5E yang menjalankan write runner.

Pre-write service memeriksa role supervisor, feature flag, `dryRun=false`, konfirmasi eksplisit, store server, period, fingerprint, idempotency key, finding/run relation, resolution current, serta fingerprint yang telah diaudit. Kegagalan database/timeout menjadi blocker.

## Write-path audit

| Path | Koleksi | Proteksi |
| --- | --- | --- |
| Runner internal | `reconciliation_runs`, `reconciliation_findings` | deterministic ID, upsert, checkpoint, dry-run default, CLI guards; finding tidak dihapus |
| Manual resolution | `reconciliation_manual_resolutions`, `reconciliation_audit_log` | supervisor, feature flag, idempotency, partial unique current resolution, append-only audit |
| Snapshot bulanan | `olsera_inventory_monthly_snapshots` | upsert deterministic; tidak dipanggil Phase 5E |
| Inventory sync | products/snapshots/movements/runs/state | idempotent upsert dan lock; tidak dipanggil Phase 5E |

`findings-ui` memakai `$lookup` current resolution serta pagination/aggregate di MongoDB; index store-period-impact-confidence, store-entityKey, findingId current/history, runId, dan createdAt mendukung jalur baca. Detail resolution memakai query terikat finding/store; tidak ada N+1 pada tabel.

## Rollback dan SOP

1. Bila preview memiliki blocker, jangan enable flag atau menjalankan write.
2. Bila write masa depan gagal setelah sebagian run, gunakan run/checkpoint deterministik dan rerun terkontrol; jangan delete finding historis.
3. Bila duplicate fingerprint/idempotency muncul, baca audit dan gunakan hasil pertama; jangan mengulangi mutation.
4. Bila Mongo timeout, flag tetap off, tunggu recovery, cek readiness/index, lalu ulang preview/dry-run—bukan langsung write.
5. Bila conflict resolution, refresh detail/history lalu buat keputusan baru yang ter-audit; jangan overwrite resolution lama.

Production checklist: flag default off, preview lulus, dry-run diverifikasi, supervisor aktif, store/period benar, idempotency key tercatat, rollback owner ditunjuk, dan audit endpoint sehat.

## Known limitations

Tidak ada transaction lintas semua koleksi runner; runner memakai deterministic upsert dan checkpoint sebagai recovery. Phase 5E tidak menambah automated rollback, realtime operations alert, backfill, alias, rebuild snapshot, maupun write production.
