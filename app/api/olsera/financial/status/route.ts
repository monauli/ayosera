import { getFinancialStatus } from "@/lib/olsera-financial-client";
import { guard, json, errorJson } from "../_shared";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET() { try { await guard(); return json(await getFinancialStatus()); } catch (error) { return errorJson(error); } }
