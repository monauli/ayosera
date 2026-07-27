# Reconciliation Phase 5C: Manual Resolution

## Tujuan

Phase 5C menambahkan keputusan admin yang dapat diaudit pada finding rekonsiliasi tanpa mengubah atau menghapus finding asal. Ini adalah backend-only; tidak ada UI, backfill, rebuild snapshot, atau perubahan alias produk.

## Model data

`reconciliation_manual_resolutions` bersifat append-only. Dokumen baru (schemaVersion `2`) berisi `resolutionId` (`_id`), `findingId`, `runId`, `domain`, `storeId`, `period`, `entityKey`, `decision`, `reasonCode`, `note`, `evidence`, `previousResolutionId`, `isCurrent`, `createdBy`, `createdAt`, `supersededAt`, dan metadata fingerprint request.

Satu `findingId` hanya boleh memiliki satu dokumen `isCurrent:true`. MongoDB menegakkannya melalui partial unique index `{findingId: 1}` dengan `partialFilterExpression: {isCurrent: true}`. Dokumen legacy Phase 5A tetap dapat dibaca dan dipetakan ke view kompatibel schemaVersion 1.

## Decision, alasan, dan status efektif

Decision yang diterima endpoint create: `CONFIRMED_FINDING`, `FALSE_POSITIVE`, `REQUIRES_MANUAL_ADJUSTMENT`, `DEFERRED`, dan `RESOLVED`. `REVOKED` hanya dibuat endpoint revoke sebagai event append-only.

Reason code: `SOURCE_DATA_INCOMPLETE`, `PRODUCT_ID_CHANGED`, `PRODUCT_IDENTITY_AMBIGUOUS`, `LEGACY_STORE_ID_NULL`, `STALE_SNAPSHOT`, `EXPECTED_NON_STOCK_ITEM`, `CURRENT_MONTH_BOUNDARY`, `VERIFIED_FALSE_POSITIVE`, `VERIFIED_CORRECT`, `MANUAL_INVENTORY_ADJUSTMENT_REQUIRED`, dan `OTHER`. `OTHER` wajib memiliki note.

| Resolution aktif | Effective finding status |
| --- | --- |
| tidak ada | `OPEN` |
| `CONFIRMED_FINDING` | `CONFIRMED` |
| `FALSE_POSITIVE` | `DISMISSED` |
| `REQUIRES_MANUAL_ADJUSTMENT` | `MANUAL_ACTION_REQUIRED` |
| `DEFERRED` | `DEFERRED` |
| `RESOLVED` | `RESOLVED` |

`REVOKED` mengikuti `previousResolutionId`, sehingga menemukan status efektif sebelum keputusan yang dibatalkan; bila tidak ada, hasilnya `OPEN`. Impact dan confidence historis pada finding tidak pernah diubah.

## Transisi dan concurrency

Keputusan baru selalu membuat dokumen baru. Resolution aktif sebelumnya ditandai superseded dan mereferensikan resolution baru. Tidak ada `reconciliation_findings` yang dimutasi. Revoke juga membuat event baru, bukan menghapus dokumen.

Request mewajibkan `Idempotency-Key`. `resolutionId` dibuat deterministik dari finding, actor, dan key; fingerprint payload menolak reuse key untuk isi berbeda. Untuk race update, service memakai conditional update pada resolution current, retry terbatas, serta partial unique index sebagai pagar terakhir; hasilnya maksimal satu current resolution.

## Otorisasi dan isolasi toko

Endpoint tulis dan detail resolution memerlukan `requireSupervisor()`. `createdBy` selalu `user.id` dari session tervalidasi; body tidak dapat menentukan actor atau store. `storeId` berasal dari `OLSERA_INTERNAL_STORE_ID`, lalu finding dibaca dan divalidasi terhadap `runId`, `domain`, dan `entityKey` yang dikirim. Finding toko lain diperlakukan sebagai 404.

Body write hanya JSON, dibatasi ukurannya, memakai allow-list field ketat, dan menolak field tambahan. Error tidak memuat stack trace.

## API internal

- `GET /api/reconciliation/findings/:findingId/resolution` mengembalikan finding, currentResolution, effectiveStatus, history, dan historyCount.
- `POST /api/reconciliation/findings/:findingId/resolution` membuat/supersede keputusan. Header `Idempotency-Key` wajib.
- `POST /api/reconciliation/findings/:findingId/resolution/revoke` membatalkan resolution aktif secara append-only. Header `Idempotency-Key` dan body `{ "note": "..." }` wajib.
- `GET /api/reconciliation/manual-resolutions` mendukung `period`, `domain`, `decision`, `reasonCode`, `createdBy`, `dateFrom`, `dateTo`, `page`, dan `limit`.

## Audit trail

`reconciliation_audit_log` menerima `CREATE_RESOLUTION`, `SUPERSEDE_RESOLUTION`, `REVOKE_RESOLUTION`, `RESOLUTION_CONFLICT`, `UNAUTHORIZED_RESOLUTION_ATTEMPT`, dan `INVALID_RESOLUTION_TRANSITION`. Audit menyimpan actor, store/finding/run/resolution relation, before/after ringkas, request ID, timestamp, dan metadata non-sensitif. Token, cookie, bearer credential, serta raw body tidak disimpan.

## Kasus product ID 106817649 -> 116138490

Gunakan finding `PRODUCT` dengan reason `PRODUCT_IDENTITY_AMBIGUOUS` dan decision `REQUIRES_MANUAL_ADJUSTMENT` bila bukti resmi belum ada. Hasilnya `MANUAL_ACTION_REQUIRED`; resolution dan historinya dapat dilacak. Proses ini tidak membuat `olsera_product_aliases`, tidak rebuild snapshot, tidak memindahkan histori order item, dan tidak membuat kesimpulan alias otomatis.

## Rollback / revoke

Jangan menghapus resolution. Panggil endpoint revoke pada resolution current dengan alasan. Event `REVOKED` tersimpan dalam history dan status efektif kembali mengikuti resolution sebelumnya, atau `OPEN` jika tidak ada. Untuk keputusan pengganti, kirim POST create yang baru; resolution lama tetap dapat diaudit.
