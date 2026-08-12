# AYOSERA — Handoff Audit Mismatch Kategori Penjualan Februari 2026

## Audit item-level final

Workspace inspection menemukan export resmi/detail berikut:

- `Omset Kategori-2026-02.xlsx` — agregat kategori harian, bukan detail order/item.
- `Rincian Penjualan-2026-02-27__2026-02-27.xlsx` — detail hanya untuk 27 Februari.
- Tidak ada export `Rincian Penjualan` atau `Transaksi` untuk seluruh 1–28 Februari.

Karena export detail resmi Februari penuh tidak tersedia, pencocokan item-level untuk seluruh bulan tidak dapat dilakukan secara valid. Export 27 Februari juga tidak cukup untuk membuktikan selisih LABERS +1/Rp21.250 dan SEWA RAKET +2/Rp60.000.

### Exact mismatch

Belum ditemukan. Tidak ada item yang boleh ditetapkan sebagai penyebab tanpa pasangan data resmi dengan kunci `orderNo + tanggal + nama item + qty + nominal`.

### Root cause

Belum terbukti. Hipotesis timezone dan `openorder paid` sudah gugur. Kandidat sebelumnya berasal dari `closeorder`, sehingga audit agregat maupun endpoint belum bisa menjelaskan mengapa laporan resmi tidak menghitungnya. Status `Z` pada order list juga belum membuktikan exclusion dari laporan kategori.

### Data yang diperlukan

Ambil dari Olsera UI/API export:

1. `Rincian Penjualan` untuk 2026-02-01 sampai 2026-02-28, seluruh halaman.
2. Kolom order number, tanggal/waktu transaksi, status, nama produk/variant, qty, nominal item, product/category bila tersedia.
3. Jika export tidak memuat status, export/list order Februari yang memuat order id, order number, status, dan tanggal.

Setelah file tersedia, lakukan join item-level terhadap `olsera_order_items`; jangan koreksi aggregate manual sebelum join selesai.

## Status audit

Audit bersifat read-only. Tidak ada database, snapshot, alias, source code, commit, atau push yang diubah.

## Hasil

## Validasi BA Rekonsiliasi Omzet — 2026-08-12

Validasi BA kini memeriksa periode, arah penyesuaian, nominal dengan tolerance existing Rp1, dan alasan yang sudah dibersihkan dari noise OCR. Periode salah menghasilkan `Salah Periode`; periode tidak terbaca, alasan tidak relevan, atau sinyal ambigu menghasilkan `Perlu Dicek`. Tidak ada auto-lock atau auto-adjust.

Regression tests mencakup BA benar, nominal salah, arah salah, bulan salah, periode hilang, dan alasan OCR rusak. Targeted tests 78/78 PASS, type-check PASS, build PASS, dan `git diff --check` PASS.

Scope hanya parser/UI/API finalisasi BA dan penyimpanan metadata periode BA; tidak menyentuh Inventory, Financial, YONEX, atau ODEA.

Selisih yang harus dijelaskan:

- LABERS: +1 qty / Rp21.250
- SEWA RAKET: +2 qty / Rp60.000
- Total: +3 qty / Rp81.250

Audit targeted API dilakukan pada tanggal kandidat 5, 6, dan 18 Februari. Daftar `openorder?is_paid=1` juga dicek untuk setiap tanggal 1–28 Februari:

- `openorder?is_paid=1` kosong pada seluruh tanggal Februari.
- Kandidat LABERS dan SEWA RAKET yang diperiksa berasal dari `closeorder`.
- Tidak ada kandidat nominal tersebut yang terbukti hanya berada di `openorder paid`.

Source code membuktikan bahwa sync produksi AYOSERA mengambil:

1. `closeorder`;
2. `openorder` dengan `is_paid=1`;
3. deduplikasi berdasarkan order id.

Sebaliknya, `scripts/validate-olsera-category.ts` hanya mengambil `closeorder`. Perbedaan filter memang ada, tetapi tidak menjelaskan mismatch Februari karena `openorder paid` kosong pada bulan tersebut.

Exact tiga order penyebab belum terbukti. Dokumen `olsera_order_items` tidak menyimpan provenance endpoint, tetapi targeted API berhasil mengklasifikasikan kandidat yang diuji. Query MongoDB tambahan gagal pada koneksi DNS `querySrv ECONNREFUSED`.

## Kandidat nominal

- LABERS: `DF0226020500000033`, `DF0226020500000048`, dan `DF0226020500000061`; `closeorder`, order status `Z`, tanggal 2026-02-05, item lokal qty 1 / Rp21.250.
- SEWA RAKET: `DF0226020600000096` dan `DF0226020600000109`; `closeorder`, status `Z`, tanggal 2026-02-06, kandidat order total Rp30.000. `DF0226021800000662` juga `closeorder`, status `Z`, tanggal 2026-02-18, order total Rp60.000.
- `openorder paid`: tidak ada hasil untuk seluruh Februari.

Kandidat-kandidat tersebut bukan exact penyebab mismatch karena berada di `closeorder`, source yang juga dipakai laporan resmi. Tidak ada dasar untuk memilih tiga order tertentu dari kandidat-kandidat yang nominalnya sama.

