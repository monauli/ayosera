import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { collections, withMongo } from "@/lib/mongodb";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { createCoretaxDraft, listCoretaxDrafts } from "@/lib/coretax/draft-store";
import { isCoretaxModuleId } from "@/lib/coretax/modules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  moduleId: z.enum(["bpu", "bpmp", "bp21", "bpa1"]),
  name: z.string().trim().min(1).max(200),
});

export async function GET(request: Request) {
  try {
    await requireModule("coretax");
    const { searchParams } = new URL(request.url);
    const moduleId = searchParams.get("moduleId");
    if (!moduleId || !isCoretaxModuleId(moduleId)) {
      return NextResponse.json({ error: "Parameter moduleId tidak valid." }, { status: 400 });
    }
    const drafts = await withMongo(async () => {
      const { coretaxDrafts } = await collections();
      return listCoretaxDrafts(coretaxDrafts, moduleId);
    });
    return NextResponse.json({ drafts }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Gagal memuat daftar draft." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireModule("coretax");
    const body = createSchema.parse(await request.json());
    const draft = await withMongo(async () => {
      const { coretaxDrafts } = await collections();
      return createCoretaxDraft(coretaxDrafts, { moduleId: body.moduleId, name: body.name, createdBy: user.email });
    });
    return NextResponse.json({ draft }, { status: 201, headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Data draft tidak valid." }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: "Gagal membuat draft." }, { status: 500 });
  }
}
