import assert from "node:assert/strict";
import { test } from "node:test";
import { approveFailure, codeHint, signInPrompt } from "./cli.ts";

test("the prompt names the signed-in user and role", () => {
  assert.equal(signInPrompt({ handle: "devon-ops", role: "OPERATOR" }), "Sign in to the Acquit CLI as devon-ops (operator)?");
  assert.equal(signInPrompt({ handle: "maya", role: "CLIENT" }), "Sign in to the Acquit CLI as maya (client)?");
});

test("the code hint shows only its ends", () => {
  const code = "Xy3_abcdefghijklmnopqrstuvwxyz0123456789-Q7k";
  assert.equal(codeHint(code), "Xy3_…-Q7k");
  assert.equal(codeHint("short"), "short");
  assert.equal(codeHint("12345678"), "12345678");
  assert.equal(codeHint("123456789"), "1234…6789");
});

test("a used, expired, or unknown code sends the user back to the terminal", () => {
  const again = "This sign-in link is no longer valid. Run `acquit login` again.";
  assert.equal(approveFailure(410, "CLI_CODE_USED"), "This sign-in link was already used. Run `acquit login` again.");
  assert.equal(approveFailure(410, "CLI_CODE_EXPIRED"), "This sign-in link has expired. Run `acquit login` again.");
  assert.equal(approveFailure(410, "SOMETHING_ELSE"), again);
  assert.equal(approveFailure(404, "CLI_CODE_UNKNOWN"), again);
  assert.equal(approveFailure(500, "HTTP_500"), null);
  assert.equal(approveFailure(400, "BAD_REQUEST"), null);
});
