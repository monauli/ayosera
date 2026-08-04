// Beda dari ../explanation/route.test.ts & ../lock/route.test.ts (source-
// inspection) — di sini SEMUA dependency route (requireSupervisor DAN upload
// Blob) di-mock lewat node:test --experimental-test-module-mocks SEBELUM
// route diimpor, jadi handler POST bisa dipanggil LANGSUNG dengan
// Request/FormData asli dan responsnya diperiksa penuh — TIDAK PERNAH
// menyentuh jaringan/Vercel Blob sungguhan.
//
// Di-mock lewat lib/blob-storage.ts (wrapper project sendiri), BUKAN
// @vercel/blob langsung: dicoba lebih dulu mock.module("@vercel/blob", ...)
// tapi mock TIDAK terpasang untuk import transitif route.ts -> @vercel/blob
// (diverifikasi: mock berfungsi untuk import LANGSUNG dari file test, tapi
// tidak untuk import tidak langsung lewat route yang di-dynamic-import —
// kemungkinan interop ESM/CJS esbuild khusus paket node_modules pihak
// ketiga). Mock lewat @/lib/auth (path project) TERBUKTI bekerja transitif
// lewat route.ts yang sama, jadi lib/blob-storage.ts dibuat sebagai wrapper
// project (pola sama lib/olsera-financial-client.ts untuk API eksternal
// lain) supaya bisa di-mock dengan cara yang sama.
import assert from "node:assert/strict";
import test, { before, mock } from "node:test";

process.env.OLSERA_INTERNAL_STORE_ID = "1";

const uploadOmzetAttachmentMock = mock.fn(async (input: { storeId: number; period: string; file: File }) => ({
  url: `https://blob.vercel-storage.com/reconciliation/omzet-explanation/${input.storeId}/${input.period}/${Date.now()}-${input.file.name}`,
}));
mock.module("@/lib/blob-storage", { namedExports: { uploadOmzetAttachment: uploadOmzetAttachmentMock } });

