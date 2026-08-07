// AUTO-EXTRACTED dari sheet REF Excel Converter resmi DJP (dibaca langsung dari file, bukan
// diketik ulang dari ingatan). Sumber & tanggal ekstraksi didokumentasikan di docs/coretax.md.
// JANGAN mengedit kode/nama/tarif di file ini secara manual — bila referensi DJP berubah,
// unduh ulang Excel Converter resmi lalu regenerasi file ini dari sana.

/** [kodeObjekPajak, namaObjekPajak, tarifPersen] — REF!A:C Excel Converter BPPU/BPU resmi. */
export const BPU_TAX_OBJECTS: [string, string, number][] = [
  ["24-101-01","Dividen",15],
  ["24-104-05","Jasa Aktuaris",2],
  ["28-409-25","Pekerjaan Konstruksi Terintegrasi yang Dilakukan oleh Penyedia Jasa yang Memiliki Sertifikat Badan Usaha",2.65],
  ["28-409-26","Pekerjaan Konstruksi Terintegrasi yang Dilakukan oleh Penyedia Jasa yang Tidak Memiliki Sertifikat Badan Usaha",4],
  ["28-409-27","Jasa Konsultansi Konstruksi yang Dilakukan oleh Penyedia Jasa yang Memiliki Sertifikat Badan Usaha atau Sertifikat Kompetensi Kerja untuk Usaha Orang Perseorangan",3.5],
  ["28-409-28","Jasa Konsultansi Konstruksi yang Dilakukan oleh Penyedia Jasa yang Tidak Memiliki Sertifikat Badan Usaha atau Sertifikat Kompetensi Kerja untuk Usaha Orang Perseorangan",6],
  ["24-104-06","Jasa Akuntansi, Pembukuan, dan Atestasi Laporan Keuangan",2],
  ["28-417-01","Bunga Simpanan yang Dibayarkan oleh Koperasi kepada Anggota Wajib Pajak Orang Pribadi (bunga sampai dengan Rp240.000,00)",0],
  ["28-417-02","Bunga Simpanan yang Dibayarkan oleh Koperasi kepada Anggota Wajib Pajak Orang Pribadi (bunga di atas Rp240.000,00)",10],
  ["28-419-01","Dividen yang Diterima/Diperoleh Wajib Pajak Orang Pribadi Dalam Negeri",10],
  ["28-423-01","Pemotongan atau pemungutan PPh atas penjualan barang atau penyerahan jasa yang dilakukan oleh Wajib Pajak dengan peredaran bruto tertentu sesuai dengan Peraturan Pemerintah Nomor 23 Tahun 2018 atau Peraturan Pemerintah Nomor 55 Tahun 2022.",0.5],
  ["28-423-02","Pemotongan atau pemungutan PPh atas transaksi pembelian yang dilakukan oleh Wajib Pajak dengan peredaran bruto tertentu sesuai dengan Peraturan Pemerintah Nomor 55 Tahun 2022.",0.5],
  ["28-410-02","Imbalan yang Dibayarkan/Terutang kepada Perusahaan Pelayaran Dalam Negeri",1.2],
  ["28-411-02","Imbalan Charter Kapal Laut dan/atau Pesawat Udara yang Dibayarkan/ Terutang kepada Perusahaan Pelayaran dan/atau Penerbangan Luar Negeri  melalui BUT di Indonesia",2.64],
  ["29-101-01","Imbalan Charter Pesawat Udara yang Dibayarkan/Terutang kepada Perusahaan Penerbangan Dalam Negeri oleh Pemotong Pajak",1.8],
  ["28-421-01","Uplift Hulu Migas",20],
  ["24-104-07","Jasa Hukum",2],
  ["28-421-02","Participating Interest Eksplorasi Hulu Migas",5],
  ["28-421-03","Participating Interest Eksploitasi Hulu Migas",7],
  ["22-900-01","Pembayaran atas Pembelian Barang dan/atau Bahan untuk Kegiatan Usahanya oleh BUMN/Badan Usaha Tertentu",1.5],
  ["22-100-07","Penjualan Hasil Produksi Kepada Distributor di Dalam Negeri oleh Badan Usaha/Industri Tertentu (Industri Semen)",0.25],
  ["22-100-08","Penjualan Hasil Produksi Kepada Distributor di Dalam Negeri oleh Badan Usaha/Industri Tertentu (Industri Baja)",0.3],
  ["24-104-08","Jasa Arsitektur",2],
  ["22-100-09","Penjualan Hasil Produksi Kepada Distributor di Dalam Negeri oleh Badan Usaha/Industri Tertentu (Industri Otomotif)",0.45],
  ["22-100-10","Penjualan Hasil Produksi Kepada Distributor di Dalam Negeri oleh Badan Usaha/Industri Tertentu (Industri Farmasi)",0.3],
  ["22-100-11","Penjualan Hasil Produksi Kepada Distributor di Dalam Negeri oleh Badan Usaha/Industri Tertentu (industri Kertas)",0.1],
  ["22-100-12","Penjualan Kendaraan Bermotor di Dalam Negeri oleh ATPM, APM dan Importir Umum Kendaraan Bermotor",0.45],
  ["22-100-13","Pembelian oleh Badan Usaha Berupa Komoditas Tambang Batubara, Mineral Logam dan Mineral Bukan Logam dari Badan atau Orang Pribadi Pemegang IUP",1.5],
  ["22-100-14","Penjualan Emas Batangan di Dalam Negeri oleh Badan Usaha",0.45],
  ["22-100-15","Pembelian Bahan Hasil Kehutanan yang Belum Melalui Proses Industri Manufaktur, untuk Keperluan Industrinya/Ekspornya oleh Badan Usaha Industri/Eksportir",0.25],
  ["22-100-16","Pembelian Bahan Hasil Perkebunan yang Belum Melalui Proses Industri Manufaktur, untuk Keperluan Industrinya/Ekspornya Oleh Badan Usaha Industri/Eksportir",0.25],
  ["22-100-17","Pembelian Bahan Hasil Pertanian yang Belum Melalui Proses Industri Manufaktur, untuk Keperluan Industrinya/Ekspornya Oleh Badan Usaha Industri/Eksportir",0.25],
  ["22-100-18","Pembelian Bahan Hasil Peternakan yang Belum Melalui Proses Industri Manufaktur, untuk Keperluan Industrinya/Ekspornya Oleh Badan Usaha Industri/Eksportir",0.25],
  ["24-104-09","Jasa Perencanaan Kota dan Arsitektur Landscape;",2],
  ["22-100-19","Pembelian Bahan Hasil Perikanan yang Belum Melalui Proses Industri Manufaktur, untuk Keperluan Industrinya/Ekspornya Oleh Badan Usaha Industri/Eksportir",0.25],
  ["22-401-01","Penjualan BBM oleh Pertamina atau Anak Perusahaan Pertamina Kepada SPBU (Final)",0.25],
  ["22-100-20","Penjualan BBM oleh Pertamina atau Anak Perusahaan Pertamina Kepada Selain SPBU/Agen/Penyalur (Tidak Final)",0.3],
  ["22-401-02","Penjualan BBM oleh Badan Usaha Selain Pertamina atau Anak Perusahaan Pertamina Kepada SPBU/Agen/Penyalur  (Final)",0.3],
  ["22-100-21","Penjualan BBM oleh Badan Usaha Selain Pertamina atau Anak Perusahaan Pertamina Kepada Selain SPBU/Agen/Penyalur (Tidak Final)",0.3],
  ["22-100-22","Penjualan Pelumas oleh Importir/Produsen",0.3],
  ["22-100-23","Penjualan  Pulsa dan Kartu Perdana oleh Penyelenggara Distribusi Tingkat Kedua yang Merupakan Pemungut PPh Pasal 22",0.5],
  ["22-100-24","Penjualan BBG oleh Produsen/Importir Kepada Selain SPBU/Agen/Penyalur (Tidak Final)",0.3],
  ["22-401-03","Penjualan BBG oleh produsen/importir Kepada SPBU/Agen/Penyalur (Final)",0.3],
  ["22-401-04","Penjualan BBM oleh Pertamina atau Anak Perusahaan Pertamina kepada Agen/Penyalur selain SPBU (Final)",0.3],
  ["24-104-10","Jasa Perancang (Design)",2],
  ["22-403-01","Penjualan Barang yang Tergolong Sangat Mewah Selain Rumah Beserta Tanahnya, Apartemen, Kondominium dan Sejenisnya",5],
  ["22-403-02","Penjualan Barang yang Tergolong Sangat Mewah Untuk Rumah Beserta Tanahnya, Apartemen, Kondominium dan Sejenisnya",1],
  ["22-404-01","Ekspor Komoditas Tambang Batubara, Mineral Logam, dan Mineral Bukan Logam yang Dilakukan Oleh Eksportir, Kecuali WP yang Terikat dalam PKP2B dan KK",1.5],
  ["22-405-01","Penghasilan Sehubungan dengan Aset Kripto yang dipungut oleh Penyelenggara Perdagangan Melalui Sistem Elektronik yang Merupakan Pedagang Fisik Aset Kripto",0.1],
  ["22-405-02","Penghasilan Sehubungan dengan Aset Kripto yang dipungut oleh Penyelenggara Perdagangan Melalui Sistem Elektronik yang Bukan Merupakan Pedagang Fisik Aset Kripto",0.2],
  ["22-101-01","Penghasilan Sehubungan dengan Transaksi Penjualan Barang, Penyerahan Jasa, dan/atau Persewaan serta Penghasilan Lain Sehubungan dengan Penggunaan Harta yang Dilakukan Melalui Pihak Lain dalam Sistem Informasi Pengadaan Pemerintah (Tidak Final)",0.5],
  ["22-101-02","Penghasilan Sehubungan dengan Transaksi Penjualan Barang, Penyerahan Jasa, dan/atau Persewaan serta Penghasilan Lain Sehubungan dengan Penggunaan Harta yang Dilakukan Melalui Pihak Lain dalam Sistem Informasi Pengadaan Pemerintah (Final)",0.5],
  ["22-102-01","Penghasilan yang Diterima atau Diperoleh Pedagang Dalam Negeri Penjualan Barang, Penyerahan Jasa, dan/atau Persewaan serta Penghasilan Lain Sehubungan dengan Penggunaan Harta yang Dilakukan Melalui Perdagangan Melalui Sistem Elektronik (Tidak Final)",0.5],
  ["22-102-02","Penghasilan yang Diterima atau Diperoleh Pedagang Dalam Negeri Atas Penjualan Barang, Penyerahan Jasa, dan/atau Persewaan serta Penghasilan Lain Sehubungan dengan Penggunaan Harta yang Dilakukan Melalui Perdagangan Melalui Sistem Elektronik (Final)",0.5],
  ["22-100-25","Penjualan Emas Batangan di Dalam Negeri oleh Pengusaha Emas Perhiasan dan/atau Emas Batangan",0.25],
  ["24-104-11","Jasa Pengeboran (Drilling) di Bidang Penambangan Minyak dan Gas Bumi (Migas) Kecuali yang Dilakukan oleh Badan Usaha Tetap (BUT)",2],
  ["22-100-26","Penjualan Emas Perhiasan di Dalam Negeri oleh Pengusaha Emas Perhiasan dan/atau Emas Batangan",0.25],
  ["22-100-27","Penjualan Perhiasan Selain dari Emas dan/atau Batu Permata dan/atau Batu Lainnya yang Sejenis oleh Pengusaha Emas Perhiasan dan/atau Emas Batangan",0.25],
  ["28-499-02","Penghasilan yang Diterima atau Diperoleh Sehubungan dengan Kerja Sama dengan Lembaga Pengelola Investasi (LPI)",7.5],
  ["28-402-01","Pengalihan Hak atas Tanah dan/atau Bangunan",2.5],
  ["28-402-02","Pengalihan Rumah Sederhana dan Rumah Susun Sederhana yang Dilakukan oleh WP yang Usaha Pokoknya Mengalihkan Hak atas Tanah dan/atau Bangunan",1],
  ["28-402-03","Pengalihan Hak atas Tanah dan/atau Bangunan kepada Pemerintah, BUMN yang Mendapat Penugasan Khusus dari Pemerintah, atau BUMD yang Mendapat Penugasan Khusus dari Kepala Daerah, sesuai UU mengenai Pengadaan Tanah bagi Pembangunan untuk Kepentingan Umum",0],
  ["28-410-01","Imbalan yang Diterima/Diperoleh Sehubungan dengan Pengangkutan Orang dan/atau Barang Termasuk Penyewaan Kapal Laut Oleh Perusahaan Pelayaran Dalam Negeri",1.2],
  ["28-411-01","Imbalan yang Dibayarkan/Terutang kepada Perusahaan Pelayaran dan/atau Penerbangan Luar Negeri Sehubungan dengan Pengangkutan Orang dan/atau Barang (Selain Berdasarkan Perjanjian Charter)",2.64],
  ["28-413-01","Penghasilan Wajib Pajak Luar Negeri yang Mempunyai Kantor Perwakilan Dagang di Indonesia",0.44],
  ["28-499-01","Penghasilan Wajib Pajak yang Melakukan Kegiatan Usaha Jasa Maklon (Contract Manufacturing) Internasional di Bidang Produksi Mainan Anak-Anak",2.1],
  ["24-104-12","Jasa Penunjang di Bidang Usaha Panas Bumi dan Penambangan Minyak dan Gas Bumi (Migas)",2],
  ["22-910-01","Pemungutan oleh Bendaharawan",1.5],
  ["28-423-03","Pemotongan atau Pemungutan PPh atas transaksi penjualan barang atau penyerahan jasa yang dilakukan oleh Wajib Pajak orang pribadi yang memiliki peredaran bruto tertentu sesuai dengan PP 55 Tahun 2022 dengan peredaran usaha s.d Rp500.000.000,00.",0.5],
  ["28-423-12","Pemotongan atau Pemungutan PPh atas transaksi penjualan barang atau penyerahan jasa yang dilakukan oleh Wajib Pajak yang memenuhi persyaratan tertentu untuk dikenai PPh yang bersifat final dengan tarif 0% di IKN (PPh UMKM di IKN).",0],
  ["28-423-13","Pemotongan atau pemungutan PPh atas transaksi pembelian yang dilakukan oleh Wajib Pajak yang memanfaatkan fasilitas PPh final dengan tarif 0% di IKN (PPh UMKM di IKN).",0],
  ["28-404-12","Penghasilan dari Instrumen Moneter dan/atau Instrumen Keuangan Tertentu di Indonesia (Mata Uang VALAS Bersumber dari DHE SDA Tenor Lebih Dari 6 Bulan)",0],
  ["28-404-13","Penghasilan dari Instrumen Moneter dan/atau Instrumen Keuangan Tertentu di Indonesia (Mata Uang VALAS Bersumber dari DHE SDA Tenor 6 Bulan)",2.5],
  ["28-404-14","Penghasilan dari Instrumen Moneter dan/atau Instrumen Keuangan Tertentu di Indonesia (Mata Uang VALAS Bersumber dari DHE SDA Tenor Lebih Dari 3 Bulan sampai dengan Kurang Dari 6 Bulan)",7.5],
  ["28-404-15","Penghasilan dari Instrumen Moneter dan/atau Instrumen Keuangan Tertentu di Indonesia (Mata Uang VALAS Bersumber dari DHE SDA Tenor 1 Bulan sampai dengan Kurang Dari 3 Bulan)",10],
  ["28-404-16","Penghasilan dari Instrumen Moneter dan/atau Instrumen Keuangan Tertentu di Indonesia (Mata Uang IDR Bersumber dari DHE SDA Tenor 6 Bulan atau Lebih Dari 6 Bulan)",0],
  ["28-404-17","Penghasilan dari Instrumen Moneter dan/atau Instrumen Keuangan Tertentu di Indonesia (Mata Uang VALAS Bersumber dari DHE SDA Tenor 3 Bulan sampai dengan Kurang Dari 6 Bulan)",2.5],
  ["24-104-13","Jasa Penambangan dan Jasa Penunjang Selain di Bidang Usaha Panas Bumi dan Penambangan Minyak dan Gas Bumi (Migas)",2],
  ["22-406-01","PPh pasal 22 yang terutang atas penghasilan Kontraktor Utama sehubungan pelaksanaan proyek pemerintah yang dibiayai Hibah atau Pinjaman Luar Negeri",0],
  ["24-106-01","PPh pasal 23 yang terutang atas penghasilan Kontraktor Utama sehubungan pelaksanaan proyek pemerintah yang dibiayai Hibah atau Pinjaman Luar Negeri",0],
  ["28-403-04","Persewaan Tanah dan/atau Bangunan sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",10],
  ["28-409-43","Pekerjaan Konstruksi yang Dilakukan oleh Penyedia Jasa yang Memiliki Sertifikat Badan Usaha Kualifikasi Kecil atau Sertifikat Kompetensi Kerja untuk Usaha Orang Perseorangan sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",1.75],
  ["28-409-44","Pekerjaan Konstruksi yang Dilakukan oleh Penyedia Jasa yang Tidak Memiliki Sertifikat Badan Usaha Atau Sertifikat Kompetensi Kerja untuk Usaha Orang Perseorangan sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",4],
  ["28-409-45","Pekerjaan Konstruksi yang Dilakukan oleh Penyedia Jasa yang Memiliki Sertifikat Selain Sertifikat Badan Usaha Kualifikasi Kecil atau Sertifikat Kompetensi Kerja untuk Usaha Orang Perseorangan sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",2.65],
  ["28-409-46","Pekerjaan Konstruksi Terintegrasi yang Dilakukan oleh Penyedia Jasa yang Memiliki Sertifikat Badan Usaha sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",2.65],
  ["28-409-47","Pekerjaan Konstruksi Terintegrasi yang Dilakukan oleh Penyedia Jasa yang Tidak Memiliki Sertifikat Badan Usaha sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",4],
  ["28-409-48","Jasa Konsultansi Konstruksi yang Dilakukan oleh Penyedia Jasa yang Memiliki Sertifikat Badan Usaha atau Sertifikat Kompetensi Kerja untuk Usaha Orang Perseorangan sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",3.5],
  ["28-409-49","Jasa Konsultansi Konstruksi yang Dilakukan oleh Penyedia Jasa yang Tidak Memiliki Sertifikat Badan Usaha atau Sertifikat Kompetensi Kerja untuk Usaha Orang Perseorangan sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",6],
  ["24-104-14","Jasa Penunjang di Bidang Penerbangan dan Bandar Udara",2],
  ["28-409-50","Jasa Konstruksi Berupa Jasa Perencanaan Konstruksi (Dengan Kualifikasi Usaha) sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",4],
  ["28-409-51","Jasa Konstruksi Berupa Jasa Perencanaan Konstruksi (Tanpa Kualifikasi Usaha) sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",6],
  ["28-409-52","Jasa Konstruksi Berupa Jasa Pelaksanaan Konstruksi (Kualifikasi Usaha Kecil) sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",2],
  ["28-409-53","Jasa Konstruksi Berupa Jasa Pelaksanaan Konstruksi (Kualifikasi Usaha Menengah dan Besar) sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",3],
  ["28-409-54","Jasa Konstruksi Berupa Jasa Pelaksanaan Konstruksi (Tanpa Kualifikasi Usaha) sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",4],
  ["28-409-55","Jasa Konstruksi Berupa Jasa Pengawasan Konstruksi (Dengan Kualifikasi Usaha) sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",4],
  ["28-409-56","Jasa Konstruksi Berupa Jasa Pengawasan Konstruksi (Tanpa Kualifikasi Usaha) sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",6],
  ["28-402-04","Pengalihan Hak atas Tanah dan/atau Bangunan sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",2.5],
  ["28-410-06","Imbalan yang Dibayarkan/Terutang kepada Perusahaan Pelayaran Dalam Negeri sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",1.2],
  ["28-411-05","Imbalan Charter Kapal Laut dan/atau Pesawat Udara yang Dibayarkan/ Terutang kepada Perusahaan Pelayaran dan/atau Penerbangan Luar Negeri melalui BUT di Indonesia sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",2.64],
  ["24-102-01","Bunga Selain yang Dikenakan PPh Pasal 4 ayat (2)",15],
  ["24-104-15","Jasa Penebangan Hutan",2],
  ["29-101-02","Imbalan Charter Pesawat Udara yang Dibayarkan/Terutang kepada Perusahaan Penerbangan Dalam Negeri oleh Pemotong Pajak sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",1.8],
  ["28-410-05","Imbalan yang Diterima/Diperoleh Sehubungan dengan Pengangkutan Orang dan/atau Barang Termasuk Penyewaan Kapal Laut Oleh Perusahaan Pelayaran Dalam Negeri sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",1.2],
  ["28-411-04","Imbalan yang Dibayarkan/Terutang kepada Perusahaan Pelayaran dan/atau Penerbangan Luar Negeri Sehubungan dengan Pengangkutan Orang dan/atau Barang (Selain Berdasarkan Perjanjian Charter) sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",2.64],
  ["22-401-05","Penjualan BBM oleh Badan Usaha Selain Pertamina atau Anak Perusahaan Pertamina Kepada SPBU/Agen/Penyalur  (Final) sehubungan Pelaksanaan Proyek Pemerintah yang Dibiayai dengan Hibah atau Dana Pinjaman Luar Negeri",0.3],
  ["28-423-14","Pemotongan atau pemungutan PPh atas penjualan barang atau penyerahan jasa yang dilakukan oleh Wajib Pajak dengan peredaran bruto tertentu yang memperoleh penghasilan sehubungan pelaksanaan proyek pemerintah yang dibiayai Hibah atau Pinjaman Luar Negeri",0.5],
  ["28-423-15","Pemotongan atau Pemungutan PPh atas transaksi penjualan barang atau penyerahan jasa yang dilakukan oleh Wajib Pajak yang memenuhi persyaratan tertentu untuk dikenai PPh yang bersifat final dengan tarif 0% di IKN yang memperoleh penghasilan sehubungan pelaksanaan proyek pemerintah yang dibiayai Hibah atau Pinjaman Luar Negeri",0],
  ["24-103-02","Royalti yang diterima atau diperoleh Wajib Pajak orang pribadi dalam negeri yang menerapkan penghitungan Pajak Penghasilan menggunakan Norma Penghitungan Penghasilan Neto",6],
  ["28-404-18","Penghasilan dari instrumen moneter dan/atau instrumen keuangan tertentu di Indonesia (mata uang IDR bersumber dari DHE SDA tenor 1 bulan sampai dengan kurang dari 3 bulan)",5],
  ["22-405-04","Penghasilan Sehubungan dengan Aset Kripto yang dipungut oleh Penyelenggara Perdagangan Melalui Sistem Elektronik Dalam Negeri yang Merupakan Pedagang Aset Keuangan Digital",0.21],
  ["22-405-05","Penghasilan Sehubungan dengan Aset Kripto yang dipungut oleh Penyelenggara Perdagangan Melalui Sistem Elektronik Luar Negeri yang Merupakan Pemungut Pajak Penghasilan",1],
  ["24-104-16","Jasa Pengolahan Limbah",2],
  ["22-100-28","Pembelian emas batangan oleh Lembaga Jasa Keuangan penyelenggara Kegiatan Usaha Bulion",0.25],
  ["24-104-17","Jasa Penyedia Tenaga Kerja dan/atau Tenaga Ahli (Outsourcing Services)",2],
  ["24-104-18","Jasa Perantara dan/atau Keagenan",2],
  ["24-104-19","Jasa Bidang Perdagangan Surat-Surat Berharga, Kecuali yang Dilakukan Bursa Efek, Kustodian Sentral Efek Indonesia (KSEI) dan Kliring Penjaminan Efek Indonesia (KPEI)",2],
  ["24-104-20","Jasa Kustodian/Penyimpanan/Penitipan, Kecuali yang Dilakukan Oleh KSEI",2],
  ["24-104-21","Jasa Pengisian Suara (Dubbing) dan/atau Sulih Suara",2],
  ["24-104-22","Jasa Mixing Film",2],
  ["24-104-23","Jasa Pembuatan Sarana Promosi Film, Iklan, Poster, Foto, Slide, Klise, Banner, Pamphlet, Baliho dan Folder",2],
  ["24-104-24","Jasa Sehubungan Dengan Software Atau Hardware Atau Sistem Komputer, Termasuk Perawatan, Pemeliharaan dan Perbaikan.",2],
  ["24-103-01","Royalti",15],
  ["24-104-25","Jasa Pembuatan dan/atau Pengelolaan Website",2],
  ["24-104-26","Jasa Internet Termasuk Sambungannya",2],
  ["24-104-27","Jasa Penyimpanan, Pengolahan dan/atau Penyaluran Data, Informasi, dan/atau Program",2],
  ["24-104-28","Jasa Instalasi/Pemasangan Mesin, Peralatan, Listrik, Telepon, Air, Gas, Ac dan/atau Tv Kabel, Selain Yang Dilakukan Oleh Wajib Pajak Yang Ruang Lingkupnya Di Bidang Konstruksi dan Mempunyai Izin dan/atau Sertifikasi Sebagai Pengusaha Konstruksi;",2],
  ["24-104-29","Jasa Perawatan/Perbaikan/Pemeliharaan Mesin, Peralatan, Listrik, Telepon, Air, Gas, Ac dan/atau Tv Kabel, Selain Yang Dilakukan Oleh Wajib Pajak Yang Ruang Lingkupnya di Bidang Konstruksi dan Mempunyai Izin dan/atau Sertifikasi Sebagai Pengusaha Konstruksi",2],
  ["24-104-30","Jasa Perawatan Kendaraan dan/atau Alat Transportasi Darat, Laut dan Udara",2],
  ["24-104-31","Jasa Maklon",2],
  ["24-104-32","Jasa Penyelidikan dan Keamanan",2],
  ["24-104-33","Jasa Penyelenggara Kegiatan Atau Event Organizer",2],
  ["24-104-34","Jasa Penyediaan Tempat dan/atau Waktu Dalam Media Massa, Media Luar Ruang Atau Media Lain Untuk Penyampaian Informasi, dan/atau Jasa Periklanan",2],
  ["24-100-01","Hadiah, Penghargaan, Bonus dan Lainnya Selain yang Telah Dipotong PPh Pasal 21 Ayat (1) Huruf E UU PPh",15],
  ["24-104-35","Jasa Pembasmian Hama",2],
  ["24-104-36","Jasa Kebersihan Atau Cleaning Service",2],
  ["24-104-37","Jasa Sedot Septic Tank",2],
  ["24-104-38","Jasa Pemeliharaan Kolam",2],
  ["24-104-39","Jasa Katering Atau Tata Boga",2],
  ["24-104-40","Jasa Freight Forwarding",2],
  ["24-104-41","Jasa Logistik",2],
  ["24-104-42","Jasa Pengurusan Dokumen",2],
  ["24-104-43","Jasa Pengepakan",2],
  ["24-104-44","Jasa Loading dan Unloading",2],
  ["24-100-02","Sewa dan Penghasilan Lain Sehubungan Dengan Penggunaan Harta Kecuali Sewa Tanah dan/atau Bangunan yang Telah Dikenai PPh Pasal 4 Ayat (2) UU PPh.",2],
  ["24-104-45","Jasa Laboratorium dan/atau Pengujian Kecuali yang Dilakukan oleh Lembaga atau Institusi Pendidikan Dalam Rangka Penelitian Akademis",2],
  ["24-104-46","Jasa Pengelolaan Parkir",2],
  ["24-104-47","Jasa Penyondiran Tanah",2],
  ["24-104-48","Jasa Penyiapan dan/atau Pengolahan Lahan",2],
  ["24-104-49","Jasa Pembibitan dan/atau Penanaman Bibit",2],
  ["24-104-50","Jasa Pemeliharaan Tanaman",2],
  ["24-104-51","Jasa Pemanenan",2],
  ["24-104-52","Jasa Pengolahan Hasil Pertanian, Perkebunan, Perikanan, Peternakan dan/atau Perhutanan",2],
  ["24-104-53","Jasa Dekorasi",2],
  ["24-104-54","Jasa Pencetakan/Penerbitan",2],
  ["24-104-01","Jasa Teknik",2],
  ["24-104-55","Jasa Penerjemahan",2],
  ["24-104-56","Jasa Pengangkutan/Ekspedisi Kecuali Yang Telah Diatur Dalam Pasal 15 Undang-Undang Pajak Penghasilan",2],
  ["24-104-57","Jasa Pelayanan Pelabuhan",2],
  ["24-104-58","Jasa Pengangkutan Melalui Jalur Pipa",2],
  ["24-104-59","Jasa Pengelolaan Penitipan Anak",2],
  ["24-104-60","Jasa Pelatihan dan/atau Kursus",2],
  ["24-104-61","Jasa Pengiriman dan Pengisian Uang Ke Atm",2],
  ["24-104-62","Jasa Sertifikasi",2],
  ["24-104-63","Jasa Survey",2],
  ["24-104-64","Jasa Tester",2],
  ["24-104-02","Jasa Manajemen",2],
  ["24-104-65","Jasa Selain Jasa-Jasa Tersebut di Atas yang Pembayarannya Dibebankan pada APBN (Anggaran Pendapatan dan Belanja Negara) Atau APBD (Anggaran Pendapatan dan Belanja Daerah).",2],
  ["24-104-66","Jasa Penyelenggaraan Layanan Transaksi Pembayaran Terkait dengan Distribusi Token Oleh Penyelenggara Distribusi",2],
  ["24-104-67","Jasa Pemasaran dengan Media Voucer Oleh Penyelenggara Voucer",2],
  ["24-104-68","Jasa Penyelenggaraan Layanan Transaksi Pembayaran Terkait dengan Distribusi Voucer Oleh Penyelenggara Voucer dan Penyelenggara  Distribusi",2],
  ["24-104-69","Jasa Penyelenggaraan Program Loyalitas dan Penghargaan Pelanggan (Consumer Loyalty/Reward Program)  Oleh Penyelenggara Voucer",2],
  ["24-105-01","Bunga Pinjaman yang Diterima  Wajib Pajak Dalam Negeri dan Bentuk Usaha Tetap Melalui Layanan Pinjam Meminjam Uang Berbasis Teknologi Informasi",15],
  ["28-404-01","Bunga Tabungan dan Bunga Deposito yang Ditempatkan di Dalam Negeri yang Dananya Bersumber Selain dari Devisa Hasil Ekspor (DHE)",20],
  ["28-404-02","Bunga Deposito yang Ditempatkan di Dalam Negeri (mata uang IDR bersumber dari DHE tenor 1 bulan)",7.5],
  ["28-404-03","Bunga Deposito yang Ditempatkan di Dalam Negeri (mata uang IDR bersumber dari DHE tenor 3 bulan)",5],
  ["28-404-04","Bunga Deposito yang Ditempatkan di Dalam Negeri (mata uang IDR bersumber dari DHE tenor 6 bulan atau lebih)",0],
  ["24-104-03","Jasa Konsultan",2],
  ["28-404-05","Bunga Deposito yang Ditempatkan di Dalam Negeri (mata uang USD bersumber dari DHE tenor 1 bulan)",10],
  ["28-404-06","Bunga Deposito yang Ditempatkan di Dalam Negeri (mata uang USD bersumber dari DHE tenor 3 bulan)",7.5],
  ["28-404-07","Bunga Deposito yang Ditempatkan di Dalam Negeri (mata uang USD bersumber dari DHE tenor 6 bulan)",2.5],
  ["28-404-08","Bunga Deposito yang Ditempatkan di Dalam Negeri (mata uang USD bersumber dari DHE tenor lebih 6 bulan)",0],
  ["28-404-09","Bunga Deposito/Tabungan yang Ditempatkan di Luar Negeri Melalui Bank yang Didirikan atau Bertempat Kedudukan di Indonesia atau Cabang Bank Luar Negeri di Indonesia",20],
  ["28-404-10","Diskonto Sertifikat Bank Indonesia",20],
  ["28-404-11","Jasa Giro",20],
  ["28-401-01","Bunga Obligasi, Surat Utang Negara, atau Obligasi Daerah yang Diterima Wajib Pajak Dalam Negeri dan Bentuk Usaha Tetap.",15],
  ["28-401-06","Bunga Obligasi yang Diterima Wajib Pajak Dalam Negeri dan Bentuk Usaha Tetap",10],
  ["28-401-03","Bunga Obligasi yang Diterima Wajib Pajak Dalam Negeri dan Bentuk Usaha Tetap yang diadministrasikan oleh BI",10],
  ["24-104-04","Jasa Penilai (Appraisal)",2],
  ["28-401-04","Diskonto Surat Perbendaharaan Negara yang Diterima Wajib Pajak Dalam Negeri dan Bentuk Usaha Tetap",20],
  ["28-401-05","Diskonto Surat Perbendaharaan Negara yang Diterima Wajib Pajak Penduduk/Berkedudukan di Luar Negeri",20],
  ["28-407-01","Transaksi Penjualan Saham di Bursa Efek (Saham Pendiri)",0.5],
  ["28-406-01","Transaksi Penjualan Saham di Bursa Efek (Bukan Saham Pendiri)",0.1],
  ["28-408-01","Transaksi Penjualan Saham Milik Perusahaan Modal Ventura Tidak di Bursa Efek",0.1],
  ["28-403-02","Persewaan Tanah dan/atau Bangunan",10],
  ["28-405-01","Hadiah Undian",25],
  ["28-409-22","Pekerjaan Konstruksi yang Dilakukan oleh Penyedia Jasa yang Memiliki Sertifikat Badan Usaha Kualifikasi Kecil atau Sertifikat Kompetensi Kerja untuk Usaha Orang Perseorangan",1.75],
  ["28-409-23","Pekerjaan Konstruksi yang Dilakukan oleh Penyedia Jasa yang Tidak Memiliki Sertifikat Badan Usaha Atau Sertifikat Kompetensi Kerja untuk Usaha Orang Perseorangan",4],
  ["28-409-24","Pekerjaan Konstruksi yang Dilakukan oleh Penyedia Jasa yang Memiliki Sertifikat Selain Sertifikat Badan Usaha Kualifikasi Kecil atau Sertifikat Kompetensi Kerja untuk Usaha Orang Perseorangan",2.65]
];

