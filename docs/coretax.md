# Modul Coretax (Fase 1)

## Tujuan Modul

Saat ini staf kantor memasukkan data bukti potong ke Coretax DJP satu per satu secara manual. Modul ini memungkinkan staf untuk:

1. Menyalin banyak baris data dari Excel sekaligus ke grid seperti Excel di AYOSERA.
2. Memeriksa kesalahan data secara otomatis, dengan pesan yang jelas per sel.
3. Memperbaiki data langsung di grid.
4. Menyimpan draft (bisa dibuka/dilanjutkan lain waktu).
5. Melihat preview XML dan mengunduhnya.
6. **Mengunggah file XML tersebut secara manual ke Coretax** — modul ini TIDAK login ke Coretax, TIDAK submit otomatis, TIDAK menyimpan kredensial Coretax apa pun (username/password/cookie/MFA). Semua interaksi dengan Coretax tetap manual di luar AYOSERA.

Nama produk di UI selalu **"Coretax"** (bukan "Cortex").

## Empat Jenis Dokumen

| Kode | Nama lengkap | Root XML |
| --- | --- | --- |
| BPU / BPPU | Bukti Potong Unifikasi | `BpuBulk` |
| BPMP | Bukti Potong Masa Pegawai | `MmPayrollBulk` |
| BP21 | Bukti Potong PPh Pasal 21 Tidak Final | `Bp21Bulk` |
| BPA1 | Bukti Potong Pajak PPh 21/26 (rekap tahunan) | `A1Bulk` |

## Sumber Template Resmi

Delapan file resmi DJP diaudit langsung (dibaca dengan `exceljs`, bukan diketik ulang dari ingatan) dari folder Downloads pengguna:

- `BPU_Template.xml`, `BPPU Excel to XML v.3.xlsx`
- `BPMP_Template.xml`, `BPMP Excel to XML v.3.xlsx`
- `BP21_Template.xml`, `BP21 Excel to XML v.4.xlsx`
- `BPA1_Template.xml`, `BPA1 Excel to XML.xlsx` (dan `BPA1 Excel to XML (1).xlsx`)

Semua 8 file **ditemukan** — tidak ada yang hilang.

Struktur Excel Converter yang relevan:
- Sheet `DATA` — data-entry, header di baris ke-3/4 (beda per modul), termasuk kolom formula (`VLOOKUP` ke sheet `REF`, kalkulasi tarif/DPP) yang membuktikan aturan validasi.
- Sheet `REF` — tabel referensi resmi (Kode Objek Pajak/Nama/Tarif/Deemed, Fasilitas, Jenis Dokumen, Status PTKP, Cara Pembayaran Instansi Pemerintah).
- Sheet bernama modul (`BPPU`/`BPMP`/`BP21`/`BPA1`) — formula pembangun string XML mentah milik Converter (tidak dipakai AYOSERA — generator AYOSERA ditulis ulang murni, lihat `lib/coretax/xml-generator.ts`, bukan menyalin formula Excel).

**Urutan field XML** untuk keempat modul (`lib/coretax/modules.ts`) diverifikasi PERSIS terhadap Template XML resmi (`BPU_Template.xml`, dst.) — dibuktikan lewat golden-XML test terstruktur (`lib/coretax/xml-generator.test.ts`).

**Perbedaan yang ditemukan antara contoh Template XML dan Excel Converter**: tidak ada perbedaan struktural (urutan/nama field) antara Template XML dan Excel Converter untuk keempat modul — keduanya konsisten. Converter tetap dijadikan acuan aturan *input* (referensi kode, formula tarif) karena Template XML hanya contoh satu baris, sedangkan Converter berisi seluruh tabel referensi dan formula validasi.

## Alur User

