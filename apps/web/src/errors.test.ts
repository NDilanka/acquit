import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "./api.ts";
import { describeError, errorWords, FALLBACK_WORDS, isKnownCode } from "./errors.ts";

test("a known refusal reads as one plain sentence, with no code", () => {
  assert.equal(errorWords("AGENT_EXISTS"), "You already have an agent with that name.");
  assert.equal(errorWords("PRICE_OVER_BUDGET"), "The price is higher than the job budget.");
  assert.equal(
    errorWords("CAP_VISITORS_DAY"),
    "Acquit has made as many new accounts as it can today. Try again tomorrow, or open your saved account link.",
  );
  assert.equal(errorWords("INSUFFICIENT_CREDITS"), "Not enough bid credits. Each bid costs 10.");
});

test("an account refusal reads from the refusal table, not the API's detail", () => {
  assert.equal(errorWords("SEEDED_LOGIN_DISABLED"), "Seeded sign-in is off on this deployment. Use Try Acquit instead.");
  assert.equal(errorWords("FUNDING_BOUND"), "The payment method was fixed when a bid was accepted.");
  assert.equal(errorWords("NOT_VISITOR_JOB", "This action reaches only a job your own client owns."), "Only the job's client can change this job.");
  assert.equal(errorWords("CAP_VISITOR_JOBS"), "Your account has opened as many jobs as an account can.");
  assert.equal(errorWords("CAP_SPEND_DAY"), "Your account has reached its daily limit for job budgets.");
  assert.equal(errorWords("NOT_AN_ACCOUNT"), "Only a Try Acquit account can do this.");
});

test("an unknown code reads generically, and never as CODE: detail", () => {
  assert.equal(errorWords("SOME_NEW_CODE"), "Something went wrong. Try again in a moment.");
  assert.equal(errorWords("SOME_NEW_CODE", "server text"), FALLBACK_WORDS);
  assert.equal(errorWords("HTTP_502"), FALLBACK_WORDS);
  assert.equal(errorWords("constructor"), FALLBACK_WORDS);
});

test("a bad request names the field its detail refused, and a generic sentence otherwise", () => {
  assert.equal(
    errorWords("BAD_COMMAND", "Invalid pitch"),
    "Write a pitch: one sentence on how the work will be done, at most 2000 characters.",
  );
  assert.equal(errorWords("BAD_COMMAND", "Invalid ETA"), "Pick a delivery time of up to 14 days.");
  assert.equal(errorWords("BAD_REQUEST", "Expected an object"), "Some of the details are not valid. Check the form and try again.");
});

test("known codes are known, and a bad request is known only when its detail is", () => {
  assert.equal(isKnownCode("NOT_OWNER"), true);
  assert.equal(isKnownCode("SOME_NEW_CODE"), false);
  assert.equal(isKnownCode("BAD_COMMAND", "Invalid pitch"), true);
  assert.equal(isKnownCode("BAD_COMMAND", "Unsupported command or field"), false);
});

test("describeError gives a known code its sentence alone, and an unknown one a Details line", () => {
  assert.deepEqual(describeError(new ApiError(409, "AGENT_EXISTS")), {
    message: "You already have an agent with that name.",
    details: null,
  });
  assert.deepEqual(describeError(new ApiError(500, "SOME_NEW_CODE", "boom")), {
    message: "Something went wrong. Try again in a moment.",
    details: "SOME_NEW_CODE: boom",
  });
  assert.deepEqual(describeError(new ApiError(400, "BAD_COMMAND", "Invalid pitch")), {
    message: "Write a pitch: one sentence on how the work will be done, at most 2000 characters.",
    details: null,
  });
  assert.deepEqual(describeError(new TypeError("fetch failed")), {
    message: "Cannot reach the server. Check your connection and try again.",
    details: null,
  });
});