/** [kode, nama] — REF!F:G blok "Kode Fasilitas" Excel Converter BPPU/BPU resmi. */
export const BPU_FASILITAS: [string, string][] = [
  ["N/A","Tanpa Fasilitas"],
  ["TaxExAr22","Surat Keterangan Bebas (SKB) Pemotongan PPh Pasal 22"],
  ["TaxExAr23","Surat Keterangan Bebas (SKB) Pemotongan PPh Pasal 23"],
  ["TaxExIntDep","Surat Keterangan Bebas (SKB) Pemotongan PPh atas Bunga atas Deposito Berjangka dan tabungan"],
  ["TaxExIntPhtb","Surat Keterangan Bebas (SKB) Pemotongan PPh atas Pengalihan Hak atas Tanah dan Bangunan"],
  ["DTP","PPh Ditanggung Pemerintah (DTP)"],
  ["PP23","Surat Keterangan  PP 23/2018"],
  ["ETC","Fasilitas Lainnya"]
];

/** [kode, nama] — REF!F:G blok "Kode Pembayaran IP" (GovTreasurerOpt) Excel Converter BPPU/BPU resmi. */
export const BPU_GOV_TREASURER: [string, string][] = [
  ["N/A","-"],
  ["Imprest","Uang Persediaan"],
  ["Direct","Pembayaran Langsung"]
];

