import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoServerSelectionError, MongoNetworkError, MongoServerError, MongoNetworkTimeoutError } from "mongodb";
import { isDatabaseTimeoutError, withDatabaseRetry } from "./mongodb-errors.ts";

test("isDatabaseTimeoutError: MongoServerSelectionError dikenali (mis. Atlas tidak terjangkau)", () => {
  const error = new MongoServerSelectionError("Server selection timed out after 5000 ms", {} as never);
  assert.equal(isDatabaseTimeoutError(error), true);
});

test("isDatabaseTimeoutError: MongoNetworkError dikenali (mis. ECONNREFUSED)", () => {
  const error = new MongoNetworkError("connect ECONNREFUSED 127.0.0.1:27017");
  assert.equal(isDatabaseTimeoutError(error), true);
});

test("isDatabaseTimeoutError: MongoNetworkTimeoutError (subclass MongoNetworkError) dikenali", () => {
  const error = new MongoNetworkTimeoutError("connection timed out");
  assert.equal(isDatabaseTimeoutError(error), true);
});

test("isDatabaseTimeoutError: MongoServerError dikenali (mis. MaxTimeMSExpired dari query)", () => {
  const error = new MongoServerError({ message: "operation exceeded time limit", code: 50 });
  assert.equal(isDatabaseTimeoutError(error), true);
});

test("isDatabaseTimeoutError: pesan Error generik mengandung 'timed out'", () => {
  const error = new Error("Server selection timed out after 5000 ms");
  assert.equal(isDatabaseTimeoutError(error), true);
});

test("isDatabaseTimeoutError: pesan Error generik mengandung 'timeout' (timeout aplikasi lokal)", () => {
  const error = new Error("snapshot accounts timeout");
  assert.equal(isDatabaseTimeoutError(error), true);
});

test("isDatabaseTimeoutError: error tidak terkait timeout -> false", () => {
  const error = new Error("Nomor akun tidak valid");
  assert.equal(isDatabaseTimeoutError(error), false);
});

test("isDatabaseTimeoutError: nilai bukan Error (mis. Response 401) -> false", () => {
  assert.equal(isDatabaseTimeoutError(new Response(null, { status: 401 })), false);
  assert.equal(isDatabaseTimeoutError(undefined), false);
  assert.equal(isDatabaseTimeoutError("some string"), false);
});

test("withDatabaseRetry: sukses di percobaan pertama -> tidak retry sama sekali", async () => {
  let calls = 0;
  const result = await withDatabaseRetry(async () => {
    calls += 1;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withDatabaseRetry: gagal karena timeout DB lalu sukses -> retry SEKALI dan berhasil", async () => {
  let calls = 0;
  const result = await withDatabaseRetry(async () => {
    calls += 1;
    if (calls === 1) throw new MongoNetworkError("connect ECONNREFUSED");
    return "ok-after-retry";
  });
  assert.equal(result, "ok-after-retry");
  assert.equal(calls, 2);
});

test("withDatabaseRetry: gagal timeout DB dua kali berturut-turut -> tetap dilempar (jadi 504 di route), maksimal 2 percobaan", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withDatabaseRetry(async () => {
        calls += 1;
        throw new MongoServerSelectionError("Server selection timed out after 5000 ms", {} as never);
      }),
    MongoServerSelectionError,
  );
  assert.equal(calls, 2);
});

test("withDatabaseRetry: error BUKAN timeout DB (mis. validasi) -> langsung dilempar, TIDAK retry", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withDatabaseRetry(async () => {
        calls += 1;
        throw new Error("Nomor akun tidak valid");
      }),
    /Nomor akun tidak valid/,
  );
  assert.equal(calls, 1);
});

test("withDatabaseRetry: thrown Response (auth 401/403) -> langsung dilempar, TIDAK retry", async () => {
  let calls = 0;
  const authResponse = new Response(null, { status: 401 });
  await assert.rejects(
    () =>
      withDatabaseRetry(async () => {
        calls += 1;
        throw authResponse;
      }),
  );
  assert.equal(calls, 1);
});