## Status dan tanggal

Audit lokal sebelumnya menunjukkan item kandidat berstatus `A` dan tanggal transaksi Februari. `created_time` berbeda sekitar 7 jam dari `orderDate` karena UTC, tetapi kode produksi tidak memakai `created_time` untuk menentukan bulan. Kode memakai `order_time`/`transaction_time`/`paid_at`, lalu fallback ke `order_date`.

Dengan demikian, root cause timezone, rollover tanggal, dan perbedaan `closeorder` versus `openorder paid` belum terbukti. Hipotesis openorder paid gugur untuk Februari.

## File penyebab

- `lib/olsera-sync.ts:160` — pengambilan order harian.
- `lib/olsera-sync.ts:311` — aturan tanggal transaksi; `created_time` tidak digunakan.
- `lib/olsera-sync.ts:478` — produksi mengambil close + open paid.
- `scripts/validate-olsera-category.ts:294` — validasi hanya mengambil closeorder.

## Rekomendasi fix paling kecil

Jangan mengubah filter ke `closeorder` saja. Audit ini tidak mendukungnya sebagai fix. Audit berikutnya harus membandingkan detail item dan aturan agregasi/export laporan resmi, termasuk status `Z` dan mapping kategori. Jangan mengubah nominal atau menghapus item secara manual.

## Perubahan

None selain file handoff ini.

## Commit/push

None.

## Next step

Bandingkan export/report resmi Olsera pada level item untuk menemukan tiga item exact. Jangan ubah filter sebelum penyebab terbukti; hasil targeted saat ini menunjukkan kandidat nominal yang ditemukan juga merupakan `closeorder`.

## Kategori Februari — fix generic

Perubahan lokal yang disiapkan:

- `lib/olsera-sync.ts` menormalkan field retur Olsera (`return_qty`, `return_quantity`, `returned_qty`, `refund_qty`, serta field nominal pasangannya) sebelum agregasi dan penyimpanan item. Nilai negatif yang sudah diberikan Olsera dipertahankan.
- Kategori asli dari payload transaksi (`category_name`/`product_category_name`) diprioritaskan, sehingga item `CUSTOM` tidak mengikuti kategori katalog `MINUMAN`.
- `scripts/backfill-olsera-categories.ts` memakai aturan yang sama untuk data historis dan membangun ulang agregat dari item.
- Regression test ditambahkan di `lib/olsera-sync-returns.test.ts`.

Target Februari belum diverifikasi dari database karena koneksi MongoDB lokal gagal `querySrv ECONNREFUSED`. Tidak ada angka target yang diklaim tanpa data.

## Bukti retur resmi dan status finalisasi

Retur resmi yang menjadi regression case:

- `DF0226020500000033`, `ICED LEMON TEA`: sale `+1/Rp21.250`, return `-1/-Rp21.250`, 2026-02-05 12:22:51; net LABERS 0.
- `DF0226021100000399`, `RAKET STANDAR`: sale `+2/Rp60.000`, return `-2/-Rp60.000`, 2026-02-11 22:58:08; `RAKET PREMIUM +1/Rp50.000` tetap valid; net kontribusi order untuk SEWA RAKET adalah 1/Rp50.000.

Pipeline tidak mensintesis retur dari field `return_qty`; setiap baris negatif dari Olsera diproses dan disimpan, lalu mengurangi qty/nominal kategori yang sama. CUSTOM tetap mengikuti kategori asli transaksi.

Regression test exact sudah lulus. Typecheck, build, targeted export tests, dan `git diff --check` juga lulus. Verifikasi angka Februari terhadap database masih BLOCKED oleh `querySrv ECONNREFUSED`; commit dan push harus menunggu verifikasi tersebut.

## Retry verifikasi MongoDB

Retry final dilakukan read-only untuk agregat `olsera_order_items` pada 2026-02-01 s/d 2026-02-28. MongoDB tetap tidak reachable:

`querySrv ECONNREFUSED _mongodb._tcp.cluster0.dqvtxp8.mongodb.net`

Target berikut belum dapat diverifikasi dari database:

- Total 1.439 / Rp62.367.200
- LABERS 446 / Rp14.491.200
- MINUMAN 649 / Rp8.426.000
- SEWA RAKET 186 / Rp6.840.000
- CUSTOM 1 / Rp20.000

Sesuai guard, tidak ada commit dan tidak ada push. Perubahan aman tetap lokal.

## WIP handoff 2026-08-12

- February category MongoDB verification: **BLOCKED** (`querySrv ECONNREFUSED`); target angka belum terverifikasi dari database.
- YONEX historical lineage/sales audit: **UNRESOLVED**; jangan melakukan inventory write atau rekonstruksi tanpa bukti tambahan.
- ODEA closing dan manual adjustment `+64`: **NOT FINAL / UNPROVEN**; jangan deploy atau menerapkan perubahan tersebut.
- Branch WIP ini boleh berisi safe/WIP code dan handoff, tetapi bukan approval production.

## Diagnosis MongoDB home PC — 2026-08-12

