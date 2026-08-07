import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { collections, withMongo } from "@/lib/mongodb";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { deleteCoretaxDraft, getCoretaxDraft, updateCoretaxDraft } from "@/lib/coretax/draft-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rowSchema = z.object({
  rowId: z.string(),
  values: z.record(z.string(), z.string()),
  status: z.enum(["belum-diperiksa", "benar", "perlu-diperbaiki"]),
  errors: z.array(z.object({ field: z.string(), message: z.string() })),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  tin: z.string().trim().max(64).optional(),
  taxPeriodMonth: z.string().trim().max(2).nullable().optional(),
  taxPeriodYear: z.string().trim().max(4).nullable().optional(),
  rows: z.array(rowSchema).optional(),
});

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireModule("coretax");
    const { id } = await params;
    const draft = await withMongo(async () => {
      const { coretaxDrafts } = await collections();
      return getCoretaxDraft(coretaxDrafts, id);
    });
    if (!draft) return NextResponse.json({ error: "Draft tidak ditemukan." }, { status: 404 });
    return NextResponse.json({ draft }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Gagal memuat draft." }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireModule("coretax");
    const { id } = await params;
    const body = updateSchema.parse(await request.json());
    const draft = await withMongo(async () => {
      const { coretaxDrafts } = await collections();
      return updateCoretaxDraft(coretaxDrafts, id, body);
    });
    if (!draft) return NextResponse.json({ error: "Draft tidak ditemukan." }, { status: 404 });
    return NextResponse.json({ draft }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Data draft tidak valid." }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: "Gagal menyimpan draft." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireModule("coretax");
    const { id } = await params;
    const deleted = await withMongo(async () => {
      const { coretaxDrafts } = await collections();
      return deleteCoretaxDraft(coretaxDrafts, id);
    });
    if (!deleted) return NextResponse.json({ error: "Draft tidak ditemukan." }, { status: 404 });
    return NextResponse.json({ ok: true }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Gagal menghapus draft." }, { status: 500 });
  }
}
