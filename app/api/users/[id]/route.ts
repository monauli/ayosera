import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { APP_MODULES, auth, requireSupervisor } from "@/lib/auth";
import { getDb } from "@/lib/mongodb";
import { toPublicUser, type UserDoc } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  allowedModules: z.array(z.enum(APP_MODULES)).optional(),
  password: z.string().min(8, "Password minimal 8 karakter").optional(),
  disabled: z.boolean().optional(),
});

function parseObjectId(id: string) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

// userId di koleksi account/session bisa tersimpan sebagai ObjectId maupun string
// tergantung versi adapter — cocokkan keduanya.
function userIdFilter(oid: ObjectId) {
  return { $or: [{ userId: oid }, { userId: oid.toHexString() }] } as Record<string, unknown>;
}

async function revokeSessions(oid: ObjectId) {
  const db = await getDb();
  await db.collection("session").deleteMany(userIdFilter(oid));
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supervisor = await requireSupervisor();
    const { id } = await params;
    const oid = parseObjectId(id);
    if (!oid) return NextResponse.json({ error: "ID pengguna tidak valid." }, { status: 400 });

    const body = updateSchema.parse(await request.json());
    const db = await getDb();
    const users = db.collection<UserDoc>("user");
    const target = await users.findOne({ _id: oid });
    if (!target) return NextResponse.json({ error: "Pengguna tidak ditemukan." }, { status: 404 });

    const isSelf = id === supervisor.id;
    const targetIsSupervisor = target.role === "admin" || target.role === "supervisor";

    if (body.disabled === true && (isSelf || targetIsSupervisor)) {
      return NextResponse.json(
        { error: "Akun supervisor (termasuk akun Anda sendiri) tidak dapat dinonaktifkan." },
        { status: 400 },
      );
    }

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (body.allowedModules !== undefined) {
      if (targetIsSupervisor) {
        return NextResponse.json({ error: "Modul supervisor tidak dapat dibatasi." }, { status: 400 });
      }
      set.allowedModules = body.allowedModules;
    }
    if (body.disabled !== undefined) set.disabled = body.disabled;

    await users.updateOne({ _id: oid }, { $set: set });

    if (body.password) {
      const ctx = await auth.$context;
      const hash = await ctx.password.hash(body.password);
      await ctx.internalAdapter.updatePassword(id, hash);
    }

    // Perubahan izin/nonaktif/reset password berlaku seketika: cabut sesi aktifnya.
    if (!isSelf && (body.disabled === true || body.password || body.allowedModules !== undefined)) {
      await revokeSessions(oid);
    }

    const updated = await users.findOne({ _id: oid });
    return NextResponse.json({ user: updated ? toPublicUser(updated) : null });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message || "Payload tidak valid." }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: "Gagal memperbarui pengguna." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supervisor = await requireSupervisor();
    const { id } = await params;
    const oid = parseObjectId(id);
    if (!oid) return NextResponse.json({ error: "ID pengguna tidak valid." }, { status: 400 });

    if (id === supervisor.id) {
      return NextResponse.json({ error: "Anda tidak dapat menghapus akun sendiri." }, { status: 400 });
    }

    const db = await getDb();
    const users = db.collection<UserDoc>("user");
    const target = await users.findOne({ _id: oid });
    if (!target) return NextResponse.json({ error: "Pengguna tidak ditemukan." }, { status: 404 });
    if (target.role === "admin" || target.role === "supervisor") {
      return NextResponse.json({ error: "Akun supervisor tidak dapat dihapus dari sini." }, { status: 400 });
    }

    await users.deleteOne({ _id: oid });
    await db.collection("account").deleteMany(userIdFilter(oid));
    await revokeSessions(oid);

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Gagal menghapus pengguna." }, { status: 500 });
  }
}
