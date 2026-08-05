"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, UserCog, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PrivateIntegrationMonitor } from "@/components/private-integration-monitor";

const MODULE_OPTIONS = [
  { value: "dasbor", label: "Dasbor" },
  { value: "transaksi", label: "Transaksi" },
  { value: "olsera", label: "Olsera" },
  { value: "webhook", label: "Webhook" },
] as const;

type ManagedUser = {
  id: string;
  email: string;
  name: string;
  username: string | null;
  role: "supervisor" | "user";
  allowedModules: string[];
  disabled: boolean;
  createdAt: string | null;
};

type OlseraDaySyncPayload = {
  action?: "match" | "resynced" | "failed";
  expectedOrderCount?: number;
  processedOrderCount?: number;
  error?: string;
  errorMessage?: string | null;
};

const MAX_GAP_RANGE_DAYS = 31;

function jakartaDateValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function datesInRange(start: string, end: string) {
  const first = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return [];

  const dates: string[] = [];
  for (const cursor = new Date(first); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

function moduleLabels(modules: string[]) {
  return MODULE_OPTIONS.filter((option) => modules.includes(option.value)).map((option) => option.label);
}

export function UsersPanel({ currentUserId, isSupervisor }: { currentUserId: string; isSupervisor: boolean }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // Form tambah user
  const [formOpen, setFormOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newModules, setNewModules] = useState<string[]>(["transaksi"]);
  const [saving, setSaving] = useState(false);

  // Panel edit per user
  const [editId, setEditId] = useState<string | null>(null);
  const [editModules, setEditModules] = useState<string[]>([]);
  const [editUsername, setEditUsername] = useState("");

  // Reset password (acak) — hasil ditampilkan SEKALI di sini, tidak pernah disimpan di state lain.
  const [resetBusyId, setResetBusyId] = useState<string | null>(null);
  const [revealedPassword, setRevealedPassword] = useState<{ email: string; password: string } | null>(null);

  const [gapFrom, setGapFrom] = useState("");
  const [gapTo, setGapTo] = useState("");
  const [gapBusy, setGapBusy] = useState(false);
  const [gapProgress, setGapProgress] = useState("");
  const [gapMessage, setGapMessage] = useState("");
  const [gapError, setGapError] = useState("");

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/users?_t=${Date.now()}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as { users?: ManagedUser[]; error?: string } | null;
      if (!response.ok || !payload?.users) {
        setError(payload?.error || "Gagal memuat daftar pengguna.");
        return;
      }
      setUsers(payload.users);
    } catch {
      setError("Tidak dapat terhubung ke server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers().catch(() => undefined);
  }, [loadUsers]);

  useEffect(() => {
    const today = jakartaDateValue();
    setGapFrom(`${today.slice(0, 7)}-01`);
    setGapTo(today);
  }, []);

  function toggleModule(list: string[], value: string) {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  async function handleCreate() {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: newEmail.trim(),
          name: newName.trim() || undefined,
          username: newUsername.trim() || undefined,
          password: newPassword,
          allowedModules: newModules,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(payload?.error || "Gagal membuat pengguna.");
        return;
      }
      setMessage(`Pengguna ${newEmail.trim()} berhasil dibuat.`);
      setNewEmail("");
      setNewName("");
      setNewUsername("");
      setNewPassword("");
      setNewModules(["transaksi"]);
      setFormOpen(false);
      await loadUsers();
    } catch {
      setError("Tidak dapat terhubung ke server.");
    } finally {
      setSaving(false);
    }
  }

  async function patchUser(id: string, body: Record<string, unknown>, successMessage: string) {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(payload?.error || "Gagal memperbarui pengguna.");
        return false;
      }
      setMessage(successMessage);
      await loadUsers();
      return true;
    } catch {
      setError("Tidak dapat terhubung ke server.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(user: ManagedUser) {
    if (!window.confirm(`Hapus pengguna ${user.email}? Tindakan ini tidak dapat dibatalkan.`)) return;
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`/api/users/${user.id}`, { method: "DELETE" });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(payload?.error || "Gagal menghapus pengguna.");
        return;
      }
      setMessage(`Pengguna ${user.email} dihapus.`);
      if (editId === user.id) setEditId(null);
      await loadUsers();
    } catch {
      setError("Tidak dapat terhubung ke server.");
    } finally {
      setSaving(false);
    }
  }

  function openEdit(user: ManagedUser) {
    setEditId(user.id);
    setEditModules(user.allowedModules);
    setEditUsername(user.username ?? "");
  }

  async function handleResetPassword(user: ManagedUser) {
    if (!window.confirm(`Reset password untuk ${user.email}? Password lama akan diganti dan sesi aktif pengguna ini akan dicabut.`)) return;
    setResetBusyId(user.id);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`/api/users/${user.id}/reset-password`, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as { password?: string; error?: string } | null;
      if (!response.ok || !payload?.password) {
        setError(payload?.error || "Gagal mereset password.");
        return;
      }
      setRevealedPassword({ email: user.email, password: payload.password });
    } catch {
      setError("Tidak dapat terhubung ke server.");
    } finally {
      setResetBusyId(null);
    }
  }

  async function checkAndCloseDataGaps() {
    setGapMessage("");
    setGapError("");
    setGapProgress("");

    const today = jakartaDateValue();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(gapFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(gapTo)) {
      setGapError("Tanggal dari dan sampai wajib diisi.");
      return;
    }
    if (gapFrom > gapTo) {
      setGapError("Tanggal mulai tidak boleh melewati tanggal akhir.");
      return;
    }
    if (gapTo > today) {
      setGapError(`Tanggal akhir tidak boleh melewati hari ini (${today}).`);
      return;
    }

    const dates = datesInRange(gapFrom, gapTo);
    if (dates.length === 0) {
      setGapError("Rentang tanggal tidak valid.");
      return;
    }
    if (dates.length > MAX_GAP_RANGE_DAYS) {
      setGapError(`Rentang maksimal ${MAX_GAP_RANGE_DAYS} hari agar proses tetap aman.`);
      return;
    }

    setGapBusy(true);
    let checked = 0;
    let closedGaps = 0;
    let addedOrders = 0;
    let failed = 0;

    try {
      for (let index = 0; index < dates.length; index += 1) {
        const date = dates[index];
        setGapProgress(`Memeriksa ${date}... (${index + 1}/${dates.length})`);
        try {
          const response = await fetch("/api/olsera/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date }),
          });
          const payload = (await response.json().catch(() => null)) as OlseraDaySyncPayload | null;
          checked += 1;
          if (!response.ok || !payload || payload.action === "failed" || !payload.action) {
            failed += 1;
            continue;
          }
          if (payload.action === "resynced") {
            closedGaps += 1;
            addedOrders += Math.max(0, (payload.processedOrderCount ?? 0) - (payload.expectedOrderCount ?? 0));
          }
        } catch {
          checked += 1;
          failed += 1;
        }
      }

      setGapProgress("");
      setGapMessage(`${checked} hari diperiksa, ${closedGaps} hari ada gap dan sudah ditutup, ${addedOrders} order ditambahkan${failed ? `, ${failed} hari gagal diperiksa.` : "."}`);
    } finally {
      setGapBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {(message || error) && (
        <p role={error ? "alert" : "status"} aria-live="polite" className={`rounded-lg px-3 py-2 text-sm ${error ? "rd-alert-danger" : "rd-alert-success"}`}>{error || message}</p>
      )}

      {revealedPassword && (
        <div className="rd-card rd-enter rounded-2xl border border-amber-400/30 bg-amber-950/20 p-4">
          <p className="text-sm font-medium text-amber-200">Password baru untuk {revealedPassword.email}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-slate-100">
              {revealedPassword.password}
            </code>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigator.clipboard.writeText(revealedPassword.password)}
            >
              Salin
            </Button>
            <Button type="button" variant="outline" onClick={() => setRevealedPassword(null)}>
              Tutup
            </Button>
          </div>
          <p className="mt-2 text-xs text-amber-300">
            Salin sekarang — password ini tidak akan ditampilkan lagi setelah ditutup.
          </p>
        </div>
      )}

      <div className="rd-card rd-enter relative rounded-2xl p-5">
        <div className="border-b border-white/10 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-slate-50">Manajemen Pengguna</h1>
              <p className="mt-1 text-sm text-slate-400">Kelola akun, modul yang diizinkan, dan status akses.</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={() => loadUsers()} disabled={loading} aria-label="Muat ulang">
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              </Button>
              <Button onClick={() => setFormOpen((open) => !open)}>
                {formOpen ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                {formOpen ? "Tutup Form" : "Tambah Pengguna"}
              </Button>
            </div>
          </div>
        </div>
        <div className="pt-4">
          {isSupervisor && (
            <section className="mb-6 rounded-xl border border-indigo-300/20 bg-indigo-950/20 p-4">
              <div>
                <h2 className="text-base font-semibold text-slate-100">Cek &amp; Tutup Gap Data</h2>
                <p className="mt-1 text-sm text-slate-400">Periksa ulang data penjualan Olsera untuk rentang tanggal tertentu.</p>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <label className="text-xs text-slate-400">
                  Dari
                  <Input type="date" value={gapFrom} onChange={(event) => setGapFrom(event.target.value)} disabled={gapBusy} className="mt-1" />
                </label>
                <label className="text-xs text-slate-400">
                  Sampai
                  <Input type="date" value={gapTo} onChange={(event) => setGapTo(event.target.value)} disabled={gapBusy} className="mt-1" />
                </label>
                <Button type="button" onClick={() => void checkAndCloseDataGaps()} disabled={gapBusy || !gapFrom || !gapTo}>
                  {gapBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {gapBusy ? "Memeriksa..." : "Cek & Tutup Gap Data"}
                </Button>
              </div>
              {(gapProgress || gapMessage || gapError) && (
                <p role={gapError ? "alert" : "status"} aria-live="polite" className={`mt-3 rounded-lg px-3 py-2 text-sm ${gapError ? "rd-alert-danger" : "rd-alert-success"}`}>
                  {gapError || gapProgress || gapMessage}
                </p>
              )}
            </section>
          )}
          <PrivateIntegrationMonitor />

          {formOpen && (
            <div className="mb-6 rounded-xl border border-white/10 bg-white/[0.04] p-4">
              <p className="mb-3 text-sm font-medium text-slate-200">Pengguna Baru (role: user)</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Input
                  type="email"
                  placeholder="Email"
                  aria-label="Email pengguna baru"
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                />
                <Input
                  placeholder="Nama (opsional)"
                  aria-label="Nama pengguna baru"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                />
                <Input
                  placeholder="Username (opsional, auto dari email)"
                  aria-label="Username pengguna baru"
                  value={newUsername}
                  onChange={(event) => setNewUsername(event.target.value)}
                />
                <Input
                  type="password"
                  placeholder="Password awal (min. 8 karakter)"
                  aria-label="Password awal"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-4">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Modul diizinkan:</span>
                {MODULE_OPTIONS.map((option) => (
                    <label key={option.value} className="flex items-center gap-1.5 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={newModules.includes(option.value)}
                      onChange={() => setNewModules((list) => toggleModule(list, option.value))}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
              <Button
                className="mt-4"
                onClick={handleCreate}
                disabled={saving || !newEmail.trim() || newPassword.length < 8}
              >
                <Plus className="h-4 w-4" />
                {saving ? "Menyimpan" : "Buat Pengguna"}
              </Button>
              {newPassword.length > 0 && newPassword.length < 8 && (
                <p className="mt-2 text-xs text-red-600">Password minimal 8 karakter.</p>
              )}
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="rd-table w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="h-10 px-2 font-medium">Email / Nama</th>
                  <th className="h-10 px-2 font-medium">Role</th>
                  <th className="h-10 px-2 font-medium">Modul Diizinkan</th>
                  <th className="h-10 px-2 font-medium">Status</th>
                  <th className="h-10 px-2 text-right font-medium">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5} className="h-[160px] text-center text-slate-500">
                      Memuat daftar pengguna…
                    </td>
                  </tr>
                ) : users.length ? (
                  users.map((user) => (
                    <tr key={user.id} className="align-top">
                      <td className="px-2 py-3">
                        <p className="font-medium text-slate-100">{user.email}</p>
                        <p className="text-xs text-slate-500">
                          {user.name}
                          {user.username && ` · @${user.username}`}
                          {user.id === currentUserId && " · Anda"}
                        </p>
                      </td>
                      <td className="px-2 py-3">
                        {user.role === "supervisor" ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-indigo-100 px-2 py-1 text-xs font-medium text-indigo-800">
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Supervisor
                          </span>
                        ) : (
                          <Badge>User</Badge>
                        )}
                      </td>
                      <td className="px-2 py-3 text-slate-300">
                        {user.role === "supervisor"
                          ? "Semua modul"
                          : moduleLabels(user.allowedModules).join(", ") || "—"}
                      </td>
                      <td className="px-2 py-3">
                        <Badge variant={user.disabled ? "danger" : "success"}>
                          {user.disabled ? "Nonaktif" : "Aktif"}
                        </Badge>
                      </td>
                      <td className="px-2 py-3 text-right">
                        {user.role !== "supervisor" && (
                          <div className="inline-flex items-center gap-1">
                            <Button
                              variant="outline"
                              size="icon"
                              aria-label={`Kelola ${user.email}`}
                              onClick={() => (editId === user.id ? setEditId(null) : openEdit(user))}
                            >
                              <UserCog className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              aria-label={`Reset password ${user.email}`}
                              disabled={saving || resetBusyId === user.id}
                              onClick={() => handleResetPassword(user)}
                            >
                              <KeyRound className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              aria-label={`${user.disabled ? "Aktifkan" : "Nonaktifkan"} ${user.email}`}
                              disabled={saving}
                              onClick={() =>
                                patchUser(
                                  user.id,
                                  { disabled: !user.disabled },
                                  `Pengguna ${user.email} ${user.disabled ? "diaktifkan" : "dinonaktifkan"}.`,
                                )
                              }
                            >
                              {user.disabled ? <ShieldCheck className="h-4 w-4" /> : <X className="h-4 w-4" />}
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              aria-label={`Hapus ${user.email}`}
                              disabled={saving}
                              onClick={() => handleDelete(user)}
                            >
                              <Trash2 className="h-4 w-4 text-red-600" />
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="h-[160px] text-center text-slate-500">
                      Belum ada pengguna.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {editId && (
            <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.04] p-4">
              <p className="mb-3 text-sm font-medium text-slate-100">
                Edit pengguna: {users.find((user) => user.id === editId)?.email}
              </p>
              <div className="flex flex-wrap items-center gap-4">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Modul diizinkan:</span>
                {MODULE_OPTIONS.map((option) => (
                  <label key={option.value} className="flex items-center gap-1.5 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={editModules.includes(option.value)}
                      onChange={() => setEditModules((list) => toggleModule(list, option.value))}
                    />
                    {option.label}
                  </label>
                ))}
                <Button
                  disabled={saving}
                  onClick={async () => {
                    const ok = await patchUser(editId, { allowedModules: editModules }, "Modul pengguna diperbarui.");
                    if (ok) setEditId(null);
                  }}
                >
                  Simpan Modul
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Input
                  placeholder="Username (opsional)"
                  aria-label="Username"
                  className="w-[260px]"
                  value={editUsername}
                  onChange={(event) => setEditUsername(event.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={saving || !editUsername.trim()}
                  onClick={async () => {
                    const ok = await patchUser(editId, { username: editUsername.trim() }, "Username pengguna diperbarui.");
                    if (ok) setEditUsername("");
                  }}
                >
                  Simpan Username
                </Button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Untuk reset password, gunakan ikon <KeyRound className="inline h-3 w-3" /> pada kolom Aksi di tabel.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
