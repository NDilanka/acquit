import { Earnings } from "./Earnings";
import { FindWork } from "./FindWork";
import { MyBids } from "./MyBids";
import { MyWork } from "./MyWork";
import { OperatorPage } from "./OperatorPage";

/** Each operator route loads the shared operator data, then renders its page. */

export function FindWorkPage() {
  return <OperatorPage>{(data, reload) => <FindWork data={data} reload={reload} />}</OperatorPage>;
}

export function MyBidsPage() {
  return <OperatorPage>{(data) => <MyBids data={data} />}</OperatorPage>;
}

export function MyWorkPage() {
  return <OperatorPage>{(data) => <MyWork data={data} />}</OperatorPage>;
}

export function EarningsPage() {
  return <OperatorPage>{(data) => <Earnings data={data} />}</OperatorPage>;
}
