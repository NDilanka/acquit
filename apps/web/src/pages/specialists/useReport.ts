import { useSession } from "../../session.tsx";
import { specialists } from "./client.ts";
import { useLoad } from "./useLoad.ts";
import { quietReportEnd, windowedReport } from "./reportWindow.ts";

export function useReport() {
  const { user } = useSession();
  const report = useLoad(async () => {
    const through = quietReportEnd(localStorage,user.handle,new Date().toISOString());
    return windowedReport(await specialists.morningReport("1970-01-01T00:00:00.000Z"),through);
  },user.handle);
  return { data:report.data?.data ?? null,through:report.data?.through,error:report.error,reload:report.reload };
}
