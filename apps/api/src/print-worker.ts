// The print demo's worker thread. The API starts one per run with the run's input as its workerData, and this file
// runs that one run and posts back what it produced. The API terminates the thread at the run's deadline, so the
// run's CPU work never holds the API's event loop. This file reads nothing else and writes nothing but its reply.

import { parentPort, workerData } from "node:worker_threads";
import { runPrintDemo } from "../../../packages/verifier-print/src/run.ts";
import type { PrintDemoRun, RunInput } from "../../../packages/verifier-print/src/run.ts";

/** What the worker posts back: the run's record, or that the run failed before it produced one. */
export type PrintWorkerReply = { readonly ok: true; readonly run: PrintDemoRun } | { readonly ok: false };

if (parentPort === null) throw new Error("print-worker.ts runs only as a worker thread");
const port = parentPort;

runPrintDemo(workerData as RunInput).then(
	(run): PrintWorkerReply => ({ ok: true, run }),
	(): PrintWorkerReply => ({ ok: false }),
).then(reply => port.postMessage(reply));