1. Buka menu **Coretax** di sidebar (butuh modul akses `coretax` — supervisor otomatis punya semua modul, user biasa perlu dicentang lewat halaman Pengguna, sama seperti modul lain).
2. Pilih salah satu dari 4 kartu (`/coretax` → `BPU/BPPU`, `BPMP`, `BP21`, `BPA1`).
3. Isi Nama Draft, NPWP/NIK Perusahaan (TIN), dan Masa/Tahun Pajak (bila relevan) di bagian atas.
4. **Copy-paste dari Excel**: klik sel pertama di grid, salin data dari Excel, tekan **Ctrl+V**. Lihat "Cara Copy-Paste" di bawah.
5. Klik **Periksa Data** (atau biarkan tervalidasi otomatis saat sel selesai diedit/setelah paste).
6. Perbaiki sel yang ditandai merah sampai status **Data Benar**.
7. Klik **Simpan Draft** kapan saja (draft pertama otomatis dibuat saat disimpan pertama kali).
8. Klik **Preview XML** untuk melihat isi XML sebelum diunduh.
9. Klik **Unduh XML** — file `.xml` diunduh ke komputer.
10. **Unggah file XML tersebut secara manual ke aplikasi Coretax DJP** (di luar AYOSERA).

## Cara Pakai Seperti Spreadsheet

Grid Coretax berperilaku seperti Excel: klik sel hanya **memilih** sel itu (bukan langsung mode edit). Sel yang sedang dipilih (**active cell**) ditandai kotak merah tebal; kalau kamu memilih beberapa sel sekaligus (**range**), seluruh range ditandai latar merah muda.

**Memilih sel/range:**
- Klik sekali = pilih satu sel.
- Klik lalu tahan **Shift** dan klik sel lain = pilih range dari sel pertama sampai sel itu.
- **Shift + panah** = perluas pilihan satu sel ke arah panah.
- **Ctrl+Shift+↓ / ↑ / → / ←** = perluas pilihan sampai baris/kolom data terakhir yang berdekatan (kalau kolom kosong, langsung ke ujung grid).
- Drag mouse dari satu sel ke sel lain juga memilih range.
- **Ctrl+A** ditekan pertama kali = pilih semua sel yang ada datanya; ditekan lagi = pilih seluruh grid. Tidak berlaku kalau kamu sedang mengetik di field header (Nama Draft, TIN, dll).

**Berpindah sel:**
- Panah (↑↓←→), **Tab** (kanan), **Shift+Tab** (kiri), **Enter** (bawah), **Shift+Enter** (atas), **Home** (kolom pertama baris itu), **End** (kolom terakhir).

**Mengedit sel:**
- Double-click sel, atau tekan **Enter**/**F2** saat sel terpilih, atau langsung mengetik karakter apa pun saat sel terpilih (mengganti isi lama).
- **Escape** membatalkan edit tanpa menyimpan perubahan.
- **Enter** menyimpan lalu pindah ke bawah; **Tab** menyimpan lalu pindah ke kanan.
- Kolom dropdown (referensi resmi) tetap bisa dipilih dengan keyboard setelah masuk mode edit.

**Copy-paste:**
- **Ctrl+C** menyalin sel/range yang dipilih (satu sel, satu kolom, atau banyak kolom/baris) sebagai teks tab-separated — bisa ditempel langsung ke Excel/Google Sheets, atau ke area lain di grid Coretax.
- **Ctrl+V** menempel mulai dari sel yang sedang aktif. Tombol **Tempel Data** di toolbar juga tersedia sebagai alternatif (memakai Clipboard API browser; sebagian browser meminta izin akses clipboard).
- **Mode A — posisi kolom** (default): kolom pertama data yang ditempel diisi ke kolom yang sedang dipilih, kolom berikutnya mengikuti urutan field modul.
- **Mode B — nama header**: bila baris pertama teks yang ditempel dikenali sebagai nama header (lihat daftar `headerAliases` per field di `lib/coretax/modules.ts`, mis. "Masa Pajak", "NPWP/NIK", "Kode Objek Pajak"), baris itu otomatis **tidak** ikut jadi data, dan kolom dipetakan berdasarkan nama header, bukan posisi — jadi urutan kolom di Excel sumber boleh berbeda dari urutan field XML.
- Baris baru otomatis ditambahkan bila jumlah baris yang ditempel melebihi baris yang tersedia.
- NPWP/NIK/NITKU/nomor dokumen selalu diperlakukan sebagai teks — angka nol di depan tidak pernah hilang, dan tidak pernah berubah jadi notasi ilmiah.

**Menghapus & mengisi cepat:**
- **Delete**/**Backspace** mengosongkan seluruh sel dalam range yang dipilih (baris tidak dihapus). Bila memilih lebih dari 500 sel sekaligus, akan ada konfirmasi dulu.
- **Ctrl+D** (fill down) menyalin nilai baris paling atas dalam range yang dipilih ke seluruh baris di bawahnya — cocok satu kolom maupun beberapa kolom sekaligus. Alur cepat: isi nilai di sel atas → pilih ke bawah dengan **Ctrl+Shift+↓** → tekan **Ctrl+D**.
- **Ctrl+R** (fill right) menyalin nilai kolom paling kiri dalam range ke kolom-kolom di kanannya.