- **Root cause koneksi awal:** resolver DNS lokal Windows pada `127.0.2.2`/`127.0.2.3` menolak query SRV MongoDB. Node mereproduksi `querySrv ECONNREFUSED`; tidak ada indikasi password, URI, database, atau application logic salah.
- **Pembuktian jaringan:** SRV `cluster0.dqvtxp8.mongodb.net` berhasil di-resolve melalui DNS Google `8.8.8.8` dan Cloudflare `1.1.1.1`.
- **Safest fix:** tidak ada perubahan code/config yang diperlukan. `lib/mongodb-dns.ts` sudah mendeteksi resolver loopback pada development dan memakai `8.8.8.8`/`1.1.1.1` sebagai fallback. Dengan inisialisasi aplikasi normal, MongoDB ping berhasil.
- **Safety:** pemeriksaan hanya `ping`, `find`, dan `aggregate`; tidak ada operasi tulis database. Nilai `.env`/credential tidak dicetak.

### Read-only February verification

Agregat `olsera_sales_by_category` dan agregat item tersimpan untuk `2026-02-01` sampai `2026-02-28` sama-sama menghasilkan:

- LABERS: **447 / Rp14.512.450** (target 446 / Rp14.491.200)
- MINUMAN: **650 / Rp8.446.000** (target 649 / Rp8.426.000)
- SEWA RAKET: **188 / Rp6.900.000** (target 186 / Rp6.840.000)
- CUSTOM: **tidak ada** (target 1 / Rp20.000)
- Total seluruh kategori tersimpan: **1.442 / Rp62.797.450** (target 1.439 / Rp62.367.200)

**Verification: NOT PASS.** Koneksi sudah dapat dipakai, tetapi angka produksi saat ini tidak sama dengan target. Tidak ada code/database change, commit, atau push.

## Dry-run rebuild kategori Februari — 2026-08-12

Dry-run read-only dilakukan dari `olsera_order_items` item-level untuk 2026-02-01..2026-02-28 dengan normalisasi item saat ini, bukan menjadikan `olsera_sales_by_category` sebagai hasil akhir.

### Actual source state

- Item-level source: **1.442 / Rp62.448.450**.
- `olsera_sales_by_category` lama: **1.442 / Rp62.797.450**.
- Selisih: **Rp349.000**, tanpa delta per kategori ketika dibandingkan dengan agregasi item-level. Kesimpulan: stale aggregate/materialized rows, bukan satu item penyebab yang dapat ditunjuk; jangan gunakan aggregate lama untuk rebuild.
- Baris retur negatif belum tersimpan di `olsera_order_items` pada home DB. Known official return evidence belum ter-materialisasi sebagai item rows:
  - LABERS: **-1 / -Rp21.250**
  - SEWA RAKET: **-2 / -Rp60.000**
- `Custom` ditemukan pada `DF0226022700000852`, qty 1 / Rp20.000, tetapi state tersimpan saat ini masih `MINUMAN`.

### Simulated result with WIP logic

Menerapkan secara dry-run (tanpa write) dua perubahan yang sudah didukung WIP:

1. Memasukkan baris retur resmi sebagai nilai negatif.
2. Memetakan item `Custom` ke kategori asli `CUSTOM`, bukan katalog `MINUMAN`.

Hasil simulasi:

- Total: **1.439 / Rp62.367.200** — cocok.
- LABERS: **446 / Rp14.491.200** — cocok.
- MINUMAN: **649 / Rp8.426.000** — cocok.
- SEWA RAKET: **186 / Rp6.840.000** — cocok.
- CUSTOM: **1 / Rp20.000** — cocok.

**Status dry-run: NOT PASS as a database-source verification.** Angka target hanya tercapai pada simulasi yang menambahkan tiga return rows berdasarkan evidence resmi dan memindahkan satu item `Custom`; source DB saat ini belum memuat tiga return rows tersebut dan masih menyimpan `Custom` sebagai MINUMAN. Tidak ada rencana write yang dijalankan, dan tidak ada commit/push.

## Audit source retur Olsera — 2026-08-12

Targeted live API audit dilakukan tanpa browser dan tanpa write, hanya untuk order `DF0226020500000033` (5 Feb) dan `DF0226021100000399` (11 Feb).

### Endpoint yang berhasil

- `GET /api/open-api/v1/id/order/closeorder?start_date=...&end_date=...` — menemukan kedua order; keduanya `status=Z`.
- `GET /api/open-api/v1/id/order/closeorder/detail?id={numeric-order-id}` — detail resmi berhasil diambil.
- `GET /api/open-api/v1/id/order/openorder?...&is_paid=1` — HTTP 404 pada kedua tanggal; tidak ada open paid.
- `GET /api/open-api/v1/en/inventory/stockmovement?start_date=2026-02-05&end_date=2026-02-11` — HTTP 200, tetapi hanya agregat per produk; `sum_return_qty` bernilai 0 pada seluruh 20 row dan tidak ada order number.

### Detail resmi dua order

