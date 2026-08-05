import assert from "node:assert/strict";
import test from "node:test";
import { classifyTokenHealth, isPrivateToolsUser, privateToolsAllowlist } from "./private-integration-monitor.ts";

const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.x`;
test("private tools fail closed and allow only listed user ids", () => { assert.equal(isPrivateToolsUser({ id: "a" } as never, privateToolsAllowlist("")), false); assert.equal(isPrivateToolsUser({ id: "a" } as never, privateToolsAllowlist("a,b")), true); assert.equal(isPrivateToolsUser({ id: "c" } as never, privateToolsAllowlist("a,b")), false); });
test("token health classifies active, near expiry, expired, unauthorized, and does not return token", () => { const now = new Date("2026-08-06T00:00:00Z"); const base = now.getTime() / 1000; assert.equal(classifyTokenHealth("ayo-mobile", jwt(base + 10 * 86400), now).status, "AKTIF"); assert.equal(classifyTokenHealth("ayo-mobile", jwt(base + 2 * 86400), now).status, "AKAN_KEDALUWARSA"); assert.equal(classifyTokenHealth("ayo-mobile", jwt(1), now).status, "KEDALUWARSA"); const unauthorized = classifyTokenHealth("olsera-bearer", "secret-value", now, null, "401 Unauthorized"); assert.equal(unauthorized.status, "UNAUTHORIZED"); assert.equal(JSON.stringify(unauthorized).includes("secret-value"), false); });