/** [kode, nama] — REF!F:G blok "Kode Dokumen" Excel Converter BPPU/BPU resmi. */
export const BPU_DOCUMENT: [string, string][] = [
  ["Announcement","Pengumuman"],
  ["CommercialInvoice","Surat Tagihan"],
  ["Contract","Kontrak"],
  ["CurrentAccount","Jasa Giro"],
  ["Decree","Decree"],
  ["DeedOfEngagement","Akta Perjanjian"],
  ["DeedOfGeneral","Akta RUPS"],
  ["Other","Lainnya"],
  ["OtherFacilityDoc","Dokumen Fasilitas Lainnya"],
  ["PaymentProof","Bukti Pembayaran"],
  ["StatementLetter","Surat Pernyataan"],
  ["TaxInvoice","Faktur Pajak"],
  ["TaxRegulationDoc","Dokumen Perpajakan"],
  ["TradeConfirmation","Trade Confirmation"]
];

/**
 * [kodeObjekPajak, namaObjekPajak, deemedPersen, tarifAtauSkema] — REF!A:D Excel Converter BP21 resmi.
 * Kolom ke-4 berisi ANGKA tarif final langsung (kode 21-402-xx honor APBN/APBD) ATAU nama skema
 * penghitungan ("TER"/"PS17"/"HARIAN"/"PESANGON"/"PENSIUN") — tarif sebenarnya untuk kode berskema
 * dihitung dari tabel bracket TER/PS17 pada kolom tersembunyi S–Z sheet DATA Converter, yang BELUM
 * diekstraksi (lihat docs/coretax.md "Aturan yang Belum Terverifikasi"). Untuk kode berskema, Tarif
 * WAJIB diisi manual oleh user — aplikasi hanya menampilkan nama skema sebagai bantuan.
 */
