import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  detectReportPeriod,
  parseFinancialAmount,
  parseFinancialReport,
  stripLetterhead,
  type MappingLine,
  type MappingToken,
} from "./mapping-parser.ts";

type Fixture = { source: string; rowTolerance: number; tokens: MappingToken[] };

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), "utf8")) as Fixture;
}

/** Nominal dibandingkan dengan epsilon kecil — nilai desimal ikut dijumlah float. */
function assertAmount(actual: number | null | undefined, expected: number, message: string): void {
  assert.ok(actual !== null && actual !== undefined, `${message}: nilai tidak ada`);
  assert.ok(Math.abs(actual - expected) < 0.005, `${message}: dapat ${actual}, seharusnya ${expected}`);
}

function findLine(lines: readonly MappingLine[], code: string): MappingLine {
  const line = lines.find((l) => l.code === code);
  assert.ok(line, `baris dengan kode akun ${code} tidak ditemukan`);
  return line;
}

function findLabel(lines: readonly MappingLine[], pattern: RegExp): MappingLine {
  const line = lines.find((l) => pattern.test(l.label));
  assert.ok(line, `baris dengan label ${pattern} tidak ditemukan`);
  return line;
}

describe("parseFinancialAmount", () => {
  test("format Indonesia (titik ribuan, koma desimal)", () => {
    assert.equal(parseFinancialAmount("33.230.000,00"), 33230000);
    assert.equal(parseFinancialAmount("20.614.923,86"), 20614923.86);
    assert.equal(parseFinancialAmount("0,00"), 0);
  });

  test("format US (koma ribuan, titik desimal) — dipakai fixture scan Feb-2026", () => {
    assert.equal(parseFinancialAmount("39,981,000.00"), 39981000);
    assert.equal(parseFinancialAmount("40,053.48"), 40053.48);
  });

  test("tanpa desimal: pemisah terakhir diikuti 3 digit = ribuan, bukan desimal", () => {
    assert.equal(parseFinancialAmount("8,336,399"), 8336399);
    assert.equal(parseFinancialAmount("2,600"), 2600);
    assert.equal(parseFinancialAmount("560,679"), 560679);
  });

  test("negatif: kurung akuntansi dan minus menempel", () => {
    assert.equal(parseFinancialAmount("(162.000,00)"), -162000);
    assert.equal(parseFinancialAmount("-1.244.490,25"), -1244490.25);
  });

  test("bukan nominal", () => {
    // Tanda hubung telanjang ditangani terpisah sebagai placeholder nihil /
    // tanda negatif, jadi di sini harus null — bukan 0.
    assert.equal(parseFinancialAmount("-"), null);
    assert.equal(parseFinancialAmount("V"), null);
    assert.equal(parseFinancialAmount("Penjualan"), null);
    assert.equal(parseFinancialAmount(""), null);
  });
});

