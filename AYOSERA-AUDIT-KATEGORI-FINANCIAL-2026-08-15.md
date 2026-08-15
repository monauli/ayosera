# Audit Read-only Kategori Penjualan dan Laporan Keuangan

Tanggal audit: 15 Agustus 2026  
Production: `https://ayosera.vercel.app`  
Periode: Februari–Agustus 2026

## Metode dan batasan

Audit dilakukan melalui sesi production yang sudah login, hanya membaca halaman dan endpoint yang tersedia. Tidak ada request write, sync, lock, unlock, perubahan data, atau perubahan stok.

Panel Validasi Data Olsera sudah tidak tersedia di production. Halaman Kategori menampilkan hasil sinkronisasi MongoDB AYOSERA/Olsera, bukan dua dataset independen dalam satu pembanding. Pemilih bulan pada halaman Kategori dan Laporan Keuangan tidak menerapkan nilai bulan yang dipilih selama audit; halaman tetap menampilkan Agustus 2026. Karena itu angka bulan lain tidak ditebak dan tidak dinyatakan cocok.

## Kategori Penjualan

| Bulan | Qty AYOSERA | Qty Olsera | Omzet AYOSERA | Omzet Olsera | Selisih | Status |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Februari 2026 | — | — | — | — | — | Belum Dapat Dibuktikan |
| Maret 2026 | — | — | — | — | — | Belum Dapat Dibuktikan |
| April 2026 | — | — | — | — | — | Belum Dapat Dibuktikan |
| Mei 2026 | — | — | — | — | — | Belum Dapat Dibuktikan |
| Juni 2026 | — | — | — | — | — | Belum Dapat Dibuktikan |
| Juli 2026 | — | — | — | — | — | Belum Dapat Dibuktikan |
| Agustus 2026 | — | 1.598 | — | Rp65.053.000 | — | Belum Dapat Dibuktikan |

Agustus terbaca sebagai data sinkronisasi yang belum lengkap sampai 15 Agustus, bukan pembanding penuh AYOSERA-versus-Olsera. Kategori yang tampak antara lain LAPANGAN PADEL 107/Rp19.406.000, LABERS 489/Rp14.686.000, SEWA RAKET 236/Rp9.560.000, dan MINUMAN 620/Rp8.191.000.

Tidak ada kategori yang dapat ditetapkan sebagai selisih nyata karena dataset pembanding independen dan seluruh periode tidak berhasil diperoleh. Tidak ada normalisasi atau penggabungan kategori lintas nama yang dilakukan.

## Laporan Keuangan

| Bulan | Neraca | Laba Rugi | Arus Kas | Buku Besar | Status |
| --- | --- | --- | --- | --- | --- |
| Februari 2026 | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan |
| Maret 2026 | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan |
| April 2026 | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan |
| Mei 2026 | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan |
| Juni 2026 | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan |
| Juli 2026 | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan | Belum Dapat Dibuktikan |
| Agustus 2026 | Belum Dapat Dibuktikan | Selisih | Belum Dapat Dibuktikan | Selisih | Selisih |

Agustus yang terbaca di halaman financial:

- Pendapatan Rp134.257.000,00; Laba Kotor Rp124.432.107,48; Laba Bersih Rp123.978.051,48.
- Saldo Kas Akhir Rp1.022.104.629,92.
- Neraca menampilkan Total Aset Rp2.893.747.428,44 dan Total Kewajiban dan Modal Rp2.893.747.428,44.
- Diagnostic sumber menyatakan subtotal Olsera tidak cocok dengan detail. Akun yang ditandai: 21003, 23000, 40003, 50000, dan 51000.
- Untuk akun 40003, diagnostic menampilkan summary kredit Rp9.020.000 dan detail Rp9.100.000. Untuk akun 51000, summary debit Rp9.731.393 dan detail debit Rp9.761.715,26 serta detail kredit Rp7.041.500. Ini adalah selisih diagnostic sumber, bukan klaim rekonsiliasi AYOSERA-versus-Olsera penuh.

## Detail Buku Besar yang terbukti

| Bulan | Kode Akun | Nama | AYOSERA | Olsera | Selisih | Status |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Agustus 2026 | 21003 | — | -Rp333.000 / 0 | Rp333.000 / 0 | Rp666.000 | Selisih |
| Agustus 2026 | 23000 | — | -Rp20.680.000 / 0 | Rp20.680.000 / 0 | Rp41.360.000 | Selisih |
| Agustus 2026 | 40003 | — | 0 / Rp9.020.000 | 0 / Rp9.100.000 | Rp80.000 | Selisih |
| Agustus 2026 | 50000 | — | 0 / 0 | Rp7.041.500 / 0 | Rp7.041.500 | Selisih |
| Agustus 2026 | 51000 | — | Rp9.731.393 / 0 | Rp9.761.715,26 / Rp7.041.500 | Tidak dapat direduksi menjadi satu saldo | Selisih |

Format di atas mengikuti diagnostic summary/detail yang terlihat; nama akun dan seluruh akun belum tersedia dari halaman yang terbaca, sehingga tidak dibuatkan baris tambahan.

## Export nyata

Export Kategori dan Download laporan keuangan tidak menghasilkan file/download event yang dapat dibuka dan dibaca pada sesi audit ini. HTTP/UI presence saja tidak dianggap PASS. Tidak ada file lokal atau data production yang dibuat.

## Kesimpulan

- Bulan Cocok: belum ada.
- Bulan Selisih: Agustus untuk diagnostic sumber Laporan Keuangan dan Buku Besar; bukan pembuktian penuh seluruh rekonsiliasi.
- Kategori bermasalah: belum dapat ditentukan.
- Akun bermasalah: 21003, 23000, 40003, 50000, 51000 pada diagnostic Agustus.
- Selisih pembulatan Rp1: belum dapat dibuktikan; tidak ada nilai yang dinyatakan cocok hanya karena pembulatan.
- Data belum dapat dibuktikan: seluruh pembanding Kategori Februari–Agustus dan laporan keuangan Februari–Juli; Neraca/Arus Kas/Buku Besar Agustus secara penuh; seluruh export nyata.
- Pemeriksaan manual diperlukan setelah period selector/API menghasilkan periode yang diminta dan tersedia dua sumber independen per periode. Tidak ada tindakan write yang dilakukan dalam audit ini.