export const BP21_TAX_OBJECTS: [string, string, number, number | string][] = [
  ["21-100-35","Upah Pegawai Tidak Tetap yang Dibayarkan secara Bulanan",100,"TER"],
  ["21-100-10","Honorarium atau Imbalan kepada Anggota Dewan Komisaris atau Dewan Pengawas yang Menerima Imbalan secara Tidak Teratur",100,"TER"],
  ["21-100-27","Upah Pegawai Tidak Tetap yang Dibayarkan secara Bulanan yang Mendapat Fasilitas di Daerah Tertentu",100,"TER"],
  ["21-100-07","Imbalan kepada Tenaga Ahli (Pengacara, Akuntan, Arsitek, Dokter, Konsultan, Notaris, Pejabat Pembuat Akte Tanah, Penilai, Aktuaris)",50,"PS17"],
  ["21-100-18","Imbalan kepada Penasihat, Pengajar, Pelatih, Penceramah, Penyuluh, dan Moderator",50,"PS17"],
  ["21-100-19","Imbalan kepada Pengarang, Peneliti, Penerjemah",50,"PS17"],
  ["21-100-20","Imbalan kepada Pemberi Jasa dalam Segala Bidang",50,"PS17"],
  ["21-100-21","Imbalan kepada Agen Iklan",50,"PS17"],
  ["21-100-22","Imbalan kepada Pengawas atau Pengelola Proyek",50,"PS17"],
  ["21-100-23","Imbalan kepada Pembawa Pesanan atau yang Menemukan Langganan atau yang Menjadi Perantara",50,"PS17"],
  ["21-100-06","Imbalan kepada Petugas Penjaja Barang Dagangan",50,"PS17"],
  ["21-100-05","Imbalan kepada Agen Asuransi",50,"PS17"],
  ["21-100-04","Imbalan kepada Distributor Perusahaan Pemasaran Berjenjang atau Penjualan Langsung dan Kegiatan Sejenis Lainnya",50,"PS17"],
  ["21-100-30","Upah Pegawai Tidak Tetap yang Dibayarkan secara Harian, Mingguan, Satuan dan Borongan dengan Penghasilan Bruto lebih dari Rp2.500.000 Sehari",50,"PS17"],
  ["21-100-31","Upah Pegawai Tidak Tetap yang Dibayarkan secara Harian, Mingguan, Satuan dan Borongan dengan Penghasilan Bruto lebih dari Rp2.500.000 Sehari yang Mendapat Fasilitas di Daerah Tertentu",50,"PS17"],
  ["21-100-12","Uang Manfaat Pensiun atau Penghasilan Sejenisnya yang diambil sebagian oleh Peserta Program Pensiun yang Masih Berstatus sebagai Pegawai",100,"PS17"],
  ["21-100-36","Imbalan  kepada Peserta Perlombaan dalam Segala Bidang, antara lain Perlombaan Olah Raga, Seni, Ketangkasan, Ilmu Pengetahuan, Teknologi, dan Perlombaan Lainnya",100,"PS17"],
  ["21-100-14","Imbalan kepada Peserta Rapat, Konferensi, Sidang, Pertemuan, Kunjungan Kerja, Seminar, Lokakarya, atau Pertunjukan, atau Kegiatan Tertentu Lainnya",100,"PS17"],
  ["21-100-15","Imbalan kepada Peserta atau Anggota dalam Suatu Kepanitiaan sebagai Penyelenggara Kegiatan Tertentu",100,"PS17"],
  ["21-100-16","Imbalan kepada Peserta Pendidikan, Pelatihan, dan Magang",100,"PS17"],
  ["21-100-17","Imbalan kepada Peserta Kegiatan Lainnya",100,"PS17"],
  ["21-100-25","Penghasilan berupa Uang Pesangon, Uang Manfaat Pensiun, Tunjangan Hari Tua, atau Jaminan Hari Tua yang Terutang atau Dibayarkan pada Tahun Ketiga dan Tahun-Tahun Berikutnya",100,"PS17"],
  ["21-100-33","Imbalan kepada Pemain Musik, Pembawa Acara, Penyanyi, Pelawak, Bintang Film, Bintang Sinetron, Bintang Iklan, Sutradara, Kru Film, Foto Model, Peragawan/Peragawati, Pemain Drama, Penari, Pemahat, Pelukis, Pembuat/Pencipta Konten pada Media yang Dibagikan secara Daring (Influencer, Selebgram, Blogger, Vlogger, dan Sejenis Lainnya), dan Seniman Lainnya",50,"PS17"],
  ["21-100-34","Imbalan yang Diterima oleh Olahragawan",50,"PS17"],
  ["21-100-24","Upah Pegawai Tidak Tetap yang Dibayarkan secara Harian, Mingguan, Satuan dan Borongan dengan Penghasilan Bruto sampai dengan Rp2.500.000 Sehari",100,"HARIAN"],
  ["21-100-29","Upah Pegawai Tidak Tetap yang Dibayarkan secara Harian, Mingguan, Satuan dan Borongan dengan Penghasilan Bruto sampai dengan Rp2.500.000 Sehari yang Mendapat Fasilitas di Daerah Tertentu",100,"HARIAN"],
  ["21-402-04","Honor atau Imbalan Lain yang Dibebankan kepada APBN atau APBD yang Diterima oleh PNS Golongan I dan Golongan II, Anggota TNI dan Anggota POLRI Golongan Pangkat Tamtama dan Bintara, dan Pensiunannya",100,0],
  ["21-402-02","Honor atau Imbalan Lain yang Dibebankan kepada APBN atau APBD yang Diterima oleh PNS Golongan III, Anggota TNI dan Anggota POLRI Golongan Pangkat Perwira Pertama, dan Pensiunannya",100,5],
  ["21-402-03","Honor atau Imbalan Lain yang Dibebankan kepada APBN atau APBD yang Diterima oleh Pejabat Negara, PNS Golongan IV, Anggota TNI dan Anggota POLRI Golongan Pangkat Perwira Menengah dan Perwira Tinggi, dan Pensiunannya",100,15],
  ["21-401-01","Uang Pesangon yang Dibayarkan Sekaligus",100,"PESANGON"],
  ["21-401-02","Uang Manfaat Pensiun, Tunjangan Hari Tua, atau Jaminan Hari Tua yang Dibayarkan Sekaligus",100,"PENSIUN"],
  ["21-100-37","Penghasilan yang Diterima atau Diperoleh Pegawai Tetap di Daerah Tertentu yang Tidak Memenuhi Persyaratan Fasilitas",100,"TER"]
];