- `DF0226020500000033`: order amount **Rp21.250**, item `ICED LEMON TEA`, qty **+1**, amount **+Rp21.250**, status item `A`. Detail tidak memiliki `return_qty`, `return_amount`, refund object, return transaction, atau baris negatif.
- `DF0226021100000399`: item `RAKET STANDAR`, qty **+2**, amount **+Rp60.000**, status item `A`; juga `RAKET PREMIUM` +1 / Rp50.000. Detail tidak memiliki field/baris retur.

### Endpoint retur/refund/transaction yang dicoba

`GET /return`, `/refund`, `/order/return`, `/order/refund`, `/transaction`, `/order/detail`, dan `/id/stockmovement` semuanya HTTP 404 (`Not Found Resource`). Kandidat report stockmovement yang relevan hanya tersedia pada prefix `/en/inventory/stockmovement` dan tidak menyediakan linkage order-level untuk retur.

### Kesimpulan dan rekomendasi

Source retur resmi **belum ditemukan** pada Open API yang tersedia. Dua target retur hanya dapat dibuktikan dari evidence/export resmi sebelumnya, bukan dari endpoint live yang berhasil diaudit. Belum ada endpoint generic yang aman untuk dipakai AYOSERA agar retur otomatis ikut sync.

`normalizeOlseraItem` sudah mendukung field generic `return_qty`/`return_quantity`/`returned_qty`/`refund_qty` dan pasangan nominalnya; rekomendasi perubahan paling kecil adalah mempertahankan normalizer tersebut, lalu menambahkan adapter hanya setelah Olsera menyediakan endpoint/export retur dengan order/item linkage. Jangan hardcode dua order dan jangan menganggap `sum_return_qty` stockmovement sebagai retur penjualan item.

Status: **BLOCKED — source retur API tidak tersedia/terbukti.** Tidak ada database write, commit, atau push.

## Approved February correction applied — 2026-08-12

Production correction was applied only for February 2026 using official Olsera export / manual-verified evidence.

- Two returns are stored in `olsera_sales_corrections`, not `olsera_order_items` or inventory movements, with explicit provenance and negative qty/amount.
- `Custom` order `DF0226022700000852` is now per-item `manual_override` → `CUSTOM`.
- February `olsera_sales_by_category` was rebuilt from item-level rows plus the two correction documents; the previous aggregate was not used as the source.
- RAKET PREMIUM remains +1 / Rp50.000. No YONEX, ODEA, inventory, or other-month changes were included.

Final verified result:

- Total: **1.439 / Rp62.367.200**
- LABERS: **446 / Rp14.491.200**
- MINUMAN: **649 / Rp8.426.000**
- SEWA RAKET: **186 / Rp6.840.000**
- CUSTOM: **1 / Rp20.000**

In-memory category export verification produced the same 17-sheet totals and grand total. Targeted correction/provenance and export-safety tests passed. Typecheck passed; build/push/deployment verification pending.

## Finalization status — 2026-08-12

- Final targeted/relevant tests, typecheck, production build, and `git diff --check`: **PASS**.
- Final commit pushed to `origin/main`: `3a0ee4b57691b49f949bbff0c62bec9ae43b25d7`.
- GitHub CI for that commit: **success**.
- Production February totals were verified against the production MongoDB state before push. Direct Vercel HTTP verification from the home PC remains unavailable because the configured production endpoint could not be reached; no production claim is made beyond the database verification.

## February export correction finalization — 2026-08-12

- `Rincian Penjualan` now merges the generic `olsera_sales_corrections` source, so approved historical returns render as negative rows; it does not hardcode February/order IDs in the export route.
- `Pembagian Hasil LABERS` now consumes the same correction source before calculating the percentage split.
- February generated export verification: Rincian **1.439 / Rp62.367.200**; LABERS **Rp14.491.200**; Padel 17,5% **Rp2.535.960**; Labers 82,5% **Rp11.955.240**; `Custom` remains `CUSTOM`.
- Export regression tests, relevant tests, typecheck, build, and `git diff --check`: **PASS**. No category aggregate, other month, YONEX, ODEA, or inventory logic was changed.

## Final Cron Sales audit — 2026-08-12

Read-only audit only; no schedule, code, database, or cron configuration changed.

- Production endpoint: `POST /api/cron/olsera/sales`, protected by `CRON_SECRET`, distributed sales lock, and `maxDuration=300` seconds.
- Actual recent execution: healthy, approximately every 10 minutes. The latest 10 runs on 2026-08-12 were all `success`; each had `expectedOrderCount == processedOrderCount` (56–63 orders).
- Latest run: 2026-08-12 15:00:30Z–15:01:13Z, duration **43.076s**, 63/63 orders, no error.
- Latest checkpoint: `olsera_sync_state.lastFullySyncedDate = 2026-08-12`; latest item and category aggregate writes have `syncedAt = 2026-08-12T15:01:11.320Z`.
- Data freshness: current-day data is present through the latest successful run; no observed stale day in the recent checkpoint list.
- Timeout/error audit: no recent sync log error, partial, failed status, or timeout observed. Durations were approximately 33–43 seconds, below the 300-second endpoint limit.
- Duplicate/concurrency audit: no active Sales lock remains; recent runs are sequential at roughly 10-minute intervals and no overlapping run was observed. Repeated same-day sync is expected because the cron uses `force: true`.
- Schedule configuration finding: `vercel.json` contains only `/api/cron/sync` at `0 17 * * *`; it does **not** declare the Sales 10-minute schedule. The Sales endpoint source documents cron-job.org as the scheduler, and production logs confirm that external schedule is currently active. If cron-job.org is not the intended source of truth, the external schedule must be audited separately; no fix was applied here.