describe("parseFinancialReport — fixture Feb-2026 (PDF hasil scan, OCR)", () => {
  const fixture = loadFixture("mapping-laba-rugi-feb-2026-scan");
  const result = parseFinancialReport(fixture.tokens, { rowTolerance: fixture.rowTolerance });

  test("diterima, dan offset layout terdeteksi otomatis sebagai 1 baris", () => {
    assert.equal(result.status, "ok");
    assert.ok(result.status === "ok");
    // Dokumen ini mencetak nominal 1 baris DI ATAS labelnya. Offset tidak
    // di-hardcode: asosiasi lurus dicoba dulu dan ditolak karena totalnya
    // tidak rekonsiliasi.
    assert.equal(result.rowOffsetApplied, 1);
  });

  test("baris pendapatan sesuai angka terverifikasi", () => {
    assert.ok(result.status === "ok");
    assertAmount(findLine(result.lines, "40000").value, 39981000, "40000 Penjualan");
    assertAmount(findLine(result.lines, "40001").value, 98453500, "40001 Pendapatan Court Fees");
    assertAmount(findLine(result.lines, "40002").value, 15033000, "40002 Penjualan produk LABERS");
    assertAmount(findLine(result.lines, "40005").value, 40000, "40005 Pendapatan Hairwash dan Manicure");
    assertAmount(findLine(result.lines, "46100").value, -584600, "46100 Potongan penjualan");
    assertAmount(findLine(result.lines, "46300").value, -60000, "46300 Return penjualan");
    assertAmount(findLabel(result.lines, /^Total Pendapatan$/i).value, 152862900, "Total Pendapatan");
  });

  test("placeholder nihil jadi 0 dan ditandai, bukan barisnya hilang", () => {
    assert.ok(result.status === "ok");
    // Baris 40004 di dokumen berisi tanda "–". OCR membacanya sebagai ":"
    // dengan confidence 0, jadi tidak ada nominal sama sekali di sel itu.
    const pickleball = findLine(result.lines, "40004");
    assert.equal(pickleball.value, 0);
    assert.equal(pickleball.assumedZero, true);
    assert.match(pickleball.label, /Pickleball/);
  });

  test("tanda minus yang berdiri sendiri terbaca sebagai tanda negatif", () => {
    assert.ok(result.status === "ok");
    // Pada fixture ini minus adalah token terpisah ~175px di kiri angkanya.
    assertAmount(findLine(result.lines, "50500").value, -142000, "50500 Potongan pembelian");
    assertAmount(findLine(result.lines, "70001").value, -2600, "70001 Pembulatan");
  });

  test("subtotal dan baris turunan sesuai angka terverifikasi", () => {
    assert.ok(result.status === "ok");
    assertAmount(findLabel(result.lines, /^Total Biaya Pokok Penjualan$/i).value, 32428163.86, "Total BPP");
    assertAmount(findLabel(result.lines, /Laba Kotor/i).value, 120434736.14, "Laba Kotor");
    assertAmount(findLabel(result.lines, /^Total Biaya Operasional$/i).value, 122584699, "Total Biaya Operasional");
    assertAmount(findLabel(result.lines, /^Laba Bersih$/i).value, -2670588.83, "Laba Bersih");
  });

  test("baris biaya operasional lengkap dan berlabel benar", () => {
    assert.ok(result.status === "ok");
    assertAmount(findLine(result.lines, "60001").value, 8000000, "60001 Biaya keamanan - Security");
    assertAmount(findLine(result.lines, "60002").value, 35000000, "60002 Biaya Sewa");
    assertAmount(findLine(result.lines, "60003").value, 31500000, "60003 Amortisasi By Pra Operasional");
    assertAmount(findLine(result.lines, "60100").value, 22689000, "60100 Biaya gaji");
    assertAmount(findLine(result.lines, "60200").value, 17059300, "60200 Biaya air listrik telephone");
    assertAmount(findLine(result.lines, "60300").value, 8336399, "60300 Biaya perlengkapan");
  });

  test("halaman Neraca dan Arus Kas di bundel yang sama tidak ikut terparse", () => {
    assert.ok(result.status === "ok");
    // Berkas ini 3 halaman: Laba Rugi, Neraca, Arus Kas. Parsing berhenti di
    // baris Laba Bersih supaya kode akun Neraca tidak ikut direkonsiliasi.
    assert.equal(result.lines.at(-1)?.label.trim(), "Laba Bersih");
    assert.equal(result.lines.some((l) => l.code?.startsWith("111")), false);
  });

  test("seluruh cek rekonsiliasi lulus", () => {
    assert.ok(result.status === "ok");
    assert.equal(result.checks.every((c) => c.passed), true);
    assert.equal(result.checks.filter((c) => c.kind === "section").length, 5);
  });

  test("periode terbaca dari kop surat: Feb-26", () => {
    assert.ok(result.status === "ok");
    assert.equal(result.period, "2026-02");
  });

  test("kop surat tidak ikut jadi baris data, dan isi laporan utuh", () => {
    assert.ok(result.status === "ok");
    // Nama perusahaan, judul laporan, dan baris periode terbaca OCR sebagai
    // baris tersendiri ("Li I= BC PADEL CLUB", "La Laporan Laba Rugi", "Ea",
    // "Feb-26"). Semuanya kop, bukan data.
    for (const junk of [/BC PADEL CLUB/i, /Laporan Laba Rugi/i, /^Feb-?26$/i, /^Ea$/]) {
      assert.equal(result.lines.some((l) => junk.test(l.label)), false, `kop ${junk} masih ikut terbaca`);
    }
    // Judul section tepat di atas akun pertama BUKAN kop dan harus bertahan.
    assert.equal(result.lines[0]?.label, "Pendapatan");
    // Pembersihan tidak boleh mengurangi isi: angka acuan Februari 2026.
    assert.equal(result.lines.filter((l) => l.kind === "detail").length, 19);
    assert.equal(result.checks.length, 6);
    assert.equal(result.checks.every((c) => c.passed), true);
  });
});

