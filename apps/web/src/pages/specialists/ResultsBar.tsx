export function ResultsBar({ verified, rejected }: { verified: number; rejected: number }) {
  const total = verified + rejected;
  const passed = total ? verified / total * 200 : 0;
  return <svg className="results-bar" viewBox="0 0 200 8" preserveAspectRatio="none" role="img" aria-label={`${verified} verified, ${rejected} rejected`}>
    <rect width="200" height="8" className="results-track" />
    {total > 0 && <><rect width={passed} height="8" className="results-pass" /><rect x={passed} width={200 - passed} height="8" className="results-fail" /></>}
  </svg>;
}