/**
 * [kode, nama] — kode dari REF!G Excel Converter BP21 resmi (blok "Kode Fasilitas", 4 kode: N/A,
 * TaxExAr21, DTP, ETC). Nama "TaxExAr21" tidak tertulis eksplisit di sheet REF BP21 (kolom nama
 * kosong) — dipasangkan dengan nama resmi pola yang sama dengan TaxExAr22/23 pada REF BPU
 * ("Surat Keterangan Bebas (SKB) Pemotongan PPh Pasal 21"), N/A dan DTP dan ETC dipasangkan dari
 * REF BPU yang menuliskan nama lengkapnya (kode identik lintas form).
 */
export const BP21_FASILITAS: [string, string | null][] = [
  ["N/A","Tanpa Fasilitas"],
  ["TaxExAr21","Surat Keterangan Bebas (SKB) Pemotongan PPh Pasal 21"],
  ["DTP","PPh Ditanggung Pemerintah (DTP)"],
  ["ETC","Fasilitas Lainnya"]
];

/** [kode, nama] — kode dari REF!G Excel Converter BP21 resmi (blok "Kode Dokumen"); nama dipasangkan dari REF BPU (kode identik, diverifikasi sama persis). */
export const BP21_DOCUMENT: [string, string | null][] = [
  ["Announcement","Pengumuman"],
  ["CommercialInvoice","Surat Tagihan"],
  ["Contract","Kontrak"],
  ["CurrentAccount","Jasa Giro"],
  ["Decree","Decree"],
  ["DeedOfEngagement","Akta Perjanjian"],
  ["DeedOfGeneral","Akta RUPS"],
  ["Other","Lainnya"],
  ["OtherFacilityDoc","Dokumen Fasilitas Lainnya"],
  ["PaymentProof","Bukti Pembayaran"],
  ["StatementLetter","Surat Pernyataan"],
  ["TaxInvoice","Faktur Pajak"],
  ["TaxRegulationDoc","Dokumen Perpajakan"],
  ["TradeConfirmation","Trade Confirmation"]
];

