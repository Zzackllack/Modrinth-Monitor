const { fetchWithTimeout, sleep } = require("../net/http");
const {
  englishCountryName,
  matchCountryChoice,
  parseCountryChoices,
} = require("./country-names");

const DEFAULT_CONTROL_URL = "http://localhost:8000";

/**
 * Thin client for the Gluetun control server.
 *
 * `PUT /v1/vpn/settings` applies server selection and restarts the tunnel, so a
 * country switch is: patch settings -> wait for `running` -> confirm the exit
 * country actually changed.
 *
 * Gluetun validates country filters against the provider's own country names
 * ("Germany"), not ISO codes ("DE"). Codes are translated here; if a provider
 * uses another spelling, the validation error lists the available choices and
 * the request is retried once with the provider's name.
 */
class GluetunClient {
  constructor({
    baseUrl = DEFAULT_CONTROL_URL,
    username = "",
    password = "",
    timeoutMs = 15_000,
    logAction,
    fetchImpl = fetchWithTimeout,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.logAction = logAction;
    this.fetch = fetchImpl;
    this.countryNameOverrides = new Map();
  }

  headers() {
    const headers = { Accept: "application/json" };
    if (this.username) {
      const token = Buffer.from(
        `${this.username}:${this.password || ""}`
      ).toString("base64");
      headers.Authorization = `Basic ${token}`;
    }
    return headers;
  }

  async request(path, { method = "GET", body } = {}) {
    const headers = this.headers();
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: this.timeoutMs,
    });

    const text = await response.text();
    if (!response.ok) {
      const error = new Error(
        `Gluetun ${method} ${path} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`
      );
      error.status = response.status;
      error.body = text;
      throw error;
    }

    return text;
  }

  countryName(code) {
    return this.countryNameOverrides.get(code) || englishCountryName(code);
  }

  async getStatus() {
    const text = await this.request("/v1/vpn/status");
    const data = JSON.parse(text);
    return data.status;
  }

  async getPublicIp() {
    const text = await this.request("/v1/publicip/ip");
    const data = JSON.parse(text);
    return data.public_ip || null;
  }

  async patchServerSelection(selection) {
    const body = { provider: { server_selection: selection } };
    this.logAction?.("gluetun.settings.patch", { selection });

    const outcome = (
      await this.request("/v1/vpn/settings", { method: "PUT", body })
    ).trim();

    this.logAction?.("gluetun.settings.applied", {
      selection,
      outcome: outcome.slice(0, 120),
    });

    return outcome;
  }

  buildSelection({ countries = [], cities, regions, hostnames }) {
    const selection = {};
    if (countries.length) {
      selection.countries = countries.map((code) => this.countryName(code));
    }
    if (cities && cities.length) selection.cities = cities;
    if (regions && regions.length) selection.regions = regions;
    if (hostnames && hostnames.length) selection.hostnames = hostnames;
    return selection;
  }

  async setServerSelection({ countries = [], cities, regions, hostnames } = {}) {
    const selection = this.buildSelection({ countries, cities, regions, hostnames });
    if (!Object.keys(selection).length) return null;

    try {
      const outcome = await this.patchServerSelection(selection);
      return { selection, outcome };
    } catch (error) {
      const choices = parseCountryChoices(error.body);
      if (
        error.status !== 400 ||
        !countries.length ||
        !choices.length ||
        !/country specified is not valid/i.test(error.body || "")
      ) {
        throw error;
      }

      const code = countries[0];
      const resolved = matchCountryChoice(choices, code);
      if (!resolved) {
        throw new Error(
          `Gluetun does not offer a country for "${code}" (${englishCountryName(code)}); available countries: ${choices.slice(0, 15).join(", ")}...`
        );
      }

      this.countryNameOverrides.set(code, resolved);
      this.logAction?.("gluetun.country.resolved", {
        code,
        requested: selection.countries[0],
        resolved,
      });

      const retrySelection = { ...selection, countries: [resolved] };
      const outcome = await this.patchServerSelection(retrySelection);
      return { selection: retrySelection, outcome };
    }
  }

  /**
   * Detects the tunnel leaving `running` after a settings patch. Not finding it
   * is not fatal (Gluetun may answer "unchanged"), so the caller still verifies
   * the exit country afterwards.
   */
  async waitForRestart({ timeoutMs = 30_000, pollMs = 1_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = "unknown";

    while (Date.now() < deadline) {
      try {
        lastStatus = await this.getStatus();
        if (lastStatus !== "running") {
          this.logAction?.("gluetun.restart.detected", { status: lastStatus });
          return true;
        }
      } catch (error) {
        lastStatus = `error: ${error.message}`;
      }
      await sleep(pollMs);
    }

    this.logAction?.("gluetun.restart.not_detected", { lastStatus });
    return false;
  }

  async waitForRunning({ timeoutMs = 120_000, pollMs = 2_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = "unknown";

    while (Date.now() < deadline) {
      try {
        lastStatus = await this.getStatus();
        if (lastStatus === "running") return lastStatus;
      } catch (error) {
        lastStatus = `error: ${error.message}`;
      }
      await sleep(pollMs);
    }

    throw new Error(
      `Gluetun did not reach "running" within ${Math.round(timeoutMs / 1000)}s (last status: ${lastStatus}).`
    );
  }

  async stop() {
    await this.request("/v1/vpn/status", {
      method: "PUT",
      body: { status: "stopped" },
    });
  }
}

module.exports = { GluetunClient };
