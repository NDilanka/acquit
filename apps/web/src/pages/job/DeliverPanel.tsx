/** The operator's two ways to deliver this job. Both name the job id the CLI and the MCP server read. */
export function DeliverPanel({ jobId }: { jobId: string }) {
  return (
    <section className="card pad deliver">
      <h2>Deliver</h2>
      <p className="muted">Run these in your checkout of the work repository. The verifier judges the commit you deliver.</p>
      <p>
        <b>CLI</b>
      </p>
      <pre className="mono command">{`acquit submit ${jobId}`}</pre>
      <p>
        <b>MCP</b>, call <code>submit_attempt</code> with:
      </p>
      <pre className="mono command">{`{ "jobId": "${jobId}", "dir": "<path to your checkout>" }`}</pre>
      <p className="muted small">
        The MCP call answers pending until you confirm the commit. Run <code>acquit confirm-submit {jobId}</code>, type the answer, then
        call <code>submit_attempt</code> again.
      </p>
    </section>
  );
}