/** Kode Status PTKP — REF!G Excel Converter BP21 resmi (blok "Status PTKP", 8 kode: TK/0-3, K/0-3 — TIDAK termasuk HB/0-3, beda dari BPMP di bawah). */
export const BP21_PTKP: string[] = ["TK/0","TK/1","TK/2","TK/3","K/0","K/1","K/2","K/3"];

/** [kodeObjekPajak, namaObjekPajak] — REF!F:G Excel Converter BPMP resmi. */
export const BPMP_TAX_OBJECTS: [string, string][] = [
  ["21-100-01","Penghasilan yang diterima oleh Pegawai Tetap termasuk Pegawai Negeri Sipil, Anggota Tentara Nasional Indonesia, Anggota Polisi Republik Indonesia atau Pejabat Negara"],
  ["21-100-02","Penghasilan yang diterima oleh Penerima Pensiun secara  teratur"],
  ["21-100-32","Penghasilan yang diterima oleh Pegawai tetap yang menerima fasilitas di daerah tertentu"]
];

/** Kode CounterpartOpt (Resident/Foreign) — REF!B Excel Converter BPMP resmi. Dipakai juga oleh BPA1 (domain sama, contoh template BPA1 memakai nilai identik). */
export const COUNTERPART_OPT: string[] = ["Resident","Foreign"];

