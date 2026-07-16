// Animated border beam (Hero 195): garis cahaya yang berputar mengikuti
// border card. Dipasang di dalam elemen ber-position:relative dengan
// border-radius; murni dekoratif (pointer-events-none via CSS).
export function BorderBeam({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`rd-border-beam ${className}`} />;
}
