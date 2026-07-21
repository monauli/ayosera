import test from "node:test";
import assert from "node:assert/strict";
import { validateFinancialTestDatabase } from "./olsera-financial-test-db.ts";
test("safe test database names", () => { for (const name of ["financial_test", "financial_sandbox", "financial_staging", "Financial_Test"]) assert.equal(validateFinancialTestDatabase("mongodb+srv://redacted.example/test", name, "ayo_production").ok, true); });
test("unsafe and missing test database names", () => { for (const name of [undefined, "", "   ", "ayo_production", "ayosera", "production", "prod", "main", "primary", "financial"]) assert.equal(validateFinancialTestDatabase(name ? "mongodb+srv://redacted.example/test" : undefined, name, "ayo_production").ok, false); });
test("no production environment fallback", () => assert.equal(validateFinancialTestDatabase(undefined, "financial_test", "ayo_production").ok, false));
