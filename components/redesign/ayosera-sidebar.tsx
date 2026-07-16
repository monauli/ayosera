import type { ElementType } from "react";
import { CheckCircle2, ChevronDown, DatabaseZap } from "lucide-react";

export type SidebarNavItem = {
  label: string;
  display: string;
  icon: ElementType;
  subItems?: { label: string; nav: string }[];
};

// Sidebar gelap Ayosera (presentasi murni). Route/permission/active-state
// tetap dikontrol app/page.tsx lewat props — komponen ini hanya menggambar.
export function AyoseraSidebar({
  open,
  items,
  activeNav,
  onSelect,
  groupOpen,
  onToggleGroup,
  statusLabel,
  lastCheckpoint,
}: {
  open: boolean;
  items: SidebarNavItem[];
  activeNav: string;
  onSelect: (nav: string) => void;
  /** State buka/tutup grup collapsible (Olsera) — dimiliki page lama. */
  groupOpen: boolean;
  onToggleGroup: () => void;
  statusLabel: string;
  lastCheckpoint: string;
}) {
  return (
    <aside
      className={`rd-sidebar fixed inset-y-0 left-0 z-50 w-64 transform transition-transform duration-300 ease-in-out ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex h-16 items-center gap-3 px-5">
        <div className="rd-logo flex h-9 w-9 items-center justify-center rounded-lg">
          <DatabaseZap className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm font-semibold tracking-wide text-slate-50">AYOSERA</p>
          <p className="text-xs text-slate-400">Super App Transaksi</p>
        </div>
      </div>
      <nav className="space-y-1 px-3 py-4">
        {items.map((item) => {
          if (item.subItems?.length) {
            const groupActive = item.subItems.some((sub) => sub.nav === activeNav);
            const expanded = groupOpen || groupActive;
            return (
              <div key={item.label}>
                <button
                  onClick={onToggleGroup}
                  aria-expanded={expanded}
                  className={`rd-nav-item flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm ${
                    groupActive ? "rd-nav-item-active-group" : ""
                  }`}
                >
                  <item.icon className="h-4 w-4" />
                  <span className="flex-1 text-left">{item.display}</span>
                  <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
                </button>
                {expanded && (
                  <div className="mt-1 space-y-1 pl-7">
                    {item.subItems.map((sub) => (
                      <button
                        key={sub.label}
                        onClick={() => onSelect(sub.nav)}
                        className={`rd-nav-sub flex h-9 w-full items-center gap-2 rounded-lg border-l-2 px-3 text-sm ${
                          activeNav === sub.nav ? "rd-nav-sub-active" : "border-transparent"
                        }`}
                      >
                        {sub.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          return (
            <button
              key={item.label}
              onClick={() => onSelect(item.label)}
              className={`rd-nav-item flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm ${
                activeNav === item.label ? "rd-nav-item-active" : ""
              }`}
            >
              <item.icon className="h-4 w-4" />
              {item.display}
            </button>
          );
        })}
      </nav>
      <div className="absolute inset-x-0 bottom-0 border-t border-white/5 p-3">
        <div className="rd-sidebar-status rounded-lg px-3 py-2">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-200">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
            API Sehat · {statusLabel}
          </div>
          <p className="mt-0.5 text-[11px] text-slate-400">Checkpoint terakhir: {lastCheckpoint}</p>
        </div>
      </div>
    </aside>
  );
}