**Undo/Redo:**
- **Ctrl+Z** membatalkan perubahan terakhir (edit sel, paste, hapus, fill down/right, tambah/hapus/duplikat baris, kosongkan). **Ctrl+Y** atau **Ctrl+Shift+Z** mengulangi. Riwayat menyimpan maksimal 50 langkah terakhir per sesi (sengaja dibatasi, bukan riwayat penuh).

**Resize kolom:** tarik garis di sisi kanan judul kolom untuk mengubah lebar; lebar kolom tersimpan selama sesi browser (hilang setelah tutup tab).

### Daftar Shortcut Keyboard

| Tombol | Fungsi |
| --- | --- |
| ↑ ↓ ← → | Pindah satu sel |
| Tab / Shift+Tab | Pindah kanan / kiri |
| Enter / Shift+Enter | Pindah bawah / atas |
| Home / End | Kolom pertama / terakhir pada baris aktif |
| Shift + panah | Perluas pilihan satu sel |
| Ctrl+Shift + panah | Perluas pilihan sampai ujung data/grid |
| Ctrl+A / Ctrl+A lagi | Pilih area data aktif / seluruh grid |
| Ctrl+C | Salin sel/range terpilih (TSV) |
| Ctrl+V | Tempel mulai dari sel aktif |
| Delete / Backspace | Kosongkan isi sel/range terpilih |
| Ctrl+D | Salin nilai baris atas ke bawah (fill down) |
| Ctrl+R | Salin nilai kolom kiri ke kanan (fill right) |
| Enter / F2 | Mulai edit sel aktif |
| Escape | Batalkan edit |
| Ctrl+Z | Undo |
| Ctrl+Y / Ctrl+Shift+Z | Redo |

**Batasan clipboard browser:** akses `navigator.clipboard` (dipakai tombol **Tempel Data** dan sebagai penyempurna Ctrl+C) butuh konteks aman (HTTPS/localhost) dan kadang minta izin eksplisit dari user — bila ditolak, Ctrl+C/Ctrl+V lewat event `copy`/`paste` browser bawaan tetap jadi jalur utama yang jalan tanpa izin tambahan.

## Cara Validasi

Validasi berjalan otomatis: saat sel selesai diedit (blur), setelah paste, saat tombol **Periksa Data** ditekan, dan sebelum Preview/Unduh XML (Preview & Unduh XML akan menjalankan pemeriksaan sekali lagi dan menolak bila masih ada baris bermasalah).

Status per baris: **Belum Diperiksa** / **Benar** / **Perlu Diperbaiki** — kolom ini murni UI/draft, **tidak pernah** ikut ke XML.

## Cara Simpan Draft

Draft tersimpan di MongoDB (koleksi `coretax_drafts`, lihat `lib/coretax/draft-store.ts` + `app/api/coretax/drafts/**`). Klik **Draft Baru** untuk mulai kosong, pilih dari dropdown **"Buka draft tersimpan…"** untuk melanjutkan draft lama, **Ganti Nama** dan **Hapus Draft** (dengan konfirmasi) tersedia setelah draft pernah disimpan. Tidak ada sistem login/role/permission/audit-log baru — akses memakai modul `coretax` pada sistem permission AYOSERA yang sudah ada.

## Cara Preview & Unduh XML

**Preview XML** menjalankan validasi, lalu menampilkan XML lengkap (read-only) bila semua baris berisi data valid — atau pesan penjelasan (`"Masih ada X baris yang perlu diperbaiki sebelum XML dapat diunduh."`) bila belum. **Unduh XML** memakai aturan yang sama. Nama file: `BPPU_2026-08_NamaDraft.xml` (modul bulanan) atau `BPA1_2026_NamaDraft.xml` (BPA1, hanya Tahun Pajak).

## Cara Menguji Generator XML