**Cron Sales status: PASS for runtime health and data freshness; SCHEDULE CONFIGURATION: NOT VERIFIED IN REPOSITORY (external 10-minute scheduler is evidenced by production logs).**

## Final Cron Inventory audit — 2026-08-12

Read-only audit only; no schedule, code, database, or cron configuration changed.

- Production endpoint: `POST /api/cron/olsera/inventory`, protected by `CRON_SECRET`, distributed lock, `maxDuration=300s`, and an in-invocation step loop with a 45-second safety buffer.
- Expected schedule `minute :25`: **confirmed in production**. The 10 latest runs started at `05:57` (older recovery run), then `06:25`, `07:25`, `08:25`, `09:25`, `10:25`, `11:25`, `12:25`, `13:25`, and `14:25` UTC on 2026-08-12.
- 10 latest runs: **10/10 success**, phase `done`, no `partial`, `failed`, or error status. Each processed 2 days (`2026-08-11`..`2026-08-12`) with zero failed dates.
- Latest run: started `14:25:09Z`, completed `14:25:17Z`, duration **8.127s**.
- Recent duration range: approximately **8.1–10.2s**; safely below the 300-second route limit and the 255-second loop budget.
- Inventory checkpoint: `lastSuccessfulSyncAt=2026-08-12T14:25:18.156Z`, `lastSyncedDate=2026-08-12`, `historyCoverage=snapshot-only`, earliest available date `2026-02-04`.
- Timeout/overlap/lock audit: no timeout, failed step, stale running run, or active lock observed. Inventory sync runs are sequential; no duplicate active run or overlap found.
- Data freshness: current through `2026-08-12`; the latest completed run covered both yesterday and today, so no data-tailing condition was observed.
- Cron Sales collision audit: Sales runs at approximately `:00`, `:10`, `:20`, `:30`, etc.; Inventory runs at `:25`. The observed schedules do not overlap. The shared lock mechanism is available as an additional guard.
- Repository schedule note: `vercel.json` does not declare this endpoint; route documentation identifies external cron-job.org scheduling at hourly frequency. Production timing confirms the expected `:25` schedule.

**Cron Inventory status: PASS.**

## Final Cron Financial audit — 2026-08-12

Read-only audit only; no schedule, code, database, or cron configuration changed.

- Production endpoint: `POST /api/cron/olsera/financial`, protected by `CRON_SECRET`, `maxDuration=300s`, distributed lock, and checkpointed `start/step` resume per financial period.
- Expected schedule `minute :45`: recent financial checkpoint updates occur at `14:45:28Z`, consistent with the expected external scheduler timing. `vercel.json` does not declare this endpoint; route documentation identifies cron-job.org as the scheduler.
- **10-run limitation:** the production collection `olsera_financial_sync_logs` stores one document per period/run identity (`financial:{store}:{period}`), not one immutable record per cron invocation. Therefore an exact list of the 10 latest invocations, their HTTP statuses, and per-invocation durations is not available from the current persisted audit data.
- Current period `2026-08`: **running**, phase `ledger-details`, account cursor **41/85**, accounts processed 41, records processed 3,832, last updated `2026-08-12T14:45:28.858Z`; no error or failed account recorded. It is resumable, but not complete.
- Previous period `2026-02`: **running**, phase `monthly-reports`, cursor 0, records 0, last updated `2026-08-11T10:18:11.702Z`; no error recorded, but it has made no progress for more than a day and is stale relative to the documented 4-hour observability threshold. This is data tertinggal and prevents a PASS.
- Completed periods: March–July 2026 are `success`/`completed`; their recorded full-run durations range from approximately **51s to 61,193s** (July was a long checkpointed/resumed run, not one runtime invocation).
- Timeout/runtime: no explicit timeout/error is recorded in the persisted period documents. Per-invocation runtime cannot be proven from this schema; the route's internal budget is ~21s and `maxDuration` is 300s, with checkpoint resume designed for longer periods.
- Resume: checkpoint design is present and current August progress confirms resume-based operation. February's unchanged checkpoint shows that resume has not advanced that period recently.
- Overlap/duplicate/stale lock: no active `olsera_sync_locks` record was observed at audit time. No duplicate active financial run can be established from the one-document-per-period schema; the two `running` periods are distinct periods, not duplicate run IDs.
- Collision audit: Sales runs around `:00/:10/...` and Inventory at `:25`; Financial at `:45` does not overlap their observed start times. The shared lock remains an additional guard.

**Cron Financial status: NOT PASS.** Root cause is an unfinished/stale February financial checkpoint (`2026-02`) plus insufficient persisted per-invocation telemetry to verify exactly 10 runs and their durations. Required fix is an operational resume/retry investigation and, separately, durable invocation-level cron telemetry; no fix was applied in this audit.

