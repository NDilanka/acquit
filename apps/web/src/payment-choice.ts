import { createElement as h } from "react";
import type { AccountView, FundingMode, JobView, SessionUser } from "./api-types";
import { ApiError } from "./api.ts";

type PaymentJob = Pick<JobView, "status" | "phase" | "client">;
type PaymentViewer = { user: Pick<SessionUser, "role" | "handle">; account: Pick<AccountView, "client"> | null };

export const PAYMENT_OPTIONS: readonly { value: FundingMode; label: string; detail: string }[] = [
  { value: "card", label: "Test card", detail: "No PayPal account needed. Pays instantly." },
  { value: "checkout", label: "PayPal sandbox account", detail: "You will be sent to PayPal's sandbox to log in and approve, then returned here." },
];
export const PAYMENT_BOUND = "A bid has already been accepted. The payment choice is fixed for this job.";

export function paymentChoiceState(job: PaymentJob, viewer: PaymentViewer): "hidden" | "ready" | "bound" {
  if (viewer.user.role !== "CLIENT" || !viewer.account || viewer.account.client !== viewer.user.handle || job.client !== viewer.user.handle) return "hidden";
  return job.status === "OPEN" && job.phase === "BIDDING" ? "ready" : "bound";
}

export function paymentAcceptLabel(mode: FundingMode): string {
  return mode === "card" ? "Accept and pay with the test card" : "Accept and pay with PayPal";
}

export function paymentChoiceFailure(error: unknown): { message: string; locked: boolean } {
  if (error instanceof ApiError && error.status === 403 && error.code === "NOT_VISITOR_JOB") {
    return { message: "Only the client who opened this job can change how it is paid.", locked: true };
  }
  if (error instanceof ApiError && error.status === 409 && error.code === "FUNDING_BOUND") {
    return { message: PAYMENT_BOUND, locked: true };
  }
  return { message: "We couldn't save your payment choice. Try again.", locked: false };
}

/** Native radios retain their label, arrow-key navigation and disabled-fieldset semantics. */
export function PaymentChoice({ job, viewer, value, busy, locked, onChange }: {
  job: PaymentJob; viewer: PaymentViewer; value: FundingMode; busy: boolean; locked: boolean;
  onChange: (mode: FundingMode) => void;
}) {
  const state = paymentChoiceState(job, viewer);
  if (state === "hidden") return null;
  const disabled = busy || locked || state === "bound";
  return h("fieldset", { className: "payment-choice", disabled },
    h("legend", null, "PayPal sandbox"),
    ...PAYMENT_OPTIONS.map(option => h("label", { key: option.value },
      h("input", { type: "radio", name: "sandbox-payment", value: option.value, disabled,
        checked: value === option.value, onChange: () => onChange(option.value) }),
      h("span", null, h("strong", null, option.label), h("small", null, option.detail)),
    )),
  );
}
