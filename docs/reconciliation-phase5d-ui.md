# Reconciliation Phase 5D — UI Admin

## Tujuan dan route

Halaman `/reconciliation` memberi admin yang memiliki modul **rekonsiliasi** tampilan read-first atas finding. Sidebar Dashboard AYO memiliki menu Rekonsiliasi. Route menggunakan API internal Phase 5C/5D; browser tidak pernah menulis alias produk, snapshot, order item, atau finding asli.

## Role access

Viewer/admin dengan modul dapat melihat ringkasan, filter, detail, evidence, history, dan audit. Hanya session role `supervisor` yang melihat serta dapat memakai form create/supersede/revoke. API tetap menjadi sumber kebenaran: write endpoint tetap supervisor-only.

## Filter dan tabel

Filter `period`, `domain`, `impact`, `confidence`, `effectiveStatus`, `decision`, `reasonCode`, `keyword`, `needsAction`, dan pagination berada di URL search params. Endpoint read-only `GET /api/reconciliation/findings-ui` mengerjakan filtering, lookup current resolution, priority sort (CRITICAL → ERROR → WARNING → INFO), pagination, serta card aggregate di MongoDB. Keyword dibatasi, di-escape, dan hanya prefix entity key.

Desktop memakai tabel; mobile menggantinya dengan daftar kartu agar tidak terjadi horizontal overflow. Loading, empty state, retry error, labels teks/badge, serta dark/light token tersedia.

## Detail dan resolution

Drawer menampilkan identitas, penilaian asal, expected/actual/difference, diagnostics/source, current resolution, history, dan audit trail. JSON hanya ada dalam panel teknis yang dapat dibuka.

Form supervisor memakai decision/reason code Phase 5C, validasi `OTHER` dan `RESOLVED` membutuhkan catatan, serta mengingatkan bahwa supersede tidak menghapus history. POST membuat `Idempotency-Key`, menonaktifkan submit ganda, tidak optimistic update, dan memuat ulang detail/list setelah sukses atau conflict 409. Revoke meminta alasan dan konfirmasi backend; status efektif selalu berasal dari respons backend.

## Current month dan kasus identitas produk

Bulan berjalan memiliki badge belum final dan penjelasan `CURRENT_MONTH_BOUNDARY`. Finding `106817649 → 116138490` memperoleh banner eksplisit: resolution administratif tidak membuat alias, memindahkan histori, atau rebuild snapshot. Tidak ada tombol untuk tindakan tersebut.

## Batasan dan Phase 5E

Phase ini tidak menambahkan reconciliation write runner, aliasing, rebuild, sync, atau otomasi data sumber. Write test memakai mock/static contract; UI belum memiliki notifikasi lintas pengguna realtime. Phase 5E dapat menambahkan notifikasi, saved views, serta audit analytics bila diperlukan.

## Test coverage

`lib/reconciliation-phase5d-ui.test.ts` memeriksa kontrak page/route untuk URL filter, pagination, role, validasi form, idempotency, conflict, mobile layout, current-month, product ambiguity, status/history, dan query Mongo read model.