## Stale Cron Financial February diagnosis — 2026-08-12

Read-only diagnosis; no production resume/write was executed.

- The stale February document is `financial:324175:2026-02`, still `status=running`, `phase=monthly-reports`, `accountCursor=0`, `updatedAt=2026-08-11T10:18:11.702Z`.
- The generic selector currently considers only `currentPeriod` and `previousPeriod`. While August is unfinished, `selectFinancialCronTarget` always returns current August first. February is therefore starved behind August; after the calendar advances, February may fall outside the two-period window entirely and remain orphaned.
- This is not safe to solve by calling `startFinancialSync` for February: that would create/restart a run rather than resume the existing checkpoint. The safe operation is `stepFinancialSync("financial:324175:2026-02", ...)` against the existing run, preserving any valid checkpoint/data.
- No active lock or explicit error was observed. The state is resumable, but stale; the exact blocker inside the `monthly-reports` step requires one controlled resume attempt to surface the upstream/database error.

### Proposed generic code fix — awaiting approval before production resume

1. Add a persisted invocation audit collection/document path for Financial cron runs (`runId`, target period, started/finished timestamps, status, steps, checkpoint, stop reason, safe error code), without storing credentials or raw upstream payloads.
2. Extend automatic target selection to include the oldest unfinished/stale financial period, not only current/previous, while retaining current/previous refresh behavior. Existing `running` runs resume via `stepFinancialSync`; only finalized partial/failed runs may use the existing fresh-start cooldown rules.
3. Add regression tests proving an unfinished historical period cannot starve forever behind an unfinished current period and that stale `running` resumes rather than restarts.

### Exact production action requiring approval

After the generic fix is implemented and validated, run **one controlled read/write resume** for the existing run ID `financial:324175:2026-02` using the normal Financial sync step with its persisted checkpoint. This may write official Olsera monthly reports/ledger entries for February and update only that Financial run's checkpoint/log; it will not reset the run, overwrite unrelated periods, touch Sales/Inventory, or alter figures except from official Olsera responses.

Approval is required before executing that production resume. Current status remains **BLOCKED pending approval**.

## Financial February resume completed — 2026-08-12

- Approved action executed against the existing run ID `financial:324175:2026-02` using `stepFinancialSync`; **`startFinancialSync` was not called** and no run reset/restart occurred.
- Resume path: `monthly-reports` → `ledger-details` → `reconcile` → `completed`.
- 24 sequential steps executed; all **85/85 accounts** processed; **5,862 ledger records**; failed accounts **0**; error **null**.
- Final February status: **`success`**, `finalized=true`, checkpoint cursor **85**, completed `2026-08-12T15:28:14.373Z`.
- Official February reports were refreshed from Olsera: balance sheet, profit/loss, cash flow, and ledger summary. Three report validations are true; profit/loss is stored as `validated=false` because the existing business validation did not match, but the payload is official Olsera data and no manual number change was made.
- August was not touched: remains `running`, phase `ledger-details`, cursor **41/85**, `updatedAt=2026-08-12T14:45:28.858Z` before and after the February resume.
- No Sales/Inventory data was changed by this action; no active lock remained after completion.

**February resume status: PASS for checkpoint completion and official-data sync.**

Next step: implement and test the generic historical-stale-period selector plus invocation telemetry. No generic selector was implemented in this action, and no push was made.
## 2026-08-12 — Cron Financial anti-starvation fix (local, not pushed)

- Root cause addressed generically: auto selector now evaluates current unfinished first, then the oldest unfinished historical period (including stale/running checkpoints), then current refresh due, previous refresh due, and finally no-op.
- Existing `running` checkpoints are resumed through `stepFinancialSync`; no restart/reset or manual report-number edits were introduced.
- Added per-invocation telemetry collection `olsera_financial_cron_invocations` with start/end time, duration, period, status, steps, checkpoint, safe error field, and stop reason. Telemetry failure is non-fatal to the sync response.
- Added anti-starvation regression coverage: current priority, oldest historical selection, and running resume behavior.
- Validation: `npm run test:cron-olsera-financial` PASS 52/52; `npm run test:financial-time-budget` PASS; `npm run type-check` PASS; `npm run build` PASS; `git diff --check` PASS.
- Production was not written, resumed, committed remotely, or pushed in this turn. Last known production state remains February `success` (cursor 85/85, finalized) and August `running` at ledger-details cursor 41/85, resumable and unchanged.
- A fresh read-only DB confirmation from this PC was blocked by local DNS SRV failure: `querySrv ECONNREFUSED _mongodb._tcp.cluster0.dqvtxp8.mongodb.net`; no credentials or connection strings were exposed.
- Next step: commit remains local only; verify the next production Financial invocation records telemetry and that historical February is not selected again after its success state.
## 2026-08-12 — Cron Financial anti-starvation pushed

- Commit `1af55c0` berhasil dipush ke `origin/main`.
- Vercel dibiarkan auto-deploy; tidak ada deploy manual.
- Tidak ada perubahan code/database tambahan setelah push fungsional.
## 2026-08-12 — Pre-push audit commit 1af55c0

