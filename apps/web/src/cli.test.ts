import assert from "node:assert/strict";
import { test } from "node:test";
import { approveFailure, codeHint, copyText, isCodeFormat, NOT_VALID, signInPrompt } from "./cli.ts";

const realCode = `Xy3_${"a".repeat(35)}-Q7k`;

test("the prompt names the signed-in user and role", () => {
  assert.equal(signInPrompt({ handle: "devon-ops", role: "OPERATOR" }), "Sign in to the Acquit CLI as devon-ops (operator)?");
  assert.equal(signInPrompt({ handle: "maya", role: "CLIENT" }), "Sign in to the Acquit CLI as maya (client)?");
});

test("only a 43-character base64url code is a code the API could have issued", () => {
  assert.equal(isCodeFormat(realCode), true);
  assert.equal(isCodeFormat("ABCD-EFGH"), false);
  assert.equal(isCodeFormat(realCode.slice(1)), false);
  assert.equal(isCodeFormat(`${realCode}x`), false);
  assert.equal(isCodeFormat("Xy3 abcdefghijklmnopqrstuvwxyz0123456789-Q7k"), false);
});

test("the code hint shows the first and last four characters of a real code", () => {
  assert.equal(codeHint(realCode), "Xy3_…-Q7k");
  assert.equal(codeHint("1234567890123456789012345678901234567890123"), "1234…0123");
});

test("an unknown code is not valid, and a used, expired, or other refused link is no longer valid", () => {
  assert.equal(approveFailure(404, "CLI_CODE_UNKNOWN"), NOT_VALID);
  assert.equal(copyText(NOT_VALID.body), "Check the link your terminal printed, or run acquit login again.");
  assert.equal(NOT_VALID.title, "That code is not valid");

  const used = approveFailure(410, "CLI_CODE_USED");
  assert.equal(used?.title, "Link no longer valid");
  assert.equal(copyText(used!.body), "This sign-in link was already used. Run acquit login again.");

  const expired = approveFailure(410, "CLI_CODE_EXPIRED");
  assert.equal(expired?.title, "Link no longer valid");
  assert.equal(copyText(expired!.body), "This sign-in link has expired. Run acquit login again.");

  const other = approveFailure(410, "SOMETHING_ELSE");
  assert.equal(other?.title, "Link no longer valid");
  assert.equal(copyText(other!.body), "This sign-in link is no longer valid. Run acquit login again.");

  assert.equal(approveFailure(500, "HTTP_500"), null);
  assert.equal(approveFailure(400, "BAD_REQUEST"), null);
});

test("the CLI copy carries the command as code, never as literal backticks", () => {
  for (const failure of [NOT_VALID, approveFailure(410, "CLI_CODE_USED"), approveFailure(410, "CLI_CODE_EXPIRED")]) {
    assert.ok(failure, "every refusal in this test has copy");
    assert.equal(copyText(failure.body).includes("`"), false);
    assert.ok(failure.body.some((part) => typeof part === "object" && part.code === "acquit login"), "the command is a code part");
  }
});