describe("parseFinancialReport — fixture Mei-2026 (PDF digital, text layer)", () => {
  const fixture = loadFixture("mapping-laba-rugi-mei-2026-digital");
  const result = parseFinancialReport(fixture.tokens, { rowTolerance: fixture.rowTolerance });

  test("diterima tanpa offset — dokumen ini nominalnya sebaris dengan label", () => {
    assert.equal(result.status, "ok");
    assert.ok(result.status === "ok");
    assert.equal(result.rowOffsetApplied, 0);
  });

  test("format angka Indonesia dan negatif berkurung terbaca", () => {
    assert.ok(result.status === "ok");
    assertAmount(findLine(result.lines, "40000").value, 33230000, "40000 Penjualan");
    assertAmount(findLine(result.lines, "40001").value, 258357500, "40001 Pendapatan Court Fees");
    // Tercetak "(162.000,00)" — notasi kurung, bukan minus.
    assertAmount(findLine(result.lines, "50500").value, -162000, "50500 Potongan pembelian");
    assertAmount(findLine(result.lines, "51000").value, 17685139.51, "51000 Harga pokok penjualan");
  });

  test("nilai nihil tercetak 0,00 terbaca 0 tanpa ditandai asumsi", () => {
    assert.ok(result.status === "ok");
    const pickleball = findLine(result.lines, "40004");
    assert.equal(pickleball.value, 0);
    assert.equal(pickleball.assumedZero, false);
  });

  test("periode terbaca dari kop surat: Mei 2026", () => {
    assert.ok(result.status === "ok");
    assert.equal(result.period, "2026-05");
  });

  test("laporan lintas halaman tersambung dan seluruh cek lulus", () => {
    assert.ok(result.status === "ok");
    // Section Biaya Operasional terpotong batas halaman 1/2.
    assertAmount(findLine(result.lines, "60005").value, 15071000, "60005 (halaman 1)");
    assertAmount(findLine(result.lines, "60701").value, 4245600, "60701 (halaman 2)");
    assertAmount(findLabel(result.lines, /^Total Biaya Operasional$/i).value, 178852843, "Total Biaya Operasional");
    assertAmount(findLabel(result.lines, /^Laba bersih$/i).value, 129448027.24, "Laba bersih");
    assert.equal(result.checks.every((c) => c.passed), true);
  });
});

