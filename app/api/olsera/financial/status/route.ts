import { getFinancialStatus } from "@/lib/olsera-financial-client";
import { guard, json } from "../_shared";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET() { await guard(); return json(await getFinancialStatus()); }