/** Kode Status PTKP (StatusTaxExemption) — REF!C Excel Converter BPMP resmi, 12 kode TK/K/HB. Dipakai juga oleh BPA1 (TaxExemptOpt, domain sama — contoh template BPA1 memakai "TK/0"/"K/3", subset dari daftar ini). */
export const BPMP_PTKP: string[] = ["TK/0","TK/1","TK/2","TK/3","K/0","K/1","K/2","K/3","HB/0","HB/1","HB/2","HB/3"];

/** [kodeObjekPajak, namaObjekPajak] — REF!F:G Excel Converter BPA1 resmi (hanya 3 kode 21-100-01/02/32, sama persis dengan BPMP). */
export const BPA1_TAX_OBJECTS: [string, string][] = [
  ["21-100-01","Penghasilan yang diterima oleh Pegawai Tetap termasuk Pegawai Negeri Sipil, Anggota Tentara Nasional Indonesia, Anggota Polisi Republik Indonesia atau Pejabat Negara"],
  ["21-100-02","Penghasilan yang diterima oleh Penerima Pensiun secara  teratur"],
  ["21-100-32","Penghasilan yang diterima oleh Pegawai tetap yang menerima fasilitas di daerah tertentu"]
];

// ---------------------------------------------------------------------------
// Field BERIKUT TIDAK punya sheet REF resmi di salah satu dari 8 file yang
// ditemukan — nilainya HANYA yang benar-benar teramati dipakai pada contoh
// baris Template XML/Excel Converter resmi (bukan tebakan/ingatan). Daftar
// ini BELUM TENTU LENGKAP; lihat docs/coretax.md "Aturan yang Belum
// Terverifikasi" sebelum menganggap daftar ini final.
// ---------------------------------------------------------------------------

