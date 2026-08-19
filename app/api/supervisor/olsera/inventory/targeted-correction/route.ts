import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { runTargetedInventoryCorrection } from "@/lib/targeted-inventory-correction";

export async function POST(request: Request) {
  try {
    const user = await requireSupervisor();
    const body = await request.json() as { dryRun?: unknown; confirm?: unknown };
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") return NextResponse.json({ error: "dryRun tidak valid" }, { status: 400 });
    const dryRun = body.dryRun !== false;
    const result = await runTargetedInventoryCorrection({ dryRun, confirm: body.confirm === "USER_CONFIRMED_2026_08_19", actor: user.id });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Correction gagal." }, { status: 500 });
  }
}
