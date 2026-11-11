import { parseDownloadPercentage, shouldDownload } from "./download-policy";
import { logAction } from "./logger";

export default function setupVisit() {
  const downloadPercentage = parseDownloadPercentage(
    process.env.DOWNLOAD_PERCENTAGE
  );
  const visitMode = shouldDownload(downloadPercentage) ? "download" : "visit";

  // Playwright workers inherit this choice, including replacement workers on retry.
  process.env.MONITOR_VISIT_MODE = visitMode;

  // Egress metadata is set by the scheduler for the current route; it makes the
  // visit itself auditable from the Playwright side as well.
  logAction("visit.mode.selected", {
    downloadPercentage,
    visitMode,
    egressKind: process.env.EGRESS_KIND || "direct",
    egressBucket: process.env.EGRESS_BUCKET || null,
    egressCountry: process.env.EGRESS_COUNTRY || null,
    egressProxy: process.env.EGRESS_PROXY_ID || null,
    egressRouteId: process.env.EGRESS_ROUTE_ID || null,
    egressAttempt: process.env.EGRESS_ATTEMPT || null,
  });
}
