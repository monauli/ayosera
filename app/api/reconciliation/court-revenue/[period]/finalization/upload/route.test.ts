// Route-level test untuk POST .../finalization/upload — sebelumnya TIDAK ADA
// test khusus route ini (hanya lib/reconciliation-omzet-period-lock.test.ts
// yang menguji fungsi murninya, dan lib/reconciliation-omzet-period-lock-ui.test.ts
// yang hanya assert regex requireSupervisor()/validateOmzetPeriodLockAttachment()
// dipanggil). Pola sama seperti ../../attachment/route.test.ts: semua
// dependency (blob upload, auth, dan penulisan Mongo lewat
// uploadOmzetPeriodLockAttachment) di-mock lewat --experimental-test-module-mocks
// SEBELUM route diimpor, jadi TIDAK PERNAH menyentuh Vercel Blob atau MongoDB
// sungguhan. validateOmzetPeriodLockAttachment dan OmzetPeriodLockError TETAP
// implementasi ASLI (diimpor sebelum mock.module dipasang) supaya aturan
// validasi format/ukuran file sungguhan yang diuji, bukan tiruan.
import assert from "node:assert/strict";
import test, { before, mock } from "node:test";
import { validateOmzetPeriodLockAttachment, OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock.ts";

process.env.OLSERA_INTERNAL_STORE_ID = "1";

const uploadBlobMock = mock.fn(async (input: { storeId: number; period: string; file: File }) => ({
  url: `https://blob.vercel-storage.com/reconciliation/omzet-period-lock/${input.storeId}/${input.period}/${Date.now()}-${input.file.name}`,
}));
mock.module("@/lib/blob-storage", { namedExports: { uploadOmzetPeriodLockAttachment: uploadBlobMock } });

const lockDoc = { status: "draft" as const, version: 1, attachment: { fileName: "berita-acara.pdf", mimeType: "application/pdf", size: 3, url: "https://blob.vercel-storage.com/x", uploadedAt: new Date(), uploadedBy: "supervisor-1" } };
const uploadLockAttachmentMock = mock.fn(async () => lockDoc);
mock.module("@/lib/reconciliation-omzet-period-lock", {
  namedExports: {
    uploadOmzetPeriodLockAttachment: uploadLockAttachmentMock,
    validateOmzetPeriodLockAttachment,
    OmzetPeriodLockError,
  },
});

let supervisorRejects = false;
const requireSupervisorMock = mock.fn(async () => {
  if (supervisorRejects) {
    throw new Response(JSON.stringify({ error: "Supervisor access required" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }
  return { id: "supervisor-1", role: "supervisor" as const, allowedModules: [] as string[] };
});
mock.module("@/lib/auth", { namedExports: { requireSupervisor: requireSupervisorMock } });

let POST!: typeof import("./route.ts").POST;
before(async () => {
  ({ POST } = await import("./route.ts"));
});

function req(formData: FormData) {
  return new Request("http://localhost/api/reconciliation/court-revenue/2026-06/finalization/upload", { method: "POST", body: formData });
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
  uploadBlobMock.mock.resetCalls();
  uploadLockAttachmentMock.mock.resetCalls();
});

test("upload PDF berhasil -> 201, menyimpan attachment lewat lock lib", async () => {
  const res = await POST(req(fileFormData(new Uint8Array([1, 2, 3]), "berita-acara.pdf", "application/pdf")), ctx());
  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: typeof lockDoc };
  assert.equal(body.data.attachment?.fileName, "berita-acara.pdf");
  assert.equal(uploadBlobMock.mock.callCount(), 1);
  assert.equal(uploadLockAttachmentMock.mock.callCount(), 1);
});

test("upload JPG berhasil -> 201", async () => {
  const res = await POST(req(fileFormData(new Uint8Array([255, 216, 255]), "bukti.jpg", "image/jpeg")), ctx());
  assert.equal(res.status, 201);
  assert.equal(uploadBlobMock.mock.callCount(), 1);
});

test("upload PNG berhasil -> 201", async () => {
  const res = await POST(req(fileFormData(new Uint8Array([137, 80, 78, 71]), "bukti.png", "image/png")), ctx());
  assert.equal(res.status, 201);
  assert.equal(uploadBlobMock.mock.callCount(), 1);
});

test("format tidak didukung (.txt) -> 400, TIDAK memanggil blob/lock", async () => {
  const res = await POST(req(fileFormData(new Uint8Array([1]), "catatan.txt", "text/plain")), ctx());
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /PDF, JPG, JPEG, atau PNG/);
  assert.equal(uploadBlobMock.mock.callCount(), 0);
  assert.equal(uploadLockAttachmentMock.mock.callCount(), 0);
});

test("ukuran terlalu besar (>10MB) -> 400, pesan ukuran maksimal, TIDAK memanggil blob/lock", async () => {
  const big = new Uint8Array(10 * 1024 * 1024 + 1);
  const res = await POST(req(fileFormData(big, "besar.pdf", "application/pdf")), ctx());
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /maksimal 10MB/);
  assert.equal(uploadBlobMock.mock.callCount(), 0);
});

test("non-supervisor ditolak -> 403, TIDAK memanggil blob/lock", async () => {
  supervisorRejects = true;
  const res = await POST(req(fileFormData(new Uint8Array([1]), "b.pdf", "application/pdf")), ctx());
  assert.equal(res.status, 403);
  assert.equal(uploadBlobMock.mock.callCount(), 0);
  assert.equal(uploadLockAttachmentMock.mock.callCount(), 0);
});

test("kegagalan upload ke Blob (mis. token belum dikonfigurasi) -> 502, pesan menyebut BLOB_READ_WRITE_TOKEN, TIDAK memanggil lock lib", async () => {
  uploadBlobMock.mock.mockImplementationOnce(async () => {
    throw new Error("Vercel Blob: No token found");
  });
  const res = await POST(req(fileFormData(new Uint8Array([1]), "b.pdf", "application/pdf")), ctx());
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /BLOB_READ_WRITE_TOKEN/);
  assert.equal(uploadLockAttachmentMock.mock.callCount(), 0);
});

// Regresi untuk bug _id immutable pada upsert (lib/reconciliation-omzet-period-lock.ts):
// pastikan error MongoDB itu diterjemahkan ke pesan spesifik, bukan hanya fallback generik.
test("error Mongo immutable _id dari lock lib -> 502, pesan spesifik menyebut konflik _id", async () => {
  uploadLockAttachmentMock.mock.mockImplementationOnce(async () => {
    throw new Error("Performing an update on the path '_id' would modify the immutable field '_id'");
  });
  const res = await POST(req(fileFormData(new Uint8Array([1, 2, 3]), "berita-acara.pdf", "application/pdf")), ctx());
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /_id/);
});

test("error koneksi Mongo dari lock lib -> 502, pesan spesifik menyebut koneksi database", async () => {
  uploadLockAttachmentMock.mock.mockImplementationOnce(async () => {
    throw new Error("MongoServerSelectionError: connect ECONNREFUSED");
  });
  const res = await POST(req(fileFormData(new Uint8Array([1, 2, 3]), "berita-acara.pdf", "application/pdf")), ctx());
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /koneksi database/);
});

// Skenario 13 (unauthorized) sudah dicakup oleh test "non-supervisor ditolak" di atas.
