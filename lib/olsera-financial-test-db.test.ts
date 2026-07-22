import test from "node:test";
import assert from "node:assert/strict";
import { validateFinancialTestDatabase } from "./olsera-financial-test-db.ts";
test("safe test database names", () => { for (const name of ["financial_test", "financial_sandbox", "financial_staging", "Financial_Test"]) assert.equal(validateFinancialTestDatabase("mongodb+srv://redacted.example/test", name, "ayo_production").ok, true); });
test("unsafe and missing test database names", () => { for (const name of [undefined, "", "   ", "ayo_production", "ayosera", "production", "prod", "main", "primary", "financial"]) assert.equal(validateFinancialTestDatabase(name ? "mongodb+srv://redacted.example/test" : undefined, name, "ayo_production").ok, false); });
test("no production environment fallback", () => assert.equal(validateFinancialTestDatabase(undefined, "financial_test", "ayo_production").ok, false));
test("real .env.local shape: ayo_middleware production, financial_test test", () => {
  const productionDb = "ayo_middleware";
  const testDb = "financial_test";
  const multiHostUri =
    "mongodb://user:pass@ac-1-shard-00-00.example.mongodb.net:27017,ac-1-shard-00-01.example.mongodb.net:27017,ac-1-shard-00-02.example.mongodb.net:27017/?ssl=true&replicaSet=atlas-abc-shard-0&authSource=admin&appName=Cluster0";
  const result = validateFinancialTestDatabase(multiHostUri, testDb, productionDb);
  assert.equal(result.ok, true);
});
function reasonCodeOf(result: ReturnType<typeof validateFinancialTestDatabase>) {
  assert.equal(result.ok, false);
  return (result as { ok: false; reasonCode: string }).reasonCode;
}
test("reason codes identify the exact rejection cause", () => {
  assert.equal(reasonCodeOf(validateFinancialTestDatabase(undefined, "financial_test", "ayo_middleware")), "missing-test-uri");
  assert.equal(reasonCodeOf(validateFinancialTestDatabase("mongodb://x", undefined, "ayo_middleware")), "missing-test-db");
  assert.equal(reasonCodeOf(validateFinancialTestDatabase("mongodb://x", "ayo_middleware", "ayo_middleware")), "same-as-production");
  assert.equal(reasonCodeOf(validateFinancialTestDatabase("mongodb://x", "production", "ayo_middleware")), "forbidden-name");
  assert.equal(reasonCodeOf(validateFinancialTestDatabase("mongodb://x", "financial", "ayo_middleware")), "missing-test-marker");
  assert.equal(reasonCodeOf(validateFinancialTestDatabase("not-a-mongo-uri", "financial_test", "ayo_middleware")), "invalid-uri");
});