/** Hanya 2 nilai yang teramati pada contoh BPA1_Template.xml/Excel Converter BPA1 resmi — TIDAK terbukti lengkap (kemungkinan ada nilai lain, mis. tahun penuh). */
export const BPA1_STATUS_OF_WITHHOLDING_OBSERVED: string[] = ["PartialYear", "Annualized"];

/** Domain Ya/Tidak self-evident dari Template XML resmi (GrossUpOpt, WorkForSecondEmployer) — bukan dari sheet REF, tapi nilai literal "Yes"/"No" yang muncul di template resmi. */
export const YES_NO_OPTIONS: string[] = ["Yes", "No"];

// ---------------------------------------------------------------------------
// Reference sets siap-pakai untuk dropdown (lib/coretax/modules.ts merujuk key
// di sini lewat CoretaxFieldDef.referenceKey). Format tampilan mengikuti
// permintaan: "kode — nama". Nilai yang DISIMPAN ke XML tetap hanya `value`
// (kode) — lihat lib/coretax/xml-generator.ts.
// ---------------------------------------------------------------------------

export type ReferenceOption = { value: string; label: string; display: string };

function fromPairs(pairs: readonly (readonly [string, string | null])[]): ReferenceOption[] {
  return pairs.map(([value, label]) => ({ value, label: label ?? value, display: label ? `${value} — ${label}` : value }));
}
function fromTriples(rows: readonly (readonly [string, string, number])[]): ReferenceOption[] {
  return rows.map(([value, label]) => ({ value, label, display: `${value} — ${label}` }));
}
function fromValues(values: readonly string[]): ReferenceOption[] {
  return values.map((value) => ({ value, label: value, display: value }));
}

export const REFERENCE_SETS: Record<string, ReferenceOption[]> = {
  "bpu.taxObjectCode": fromTriples(BPU_TAX_OBJECTS),
  "bpu.fasilitas": fromPairs(BPU_FASILITAS),
  "bpu.govTreasurerOpt": fromPairs(BPU_GOV_TREASURER),
  "bpu.document": fromPairs(BPU_DOCUMENT),

  "bp21.taxObjectCode": fromPairs(BP21_TAX_OBJECTS.map(([code, name]) => [code, name] as const)),
  "bp21.fasilitas": fromPairs(BP21_FASILITAS),
  "bp21.document": fromPairs(BP21_DOCUMENT),
  "bp21.statusPtkp": fromValues(BP21_PTKP),

  "bpmp.taxObjectCode": fromPairs(BPMP_TAX_OBJECTS),
  "bpmp.counterpartOpt": fromValues(COUNTERPART_OPT),
  "bpmp.statusPtkp": fromValues(BPMP_PTKP),

  "bpa1.taxObjectCode": fromPairs(BPA1_TAX_OBJECTS),
  // Domain sama dengan BPMP (Resident/Foreign, TK-K-HB) — REF BPA1 sendiri tidak
  // menuliskan ulang daftar ini (lihat komentar BPA1_TAX_OBJECTS di atas), jadi
  // di-reuse dari REF BPMP resmi yang membuktikan domainnya, BUKAN ditebak.
  "bpa1.counterpartOpt": fromValues(COUNTERPART_OPT),
  "bpa1.statusPtkp": fromValues(BPMP_PTKP),
  "bpa1.statusOfWithholdingObserved": fromValues(BPA1_STATUS_OF_WITHHOLDING_OBSERVED),
  "shared.yesNo": fromValues(YES_NO_OPTIONS),
};

/** Cari label tampilan (`kode — nama`) untuk satu nilai kode pada satu reference set — dipakai grid untuk menampilkan pilihan yang sudah tersimpan. */
export function referenceDisplay(referenceKey: string, value: string): string {
  const option = REFERENCE_SETS[referenceKey]?.find((o) => o.value === value);
  return option ? option.display : value;
}

/** Cari tarif REF (BPU by TaxObjectCode) — dipakai validasi "Tarif tidak sesuai dengan Kode Objek Pajak". */
export function bpuRateForTaxObject(taxObjectCode: string): number | null {
  const row = BPU_TAX_OBJECTS.find(([code]) => code === taxObjectCode);
  return row ? row[2] : null;
}

/** Cari Deemed REF (BP21 by TaxObjectCode) — dipakai validasi "Deemed tidak sesuai dengan Kode Objek Pajak". */
export function bp21DeemedForTaxObject(taxObjectCode: string): number | null {
  const row = BP21_TAX_OBJECTS.find(([code]) => code === taxObjectCode);
  return row ? row[2] : null;
}

/** Skema tarif REF (BP21 by TaxObjectCode) — angka final langsung, ATAU nama skema (TER/PS17/HARIAN/PESANGON/PENSIUN) yang berarti tarif WAJIB diisi manual (lihat komentar BP21_TAX_OBJECTS). */
export function bp21RateSchemeForTaxObject(taxObjectCode: string): number | string | null {
  const row = BP21_TAX_OBJECTS.find(([code]) => code === taxObjectCode);
  return row ? row[3] : null;
}