- Audit scope commit: hanya `lib/cron-olsera-financial.ts`, test Financial, `lib/mongodb.ts` telemetry collection/index, dan handoff. Sales/Inventory tidak tersentuh.
- Selector aman terhadap starvation: current unfinished tetap prioritas pertama; historical unfinished tertua dipilih setelah current selesai; previous refresh hanya setelahnya; loop tetap dibatasi `MAX_STEPS_PER_REQUEST` dan deadline.
- `running` tetap `startFresh=false` sehingga resume checkpoint, bukan restart. Test mencakup current unfinished, historical stale, previous due, no-op, dan resume running.
- Temuan risiko exact: field telemetry `safeErrorCode` selalu ditulis `null`, termasuk saat invocation menangkap timeout/error. Akibatnya telemetry belum memenuhi audit error secara penuh. Tidak diperbaiki dalam audit-only ini.
- Status audit: `NOT SAFE TO PUSH` sampai safe error telemetry diisi dari jalur error secara generik. Tidak ada code/database change atau push dilakukan pada audit ini.
## 2026-08-12 — Financial telemetry fix and final pre-push audit

- Telemetry kini menyimpan hanya kode aman: `ERROR`, `TIMEOUT`, `DEADLINE`, atau `UNKNOWN`; success tetap `null`.
- Regression telemetry PASS untuk success, thrown error, timeout, deadline, dan memastikan raw error/URL/secret tidak disimpan.
- Full audit tetap PASS: current unfinished prioritas pertama; historical stale diproses setelah current; running selalu resume; loop dibatasi step/deadline; Sales/Inventory tidak terdampak; scope tetap Financial cron, telemetry, tests, Mongo telemetry collection/index, dan handoff.
- Validation PASS: Financial cron 55/55, time-budget 9/9, typecheck, build, dan `git diff --check`.
- Status: `SAFE TO PUSH`. Belum push pada audit ini.
## 2026-08-12 — Read-only audit Cron Sales failure

- Audit production log/telemetry tidak dapat diselesaikan dari home PC karena DNS SRV Mongo gagal: `querySrv ECONNREFUSED _mongodb._tcp.cluster0.dqvtxp8.mongodb.net`.
- Collection/log yang akan diaudit sudah teridentifikasi: `olsera_sync_log` (status, waktu, expected vs processed, failed order ringkas), `olsera_sync_state` (checkpoint terakhir), dan `olsera_order_items` (kelengkapan/duplicate berdasarkan `_id`). Endpoint production adalah Cron Sales `/api/cron/olsera/sales`; kode juga memakai distributed lock Sales.
- Karena read path production terblokir, waktu failure, HTTP/error exact, keberhasilan catch-up, serta audit missing/duplicate belum dapat dibuktikan. Status audit: `BLOCKED — NOT PASS`; tidak ada fix yang diterapkan.
- Tidak ada code, database, schedule, atau cron config yang diubah.
- Next step aman: ulangi audit read-only setelah DNS/Mongo reachable, lalu bandingkan failure log dengan run berikutnya dan expected/processed serta duplicate `_id`.
## 2026-08-12 — Cron Sales failure audit (read-only, fallback bootstrap)

- Bootstrap aplikasi `mongodb-dns` + `withMongo` berhasil membaca production; tidak memakai raw Mongo connection.
- Ditemukan 17 historical `failed` runs. Penyebab yang tersimpan: hari tidak tuntas (terutama 2026-06-01/2026-08-01..07) dan satu rangkaian autentikasi Olsera HTTP 401; tidak ada raw credential/token yang dipakai dalam laporan.
- Run terbaru setelah failure sehat: 20 run terakhir berstatus `success`; masing-masing `expectedOrderCount` sama dengan `processedOrderCount` (53–66), `failedOrderCount=0`.
- Checkpoint Sales: `2026-08-12`. `olsera_order_items` terbaca 13.756 dokumen; duplicate `_id` terdeteksi 0.
- Tidak terlihat evidence missing/duplicate setelah failure; run berikutnya berhasil catch-up berdasarkan expected vs processed dan checkpoint maju.
- Status: **PASS — failure bersifat sementara/historis, data tetap lengkap berdasarkan audit read-only**. Tidak perlu fix.
- Tidak ada code, database, schedule, atau cron config yang diubah.
## 2026-08-12 — Samakan permission user login dengan supervisor

- Semua user yang berhasil login kini menerima seluruh `APP_MODULES`, sehingga menu/UI module gating tidak lagi membatasi user berdasarkan role.
- `requireSupervisor()` dipertahankan sebagai kompatibilitas nama API tetapi sekarang hanya memvalidasi authenticated user; authentication, session, dan disabled-account behavior tetap aktif.
- Supervisor-only backend gates untuk finalisasi, lock/unlock, upload BA, readiness/write actions, reservations, fields sync, payment backfill, dan user-management routes kini menerima user terautentikasi secara konsisten.
- UI reconciliation, inventory, menu Pengguna, finalisasi, upload, lock/unlock, reset/hide/cleanup mengikuti status authenticated, bukan role supervisor.
- Validation PASS: permission audit tests 25/25, users tests 5/5, reconciliation endpoint suite PASS 75/75, auth-base-url 6/6, typecheck PASS, build PASS, `git diff --check` PASS.
- Login/authentication tidak diubah; tidak ada perubahan database manual.
## 2026-08-12 — Validator otomatis Kategori Penjualan: blocker source independen