describe("Neraca — fixture Feb-2026 halaman 2 (PDF hasil scan, OCR)", () => {
  const fixture = loadFixture("mapping-laba-rugi-feb-2026-scan");
  const result = parseFinancialReport(fixture.tokens, { rowTolerance: fixture.rowTolerance, kind: "balance-sheet" });

  test("diterima, dengan offset layoutnya SENDIRI", () => {
    assert.ok(result.status === "ok", result.status === "rejected" ? result.reason : "");
    // Berkas yang SAMA: Laba Rugi di halaman 1 mencetak nominal satu baris di
    // atas labelnya (offset 1), Neraca di halaman 2 sebaris (offset 0). Tiap
    // laporan mendeteksi offsetnya sendiri, bukan mewarisi milik tetangganya.
    assert.equal(result.rowOffsetApplied, 0);
    assert.equal(result.period, "2026-02");
  });

  test("angka terverifikasi Februari 2026", () => {
    assert.ok(result.status === "ok");
    assertAmount(findLabel(result.lines, /^Total Aset$/i).value, 2116925420.78, "Total Aset");
    assertAmount(findLabel(result.lines, /^Total Kewajiban$/i).value, 120217139, "Total Kewajiban");
    assertAmount(findLabel(result.lines, /^Total Modal$/i).value, 1996708281.78, "Total Modal");
    assertAmount(findLabel(result.lines, /^Total Kewajiban dan Modal$/i).value, 2116925420.78, "Total Kewajiban dan Modal");
  });

  test("nominal yang terdorong ke dalam label oleh derau OCR tetap terbaca", () => {
    assert.ok(result.status === "ok");
    // Baris ini terbaca OCR sebagai "11702 Biaya Pra Operasional
    // 1,572,107,617.00 beluw Tut Ponloayor" — nominalnya di tengah, derau di
    // kanannya. Ini nominal TERBESAR di laporan; kalau hilang, Neraca ditolak.
    const line = findLine(result.lines, "11702");
    assertAmount(line.value, 1572107617, "11702 Biaya Pra Operasional");
    assert.equal(line.label, "Biaya Pra Operasional");
  });

  test("baris tanpa kode akun tetap terhitung sebagai detail bila section-nya ditutup subtotal", () => {
    assert.ok(result.status === "ok");
    // "Pendapatan Periode ini" dicetak TANPA kode akun. Kalau ia dianggap
    // baris turunan, Total Modal meleset persis sebesar nilainya.
    const line = findLabel(result.lines, /^Pendapatan Periode ini$/i);
    assert.equal(line.kind, "detail");
    assertAmount(line.value, -2680094.81, "Pendapatan Periode ini");
  });

  test("token simbol di kiri label dibuang supaya baris penutup tetap dikenali", () => {
    assert.ok(result.status === "ok");
    // OCR membaca baris ini sebagai "/™ Total Aset Lancar". Dengan awalan itu
    // ia bukan subtotal, dan section Aset tidak pernah tertutup.
    assert.equal(findLabel(result.lines, /^Total Aset Lancar$/i).kind, "subtotal");
  });

  test("identitas Neraca diperiksa, dan halaman tetangga tidak ikut terbawa", () => {
    assert.ok(result.status === "ok");
    assert.equal(result.checks.every((c) => c.passed), true);
    assert.ok(result.checks.some((c) => c.kind === "final" && /Total Aset = Total Kewajiban dan Modal/.test(c.label)));
    // Laba Rugi (halaman 1) dan Arus Kas (halaman 3) tidak boleh ikut.
    assert.equal(result.lines.some((l) => l.code?.startsWith("40")), false);
    assert.equal(result.lines.some((l) => /^Saldo Kas/i.test(l.label)), false);
  });
});

