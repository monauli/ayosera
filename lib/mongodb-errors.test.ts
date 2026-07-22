import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoServerSelectionError, MongoNetworkError, MongoServerError, MongoNetworkTimeoutError } from "mongodb";
import { isDatabaseTimeoutError } from "./mongodb-errors.ts";

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
