import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";

const DEFAULT_URL = "https://modrinth.com/modpack/winterlands";
const modrinthUrl = process.env.MODRINTH_URL || DEFAULT_URL;
const downloadDir =
  process.env.DOWNLOAD_DIR || path.join(process.cwd(), "downloads");

const log = (action: string, extra: Record<string, unknown> = {}) => {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), action, ...extra })
  );
};

test.describe("Modrinth modpack monitor", () => {
  test("visits modpack page and optionally verifies a download", async ({ page }) => {
    const visitMode = process.env.MONITOR_VISIT_MODE;
    log("test.start", { modrinthUrl, downloadDir, visitMode });

    await page.goto(modrinthUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    log("page.loaded");

    const acceptCookies = page.getByRole("button", {
      name: /accept|agree|got it|allow/i,
    });
    if (
      (await acceptCookies.count()) > 0 &&
      (await acceptCookies.first().isVisible())
    ) {
      await acceptCookies.first().click();
      log("cookies.accepted");
    }

    let primaryDownload = page.locator('button:has-text("Download")').first();
    if ((await primaryDownload.count()) === 0) {
      primaryDownload = page
        .getByRole("button", { name: /^download$/i })
        .first();
    }
    await expect(primaryDownload).toBeVisible({ timeout: 20_000 });
    log("download.trigger.visible");

    if (visitMode === "visit") {
      log("download.skipped", { reason: "visit_only" });
      return;
    }

    await fs.promises.mkdir(downloadDir, { recursive: true });
    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await primaryDownload.click();
    log("download.trigger.clicked");

    const mrpackLink = page.locator('a[href$=".mrpack"], a[href*=".mrpack"]');
    await mrpackLink
      .first()
      .waitFor({ timeout: 20_000 })
      .catch(() => {});
    if ((await mrpackLink.count()) > 0) {
      await mrpackLink.first().click();
      log("mrpack.link.clicked");
    }

    const download = await downloadPromise;
    const filePath = path.join(downloadDir, download.suggestedFilename());

    await download.saveAs(filePath);
    log("download.saved", { filePath });

    const failure = await download.failure();
    expect(failure).toBeNull();

    const stats = await fs.promises.stat(filePath);
    expect(stats.size).toBeGreaterThan(0);
    log("download.validated", { size: stats.size });

    // Schedule cleanup of the downloaded file after 10 minutes to keep the directory tidy.
    setTimeout(
      () => {
        fs.promises
          .unlink(filePath)
          .then(() => log("download.deleted", { filePath }))
          .catch((err) =>
            log("download.delete_failed", { filePath, error: err.message })
          );
      },
      10 * 60 * 1000
    );

    test.info().attach("downloaded-file", {
      path: filePath,
      contentType: "application/octet-stream",
    });
  });
});
