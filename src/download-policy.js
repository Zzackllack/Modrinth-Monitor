function parseDownloadPercentage(value = "100") {
  const percentage = Number(value);
  if (
    value.trim() === "" ||
    !Number.isFinite(percentage) ||
    percentage < 0 ||
    percentage > 100
  ) {
    throw new Error("DOWNLOAD_PERCENTAGE must be a number between 0 and 100.");
  }
  return percentage;
}

function shouldDownload(percentage, random = Math.random) {
  return random() * 100 < percentage;
}

module.exports = { parseDownloadPercentage, shouldDownload };