- Audit source selesai. `syncOlseraSalesByCategory` mengambil order detail dari Olsera, menyimpan ke `olsera_order_items`, lalu aggregate kategori dibentuk dari baris yang sama. `olsera_sales_by_category` juga merupakan hasil turunan AYOSERA dari source tersebut.
- Tidak ditemukan endpoint/response Olsera independen yang menyediakan total qty, nominal, dan breakdown kategori untuk dibandingkan otomatis dengan aggregate AYOSERA.
- Karena itu validator status `Cocok/Perlu Dicek/Data bulan berjalan belum lengkap` belum diimplementasikan; membuatnya sekarang akan menjadi perbandingan AYOSERA terhadap data AYOSERA sendiri dan berisiko false PASS.
- Correction resmi Februari tetap tidak disentuh. Inventory, Financial, YONEX, dan ODEA tidak disentuh.
- Tidak ada code/database/schedule change, test/build/commit/push pada tugas ini.
- Blocker/next step: sediakan export/API Olsera independen yang memuat total qty, nominal, dan kategori; setelah itu validator read-only dapat ditambahkan dengan aturan current month selalu `Data bulan berjalan belum lengkap`.
## 2026-08-12 — Audit YONEX SHORTS MEN inventory (read-only)

Produk: `YONEX SHORTS MEN # SM-J035-2906-RW1-S`; alias lama `106743815` → canonical `118420650`.

### Bukti yang ditemukan

- `olsera_order_items` menyimpan sales dengan alias lama/canonical: Feb **9 qty / Rp1.080.000** (8 baris), Mar 3, Apr 4, Mei 2, Jun **3 qty / Rp360.000** (2 baris), Jul **1 qty / Rp120.000** (1 baris). Jadi angka Feb 11 belum terbukti dari database saat ini; ada selisih 2 qty yang membutuhkan source/export Olsera untuk dibuktikan.
- `olsera_inventory_movements`: hanya 1 baris valid, 2026-07-03, `qtyChange -1`, reference `DF0226070300008313`, productId `118420650`. Tidak ada movement lama untuk Feb–Jun.
- `olsera_inventory_monthly_snapshots`: Feb–Mei opening/closing 4, incoming 0, sales 0, source `carry-forward`, dengan diagnosis tidak ada stockmovement API. Ini adalah carry-forward, bukan anchor fisik terbukti.
- Juni: opening 4, sales 3, closing 1, source `baseline-file` dari `INVENTORI.xlsx` sheet JUNI'26; ini bukti baseline closing/penjualan Juni, tetapi tidak membuktikan opening Februari 20/24.
- Juli: opening 1, incoming 1, sales 1, closing 1, source `stockmovement-forward`; incoming 1 berasal dari perhitungan stockmovement, tetapi hanya satu movement sale tersimpan dan tidak ada bukti purchase/incoming mentah yang bisa ditelusuri.
- Agustus: opening 1, incoming 0, sales 0, closing 1, source `carry-forward`; bulan berjalan belum menjadi anchor final.
- `inventoryStockOpnameReconciliations`: tidak ada opname untuk produk ini. Tidak ditemukan dokumen purchase/incoming independen. Snapshot harian yang ditemukan hanya snapshot stok produk baru pada Juli–Agustus dan tidak membuktikan opening Februari.

### Timeline terbukti

| Periode | Sales terbukti | Arus stok terbukti | Kesimpulan |
|---|---:|---|---|
| Feb | 9 | opening 4 hanya carry-forward | pergerakan lama tidak ditemukan; angka 20/24 dan sales 11 belum terbukti |
| Mar–Mei | 3 / 4 / 2 | carry-forward 4 | pergerakan lama tidak ditemukan |
| Jun | 3 | baseline closing 1; opening snapshot 4 | baseline file terbukti, opening awal rantai tidak |
| Jul | 1 | satu sale -1; incoming 1 dihitung snapshot | incoming source mentah tidak ditemukan |
| Aug | 0 | carry-forward opening/closing 1 | bulan berjalan, belum final |

### Rekomendasi fix exact

- Jangan write/rebuild atau mengubah opening/incoming sekarang.
- Minta/export Olsera resmi yang memuat stok akhir Februari atau stock opname/purchase/incoming untuk SKU ini, serta rincian dua sales Februari yang belum ada.
- Setelah anchor resmi tersedia, lakukan dry-run chain Feb–Aug dengan alias `106743815`/`118420650`, lalu minta approval terpisah sebelum write. Status saat ini: **pergerakan lama tidak ditemukan; opening 20/24 belum terbukti**.
- Tidak ada database write. Inventory lain, Sales aggregate, Financial, YONEX data source, dan ODEA tidak diubah.