let supervisorRejects = false;
const requireSupervisorMock = mock.fn(async () => {
  if (supervisorRejects) {
    throw new Response(JSON.stringify({ error: "Supervisor access required" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }
  return { id: "supervisor-1", role: "supervisor" as const, allowedModules: [] as string[] };
});
mock.module("@/lib/auth", { namedExports: { requireSupervisor: requireSupervisorMock } });

// TIDAK pakai top-level await untuk dynamic import (esbuild/tsx memaksa
// output "cjs" untuk entry file yang di-mock lewat --experimental-test-
// module-mocks, dan top-level await TIDAK didukung di format itu — beda
// dari file lain di repo yang "await import" hanya di DALAM callback
// test(), bukan benar-benar top-level). Assign lewat before() sebagai
// gantinya, dijamin node:test selesai duluan sebelum test() manapun jalan.
let POST!: typeof import("./route.ts").POST;
let MAX_ATTACHMENT_BYTES!: number;
before(async () => {
  ({ POST } = await import("./route.ts"));
  ({ MAX_ATTACHMENT_BYTES } = await import("../_shared.ts"));
});

function req(formData: FormData) {
  return new Request("http://localhost/api/reconciliation/court-revenue/2026-06/attachment", { method: "POST", body: formData });
}
function ctx(period = "2026-06") {
  return { params: Promise.resolve({ period }) };
}
function fileFormData(bytes: Uint8Array, name: string, type: string) {
  const fd = new FormData();
  fd.set("file", new File([bytes as BlobPart], name, { type }));
  return fd;
}

test.beforeEach(() => {
  supervisorRejects = false;
  uploadOmzetAttachmentMock.mock.resetCalls();
});

test("upload PDF berhasil -> 201, attachmentUrl+attachmentFileName, TIDAK menulis DB (endpoint tidak impor note-store)", async () => {
  const res = await POST(req(fileFormData(new Uint8Array([1, 2, 3]), "berita-acara.pdf", "application/pdf")), ctx());
  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: { attachmentUrl: string; attachmentFileName: string } };
  assert.equal(body.data.attachmentFileName, "berita-acara.pdf");
  assert.match(body.data.attachmentUrl, /^https:\/\/blob\.vercel-storage\.com\//);
  assert.equal(uploadOmzetAttachmentMock.mock.callCount(), 1);
  const [input] = uploadOmzetAttachmentMock.mock.calls[0].arguments;
  assert.equal(input.storeId, 1);
  assert.equal(input.period, "2026-06");
  assert.equal(input.file.name, "berita-acara.pdf");
});

test("upload gambar (png) berhasil -> 201", async () => {
  const res = await POST(req(fileFormData(new Uint8Array([137, 80, 78, 71]), "bukti.png", "image/png")), ctx());
  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: { attachmentFileName: string } };
  assert.equal(body.data.attachmentFileName, "bukti.png");
  assert.equal(uploadOmzetAttachmentMock.mock.callCount(), 1);
});

test("upload gambar (jpg) berhasil -> 201", async () => {
  const res = await POST(req(fileFormData(new Uint8Array([255, 216, 255]), "bukti.jpg", "image/jpeg")), ctx());
  assert.equal(res.status, 201);
  assert.equal(uploadOmzetAttachmentMock.mock.callCount(), 1);
});

test("tipe file ditolak (.txt) -> 400, TIDAK memanggil upload", async () => {
  const res = await POST(req(fileFormData(new Uint8Array([1]), "catatan.txt", "text/plain")), ctx());
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Tipe file tidak didukung/);
  assert.equal(uploadOmzetAttachmentMock.mock.callCount(), 0);
});

test("ekstensi tidak cocok dengan content-type (mis. .pdf tapi diklaim image/png) -> 400, TIDAK memanggil upload", async () => {
  const res = await POST(req(fileFormData(new Uint8Array([1]), "menyamar.pdf", "image/png")), ctx());
  assert.equal(res.status, 400);
  assert.equal(uploadOmzetAttachmentMock.mock.callCount(), 0);
});

test("ukuran terlalu besar -> 413, TIDAK memanggil upload", async () => {
  const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  const res = await POST(req(fileFormData(big, "besar.pdf", "application/pdf")), ctx());
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /terlalu besar/);
  assert.equal(uploadOmzetAttachmentMock.mock.callCount(), 0);
});

test("file kosong -> 400, TIDAK memanggil upload", async () => {
  const res = await POST(req(fileFormData(new Uint8Array([]), "kosong.pdf", "application/pdf")), ctx());
  assert.equal(res.status, 400);
  assert.equal(uploadOmzetAttachmentMock.mock.callCount(), 0);
});

test("field 'file' tidak ada -> 400, TIDAK memanggil upload", async () => {
  const res = await POST(req(new FormData()), ctx());
  assert.equal(res.status, 400);
  assert.equal(uploadOmzetAttachmentMock.mock.callCount(), 0);
});

test("periode format salah -> 400, TIDAK memanggil requireSupervisor gagal / put", async () => {
  const res = await POST(req(fileFormData(new Uint8Array([1]), "b.pdf", "application/pdf")), ctx("2026/06"));
  assert.equal(res.status, 400);
  assert.equal(uploadOmzetAttachmentMock.mock.callCount(), 0);
});

test("non-supervisor ditolak -> 403, TIDAK memanggil upload", async () => {
  supervisorRejects = true;
  const res = await POST(req(fileFormData(new Uint8Array([1]), "b.pdf", "application/pdf")), ctx());
  assert.equal(res.status, 403);
  assert.equal(uploadOmzetAttachmentMock.mock.callCount(), 0);
});

test("kegagalan upload ke Blob (mis. token belum dikonfigurasi) -> 502, pesan menyebut BLOB_READ_WRITE_TOKEN", async () => {
  uploadOmzetAttachmentMock.mock.mockImplementationOnce(async () => {
    throw new Error("Vercel Blob: No token found");
  });
  const res = await POST(req(fileFormData(new Uint8Array([1]), "b.pdf", "application/pdf")), ctx());
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /BLOB_READ_WRITE_TOKEN/);
});