```
node --no-warnings --experimental-strip-types --test lib/coretax/xml-generator.test.ts
```

Setiap modul punya "golden XML" test yang membuktikan: root benar, TIN tepat setelah root, wrapper/row benar, jumlah row sesuai input, **urutan elemen persis** array `fields` di `lib/coretax/modules.ts`, dan tidak ada field tambahan di luar yang resmi. Bila field/urutan berubah di masa depan, cukup ubah `lib/coretax/modules.ts` — generator (`lib/coretax/xml-generator.ts`) tidak perlu disentuh (satu mesin, berbasis konfigurasi).

## Cara Menambah Referensi Resmi

`lib/coretax/references.ts` diekstraksi LANGSUNG dari sheet `REF` keempat Excel Converter (bukan diketik ulang) memakai skrip sekali-pakai (`exceljs`, dijalankan manual — tidak disertakan sebagai bagian aplikasi karena bersifat one-off). Bila DJP merilis Excel Converter baru dengan referensi berbeda:

1. Unduh Excel Converter resmi terbaru dari Coretax.
2. Baca sheet `REF` (kolom A–D biasanya kode/nama/tarif/deemed; kolom F–G untuk daftar sekunder seperti Fasilitas/Dokumen/Status PTKP — lihat komentar di `lib/coretax/references.ts` untuk pemetaan tiap modul).
3. Perbarui array konstanta yang relevan di `lib/coretax/references.ts` (format `[kode, nama, ...]`).
4. Jalankan `npm run test:coretax` — test referensi/validasi akan gagal bila format berubah.

**Jangan pernah menuliskan kode objek pajak/tarif/referensi dari ingatan** — selalu dari sheet REF resmi.

## Batasan Fase 1

- Tidak ada integrasi login Coretax, tidak ada submit otomatis, tidak ada browser automation.
- Tidak ada penyimpanan token/kredensial/cookie/MFA Coretax di mana pun.
- Undo/Redo hanya menyimpan hingga 50 langkah terakhir (edit sel/paste/hapus/fill down-right/tambah-hapus-duplikat baris/kosongkan), dipicu Ctrl+Z/Ctrl+Y — sengaja sederhana, bukan riwayat penuh. Lihat "Cara Pakai Seperti Spreadsheet" untuk daftar shortcut lengkap.
- Grid tidak mendukung format Excel lanjutan (formula, warna sel, dsb.) — hanya nilai teks per sel.

## Aturan yang Belum Terverifikasi (BLOCKED — jangan ditegakkan sebagai validasi keras sampai dikonfirmasi ulang dari Converter resmi)

Semua item berikut punya komentar `TODO` di kode sumber terkait:

1. **Panjang persis NPWP/NIK/NITKU** — divalidasi "hanya digit", TAPI panjang pastinya (15/16 untuk NPWP lama/baru, 22 untuk NITKU) belum ditegakkan sebagai aturan keras karena tidak ada formula panjang eksplisit ditemukan di sheet DATA Converter.
2. **Tarif BP21 untuk kode berskema TER/PS17/HARIAN/PESANGON/PENSIUN** (`lib/coretax/references.ts`, `BP21_TAX_OBJECTS`) — nilai tarif sebenarnya dihitung dari tabel bracket pada kolom tersembunyi `S`–`Z` sheet `DATA` Excel Converter BP21, yang **belum diekstraksi**. Untuk kode-kode ini, Tarif WAJIB diisi manual oleh user; validasi hanya menampilkan nama skema sebagai bantuan, tidak menghitung otomatis. Hanya kode dengan tarif final berupa angka langsung (mis. `21-402-02` = 5%) yang divalidasi otomatis.
3. **NumberOfMonths vs StatusOfWithholding (BPA1)** — contoh baris Excel Converter resmi menunjukkan pola yang tidak intuitif (`PartialYear` → 0 bulan, `Annualized` → 2 bulan), sehingga aturan pastinya TIDAK ditegakkan sebagai validasi silang. Perlu konfirmasi lebih lanjut dari Converter resmi atau dokumentasi DJP.
4. **Daftar lengkap nilai `StatusOfWithholding` (BPA1)** — hanya 2 nilai teramati di Template/Converter resmi (`PartialYear`, `Annualized`); kemungkinan ada nilai lain (mis. status tahun penuh) yang belum terbukti dari file resmi yang tersedia.
5. **Fasilitas (`TaxCertificate`) untuk BPMP dan BPA1** — sheet `REF` BPMP dan BPA1 sendiri tidak menuliskan ulang daftar Fasilitas Pasal 21; nilainya di-*cross-reference* dari REF BP21 (`TaxExAr21`/`DTP`/`ETC`/`N/A`, domain Pasal 21 yang sama, dibuktikan lewat contoh baris Converter BPMP/BPA1 yang memakai kode-kode ini). Didokumentasikan eksplisit di komentar `lib/coretax/references.ts`, bukan ditebak.
6. **`GovTreasurerOpt` (BPU)** hanya diverifikasi 3 nilai dari REF (`N/A`/`Imprest`/`Direct`) — kemungkinan lengkap, tapi tidak ada bukti eksplisit "ini semua nilai yang ada".

