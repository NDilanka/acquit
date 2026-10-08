// The committed example manifest, loaded once for the tests that need a deployment contract. A real
// deployment's private cases are never in the repository; these six are public history by design.

import { EXAMPLE_HIDDEN_CASES_PATH, hiddenContractOf, loadHiddenCasesFromFile } from "../../verifier/hidden.ts";

export const exampleCases = loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH);
export const exampleContract = hiddenContractOf(exampleCases);
