import assert from "node:assert/strict";
import test from "node:test";
import { isSafeAttachmentUrl, isTrustedBlobAttachmentUrl } from "./attachment-url-safety.ts";

test("isSafeAttachmentUrl: menerima https://, menolak skema lain (mis. javascript:) — cegah stored XSS lewat <a href>", () => {
  assert.equal(isSafeAttachmentUrl("https://blob.vercel-storage.com/ba.pdf"), true);
  assert.equal(isSafeAttachmentUrl("javascript:alert(1)"), false, "skema javascript: harus ditolak");
  assert.equal(isSafeAttachmentUrl("http://blob.vercel-storage.com/ba.pdf"), false, "http:// (non-secure) ditolak — Vercel Blob selalu https");
  assert.equal(isSafeAttachmentUrl("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isSafeAttachmentUrl(""), false);
  assert.equal(isSafeAttachmentUrl(null), false);
  assert.equal(isSafeAttachmentUrl(undefined), false);
});

test("isTrustedBlobAttachmentUrl: menerima https://*.public.blob.vercel-storage.com (sama dengan allowlist CSP), menolak host lain walau https", () => {
  assert.equal(isTrustedBlobAttachmentUrl("https://abc123.public.blob.vercel-storage.com/reconciliation/omzet-period-lock/1/2026-05/x-ba.pdf"), true);
  assert.equal(isTrustedBlobAttachmentUrl("https://public.blob.vercel-storage.com/x"), true, "host tanpa subdomain (exact match) tetap diterima");
});

test("isTrustedBlobAttachmentUrl: menolak SSRF ke alamat internal walau https", () => {
  assert.equal(isTrustedBlobAttachmentUrl("https://127.0.0.1/admin"), false, "loopback harus ditolak");
  assert.equal(isTrustedBlobAttachmentUrl("https://169.254.169.254/latest/meta-data/"), false, "cloud metadata endpoint harus ditolak");
  assert.equal(isTrustedBlobAttachmentUrl("https://internal.svc.local/secret"), false);
  assert.equal(isTrustedBlobAttachmentUrl("http://abc123.public.blob.vercel-storage.com/x"), false, "http:// (non-https) ditolak walau host cocok");
});

test("isTrustedBlobAttachmentUrl: menolak host mirip (typosquat/subdomain trick) — endsWith harus dot-boundary, bukan substring", () => {
  assert.equal(isTrustedBlobAttachmentUrl("https://evilpublic.blob.vercel-storage.com/x"), false, "tanpa titik pemisah sebelum 'public' harus ditolak");
  assert.equal(isTrustedBlobAttachmentUrl("https://abc.public.blob.vercel-storage.com.attacker.io/x"), false, "domain pelaku yang menempel di belakang harus ditolak");
});

test("isTrustedBlobAttachmentUrl: menolak input tidak valid tanpa melempar", () => {
  assert.equal(isTrustedBlobAttachmentUrl("javascript:alert(1)"), false);
  assert.equal(isTrustedBlobAttachmentUrl("not a url"), false);
  assert.equal(isTrustedBlobAttachmentUrl(""), false);
  assert.equal(isTrustedBlobAttachmentUrl(null), false);
  assert.equal(isTrustedBlobAttachmentUrl(undefined), false);
});