## Audit & QA Akhir Fase 1

Sesi audit terpisah (setelah implementasi awal) memverifikasi ulang seluruh modul tanpa mengubah kode: audit diff (tidak ada file tidak berkaitan/credential/data sensitif), review keamanan route API draft (gate `requireModule("coretax")` + validasi `zod` di kedua route, tidak ada risiko NoSQL-injection pada `_id`), QA browser via `playwright-core` (Chrome terpasang, login pakai kredensial dev `.env.local`) — 14/14 check PASS: menu Coretax tampil, `/coretax` 4 kartu, keempat halaman modul terbuka tanpa redirect/error, toolbar & grid BPU berfungsi, mobile & dark mode tanpa error, 0 console error, 0 request 5xx. `npm run test:coretax` (41/41), `npm run test:unit`, `npx tsc --noEmit`, `npm run build`, `git diff --check` seluruhnya PASS. Tidak ditemukan masalah nyata yang memerlukan perbaikan kode. Keterbatasan: paste Ctrl+V dari clipboard OS sungguhan dan buka-file-XML-hasil-unduhan tidak bisa diuji penuh lewat Chrome headless — logic-nya sudah dibuktikan lewat unit test (`draft-store.test.ts`, `xml-generator.test.ts`), tapi disarankan dicoba manual sekali oleh user sebelum commit. Detail lengkap di `tmp/ai-handoff.md`.

## Struktur Kode

```
lib/coretax/
  types.ts              — tipe bersama (CoretaxModuleConfig, CoretaxRow, dst.)
  field-labels.ts        — kamus label Bahasa Indonesia per nama field XML
  references.ts          — data REF hasil ekstraksi + REFERENCE_SETS siap-pakai untuk dropdown
  modules.ts              — registry 4 modul: urutan field XML, tipe, referensi, headerAliases
  paste-parser.ts         — parser paste Excel (mode posisi & mode header)
  validation.ts           — validasi per baris + canExportCoretaxRows (gerbang Preview/Unduh)
  xml-generator.ts        — satu mesin generator XML berbasis konfigurasi modul
  draft-store.ts          — CRUD draft (murni, testable tanpa Next.js Request/Response)
  *.test.ts               — regression test (lihat "Cara Menguji Generator XML")

components/coretax/
  coretax-cards.tsx              — 4 kartu di /coretax
  coretax-grid.tsx                — grid seperti Excel
  coretax-toolbar.tsx             — toolbar (Tambah/Hapus/Duplikat/dst.)
  coretax-validation-summary.tsx  — ringkasan "Data Benar"/"Perlu Diperbaiki"
  coretax-xml-preview.tsx         — modal Preview XML
  coretax-module-page.tsx         — halaman modul lengkap (state + wiring), dipakai keempat route

app/coretax/
  page.tsx, bpu/page.tsx, bpmp/page.tsx, bp21/page.tsx, bpa1/page.tsx

app/api/coretax/drafts/
  route.ts        — GET (list per modul) / POST (buat draft)
  [id]/route.ts    — GET / PATCH (simpan) / DELETE
```

XML generator berjalan MURNI di browser (tidak ada route `/api/coretax/export` — tidak diperlukan karena `lib/coretax/xml-generator.ts` tidak butuh akses server/database, hanya konfigurasi modul + data baris yang sudah ada di state UI).