describe("Arus Kas — fixture Feb-2026 halaman 3 (PDF hasil scan, OCR)", () => {
  const fixture = loadFixture("mapping-laba-rugi-feb-2026-scan");
  const result = parseFinancialReport(fixture.tokens, { rowTolerance: fixture.rowTolerance, kind: "cashflow" });

  test("diterima walau TIDAK ADA kode akun sama sekali", () => {
    assert.ok(result.status === "ok", result.status === "rejected" ? result.reason : "");
    assert.equal(result.period, "2026-02");
    // Laporan ini tidak mencetak kode akun, jadi "detail = punya kode akun"
    // tidak berlaku di sini. Keenam baris aktivitas tetap harus jadi detail.
    assert.equal(result.lines.filter((l) => l.kind === "detail").length, 6);
    assert.equal(result.lines.every((l) => l.code === null), true);
  });

  test("angka terverifikasi Februari 2026", () => {
    assert.ok(result.status === "ok");
    assertAmount(findLabel(result.lines, /^Total Aktivitas Operasional$/i).value, -147870178.97, "Total Aktivitas Operasional");
    assertAmount(findLabel(result.lines, /^Saldo Kas Awal$/i).value, 448625339.61, "Saldo Kas Awal");
    assertAmount(findLabel(result.lines, /^Saldo Kas Akhir$/i).value, 300755160.64, "Saldo Kas Akhir");
  });

  test("baris turunan di bawah subtotal TIDAK ikut jadi detail", () => {
    assert.ok(result.status === "ok");
    // Ketiganya bernilai dan tanpa kode akun, sama seperti baris aktivitas di
    // atasnya. Yang membedakan: tidak ada baris "Total ..." sesudahnya.
    for (const pattern of [/Penurunan Kas$/i, /^Saldo Kas Awal$/i, /^Saldo Kas Akhir$/i]) {
      assert.equal(findLabel(result.lines, pattern).kind, "derived", `${pattern} seharusnya baris turunan`);
    }
  });

  test("identitas Arus Kas diperiksa: saldo awal + aktivitas = saldo akhir", () => {
    assert.ok(result.status === "ok");
    assert.equal(result.checks.every((c) => c.passed), true);
    const final = result.checks.find((c) => c.kind === "final");
    assert.ok(final);
    assert.match(final.label, /Saldo Kas Awal \+ aktivitas = Saldo Kas Akhir/);
    assertAmount(final.actual, 300755160.64, "saldo awal + aktivitas");
  });
});

describe("laporan yang tidak ada di berkas dibedakan dari yang ditolak", () => {
  const fixture = loadFixture("mapping-laba-rugi-mei-2026-digital");

  test("PDF Laba Rugi saja: Neraca dan Arus Kas ditandai tidak ada, bukan ditolak", () => {
    for (const kind of ["balance-sheet", "cashflow"] as const) {
      const result = parseFinancialReport(fixture.tokens, { rowTolerance: fixture.rowTolerance, kind });
      assert.ok(result.status === "rejected");
      assert.equal(result.notFound, true);
      assert.match(result.reason, /tidak ada di berkas PDF ini/);
    }
  });

  test("Laba Rugi di berkas yang sama tetap terbaca utuh", () => {
    const result = parseFinancialReport(fixture.tokens, { rowTolerance: fixture.rowTolerance, kind: "profit-loss" });
    assert.ok(result.status === "ok");
    assert.equal(result.lines.filter((l) => l.kind === "detail").length, 48);
  });
});

