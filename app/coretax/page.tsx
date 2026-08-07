"use client";

import { useEffect, useState } from "react";
import { CoretaxCards, type CoretaxCardStats } from "@/components/coretax/coretax-cards";
import { CORETAX_MODULE_LIST } from "@/lib/coretax/modules";

type User = { id: string; role: "supervisor" | "user"; allowedModules: string[] };
type DraftListItem = { updatedAt: string };

export default function CoretaxHomePage() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [stats, setStats] = useState<Record<string, CoretaxCardStats>>({});

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setUser(data?.user ?? null))
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      CORETAX_MODULE_LIST.map(async (module) => {
        const response = await fetch(`/api/coretax/drafts?moduleId=${module.id}`, { cache: "no-store" });
        if (!response.ok) return [module.id, { draftCount: 0, lastSavedAt: null }] as const;
        const data = (await response.json().catch(() => null)) as { drafts?: DraftListItem[] } | null;
        const drafts = data?.drafts ?? [];
        return [module.id, { draftCount: drafts.length, lastSavedAt: drafts[0]?.updatedAt ?? null }] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setStats(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const supervisor = user?.role === "supervisor";
  if (user === null) {
    if (typeof window !== "undefined") window.location.assign("/login");
    return null;
  }
  if (user && !user.allowedModules.includes("coretax") && !supervisor) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-sm text-slate-400">Akses ditolak. Hubungi supervisor untuk meminta modul Coretax.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <a href="/" className="text-sm text-slate-400 hover:text-slate-200">
          ← Kembali ke Dashboard
        </a>
        <h1 className="mt-2 text-xl font-semibold text-slate-100">Coretax</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">
          Siapkan data bukti potong dari Excel, periksa kesalahan otomatis, lalu unduh XML untuk diunggah manual ke Coretax. Tidak ada login atau submit otomatis ke Coretax dari sini.
        </p>
      </div>
      <CoretaxCards stats={stats} />
    </main>
  );
}
