// Regenerates src/samples.ts from samples/. Run: node packages/verifier-laser/tools/generate-samples.ts
import { writeFileSync } from "node:fs";
import { readSampleFiles, renderSamples, SAMPLES_MODULE } from "./render-samples.ts";

writeFileSync(SAMPLES_MODULE, renderSamples(readSampleFiles()));
console.log(`wrote ${SAMPLES_MODULE}`);