describe("pengaman aritmatika — dokumen yang tidak rekonsiliasi DITOLAK", () => {
  const fixture = loadFixture("mapping-laba-rugi-feb-2026-scan");

  /** Buang token pertama yang cocok, meniru satu kegagalan baca OCR. */
  function withoutToken(match: (token: MappingToken, tokens: MappingToken[]) => boolean): MappingToken[] {
    const tokens = fixture.tokens;
    const index = tokens.findIndex((token) => match(token, tokens));
    assert.notEqual(index, -1, "token yang mau dibuang tidak ditemukan di fixture");
    return tokens.filter((_, i) => i !== index);
  }

  test("tanda minus hilang (sign flip yang benar-benar terjadi di 158 DPI) ditolak", () => {
    // Spike membuktikan pada render 158 DPI tanda minus untuk 142.000 hilang
    // dan terbaca +142.000, tanpa sinyal confidence apa pun. Ini simulasi
    // persis kegagalan itu di atas token 300 DPI yang utuh.
    const anchor = fixture.tokens.find((t) => t.text === "142,000.00");
    assert.ok(anchor, "token 142,000.00 tidak ada di fixture");
    const tokens = withoutToken(
      (t) => t.text === "-" && t.page === anchor.page && t.x < anchor.x && Math.abs(t.y - anchor.y) <= fixture.rowTolerance,
    );
    const result = parseFinancialReport(tokens, { rowTolerance: fixture.rowTolerance });
    assert.equal(result.status, "rejected");
    assert.ok(result.status === "rejected");
    assert.match(result.reason, /tidak rekonsiliasi/);
    // Selisihnya harus 2x nominalnya — tanda yang terbalik, bukan nilai hilang.
    const failed = result.attempts.find((a) => a.rowOffset === 1)?.failedChecks ?? [];
    assert.ok(failed.some((c) => Math.abs(c.difference - 284000) < 0.005), `selisih tak terduga: ${JSON.stringify(failed)}`);
  });

  test("satu baris detail terlewat ditolak", () => {
    const tokens = withoutToken((t) => t.text === "17,059,300");
    const result = parseFinancialReport(tokens, { rowTolerance: fixture.rowTolerance });
    assert.equal(result.status, "rejected");
  });

  test("Neraca yang tidak seimbang DITOLAK, bukan ditampilkan apa adanya", () => {
    // Satu baris aset hilang: Total Aset Lancar tidak lagi sama dengan jumlah
    // detailnya, DAN Total Aset tidak lagi sama dengan Total Kewajiban dan
    // Modal. Neraca yang tidak seimbang tidak boleh pernah lolos.
    const tokens = withoutToken((t) => t.text === "4,250,000.00");
    const result = parseFinancialReport(tokens, { rowTolerance: fixture.rowTolerance, kind: "balance-sheet" });
    assert.equal(result.status, "rejected");
    assert.ok(result.status === "rejected");
    assert.equal(result.notFound, undefined, "ini dokumen bermasalah, bukan laporan yang tidak ada");
    assert.match(result.reason, /Neraca tidak rekonsiliasi/);
  });

  test("Arus Kas yang saldo awalnya salah baca DITOLAK", () => {
    // Identitas saldo awal + aktivitas = saldo akhir langsung meleset, walau
    // subtotal aktivitasnya sendiri masih benar — persis kelas kesalahan yang
    // tidak akan tertangkap cek subtotal saja.
    const tokens = fixture.tokens.map((token) => (token.text === "448,625,339.61" ? { ...token, text: "448,625,449.61" } : token));
    const result = parseFinancialReport(tokens, { rowTolerance: fixture.rowTolerance, kind: "cashflow" });
    assert.equal(result.status, "rejected");
    assert.ok(result.status === "rejected");
    assert.match(result.reason, /Arus Kas tidak rekonsiliasi/);
  });

  test("Arus Kas yang satu baris aktivitasnya hilang DITOLAK", () => {
    const tokens = withoutToken((t) => t.text === "4,560,000.00");
    const result = parseFinancialReport(tokens, { rowTolerance: fixture.rowTolerance, kind: "cashflow" });
    assert.equal(result.status, "rejected");
  });

  test("satu digit salah baca ditolak", () => {
    // 98,453,500.00 -> 98,453,600.00: satu digit, mustahil dilihat mata.
    const tokens = fixture.tokens.map((t) => (t.text === "98,453,500.00" ? { ...t, text: "98,453,600.00" } : t));
    const result = parseFinancialReport(tokens, { rowTolerance: fixture.rowTolerance });
    assert.equal(result.status, "rejected");
  });

  test("alasan penolakan menyebut kedua offset yang dicoba", () => {
    const tokens = withoutToken((t) => t.text === "17,059,300");
    const result = parseFinancialReport(tokens, { rowTolerance: fixture.rowTolerance });
    assert.ok(result.status === "rejected");
    assert.deepEqual(result.attempts.map((a) => a.rowOffset), [0, 1]);
  });

  test("dokumen tanpa baris Laba Bersih ditolak, tidak diterima separuh", () => {
    const tokens = fixture.tokens.filter((t) => !/^(Laba|Bersih)$/.test(t.text));
    const result = parseFinancialReport(tokens, { rowTolerance: fixture.rowTolerance });
    assert.equal(result.status, "rejected");
  });
});

