// Layer background dekoratif untuk shell redesign (Hero 2: gradient blur +
// grain/noise; Hero 195: fading grid lines). Murni presentasi — selalu
// pointer-events-none dan berada di z-0 paling belakang.
export function AnimatedGridBackground() {
  return (
    <div aria-hidden="true" className="rd-bg pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="rd-bg-grid" />
      <div className="rd-bg-blob rd-bg-blob-1" />
      <div className="rd-bg-blob rd-bg-blob-2" />
      <div className="rd-bg-blob rd-bg-blob-3" />
      <div className="rd-bg-noise" />
    </div>
  );
}
