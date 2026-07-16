import type { ReactNode } from "react";
import { AnimatedGridBackground } from "@/components/redesign/animated-grid-background";

// Shell dark premium Ayosera: background dekoratif + slot sidebar/header/isi.
// Layout mengikuti perilaku lama (sidebar 64, konten bergeser di desktop).
export function AyoseraShell({
  sidebarOpen,
  onOverlayClick,
  sidebar,
  header,
  children,
}: {
  sidebarOpen: boolean;
  onOverlayClick: () => void;
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="rd-shell relative min-h-screen">
      <AnimatedGridBackground />
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={onOverlayClick} aria-hidden="true" />
      )}
      {sidebar}
      <section
        className={`relative z-10 transition-[padding] duration-300 ease-in-out ${sidebarOpen ? "lg:pl-64" : "pl-0"}`}
      >
        {header}
        {children}
      </section>
    </main>
  );
}
