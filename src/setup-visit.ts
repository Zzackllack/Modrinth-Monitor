import { parseDownloadPercentage, shouldDownload } from "./download-policy";
import { logAction } from "./logger";

export default function setupVisit() {
  const downloadPercentage = parseDownloadPercentage(
    process.env.DOWNLOAD_PERCENTAGE
  );
  const visitMode = shouldDownload(downloadPercentage) ? "download" : "visit";

  // Playwright workers inherit this choice, including replacement workers on retry.
  process.env.MONITOR_VISIT_MODE = visitMode;
  logAction("visit.mode.selected", { downloadPercentage, visitMode });
}
