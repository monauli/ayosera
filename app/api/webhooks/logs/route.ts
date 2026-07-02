import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { collections, withMongo } from "@/lib/mongodb";

export async function GET() {
  try {
    await requireUser();

    const data = await withMongo(async () => {
      const { webhookLogs } = await collections();
      const [logs, total] = await Promise.all([
        webhookLogs.find({}).sort({ receivedAt: -1 }).limit(20).toArray(),
        webhookLogs.countDocuments({}),
      ]);

      return {
        total,
        lastReceivedAt: logs[0]?.receivedAt?.toISOString() ?? null,
        logs: logs.map((log) => ({
          receivedAt: log.receivedAt?.toISOString() ?? "",
          method: log.method,
          status: log.status,
          ok: log.ok,
          itemCount: log.itemCount,
          ids: log.ids ?? {},
          message: log.message ?? "",
          bodyPreview: log.bodyPreview ?? "",
        })),
      };
    });

    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Unable to load webhook logs" }, { status: 500 });
  }
}