describe("detectReportPeriod — periode dari kop surat", () => {
  test("format kop yang benar-benar dipakai kedua fixture", () => {
    assert.equal(detectReportPeriod(["Feb-26"]), "2026-02");
    assert.equal(detectReportPeriod(["Mei 2026"]), "2026-05");
  });

  test("variasi bulan Indonesia dan Inggris, panjang maupun singkat", () => {
    assert.equal(detectReportPeriod(["Januari 2026"]), "2026-01");
    assert.equal(detectReportPeriod(["Mar-26"]), "2026-03");
    assert.equal(detectReportPeriod(["Agt 2026"]), "2026-08");
    assert.equal(detectReportPeriod(["August 2026"]), "2026-08");
    assert.equal(detectReportPeriod(["Okt/25"]), "2025-10");
    // Ejaan lama yang masih muncul di dokumen Indonesia.
    assert.equal(detectReportPeriod(["Nop-25"]), "2025-11");
    assert.equal(detectReportPeriod(["Des 2026"]), "2026-12");
  });

  test("baris kop lain tidak pernah ditebak jadi periode", () => {
    assert.equal(detectReportPeriod(["Li I= BC PADEL CLUB", "La Laporan Laba Rugi", "Ea"]), null);
    assert.equal(detectReportPeriod(["bi - BC PADEL CLUB"]), null);
    assert.equal(detectReportPeriod([]), null);
  });

  test("tahun di luar 2000-2100 ditolak, bukan dipakai", () => {
    assert.equal(detectReportPeriod(["Jan 1999"]), null);
    assert.equal(detectReportPeriod(["Jan 2101"]), null);
  });

  test("baris pertama yang cocok yang dipakai", () => {
    assert.equal(detectReportPeriod(["BC PADEL CLUB", "Feb-26", "Mar-26"]), "2026-02");
  });
});

describe("stripLetterhead — kop dibuang, data tidak", () => {
  const line = (over: Partial<MappingLine>): MappingLine => ({ code: null, label: "", value: null, kind: "header", page: 1, assumedZero: false, ...over });

  test("baris sebelum akun pertama dibuang, kecuali judul section tepat di atasnya", () => {
    const cleaned = stripLetterhead([
      line({ label: "BC PADEL CLUB", value: 1, kind: "derived" }),
      line({ label: "Feb-26", value: 8, kind: "derived" }),
      line({ label: "Pendapatan" }),
      line({ label: "Penjualan", code: "40000", value: 100, kind: "detail" }),
      line({ label: "Total Pendapatan", value: 100, kind: "subtotal" }),
    ]);
    assert.deepEqual(cleaned.map((l) => l.label), ["Pendapatan", "Penjualan", "Total Pendapatan"]);
  });

  test("serpihan 1-2 karakter dibuang di mana pun, baris data tidak pernah", () => {
    const cleaned = stripLetterhead([
      line({ label: "Pendapatan" }),
      line({ label: "Penjualan", code: "40000", value: 100, kind: "detail" }),
      line({ label: "WO", value: 3, kind: "derived" }),
      line({ label: "Total Pendapatan", value: 100, kind: "subtotal" }),
      line({ label: "Laba Kotor", value: 100, kind: "derived" }),
    ]);
    assert.deepEqual(cleaned.map((l) => l.label), ["Pendapatan", "Penjualan", "Total Pendapatan", "Laba Kotor"]);
  });

  test("dokumen tanpa baris akun dibiarkan apa adanya, bukan dikosongkan", () => {
    const lines = [line({ label: "BC PADEL CLUB" }), line({ label: "Laporan Laba Rugi" })];
    assert.equal(stripLetterhead(lines).length, 2);
  });
});
