/**
 * Gluetun filters servers by the country *name* shipped by the provider
 * (NordVPN returns "Germany", not "DE"). Configuration stays in ISO codes, so
 * codes are translated here.
 *
 * CLDR names are a good default, but providers use older spellings in a few
 * places ("Czech Republic", "Turkey", "Hong Kong"). The alias map covers those;
 * anything else is corrected at runtime from the choices Gluetun reports in its
 * validation error.
 */
const ALIASES = {
  CZ: "Czech Republic",
  HK: "Hong Kong",
  MO: "Macao",
  TR: "Turkey",
  RU: "Russia",
  VN: "Vietnam",
  KR: "South Korea",
  KP: "North Korea",
  TW: "Taiwan",
  CD: "DR Congo",
  CI: "Ivory Coast",
  MM: "Myanmar",
  LA: "Laos",
  SY: "Syria",
  TZ: "Tanzania",
  VE: "Venezuela",
  BO: "Bolivia",
  IR: "Iran",
  MD: "Moldova",
  PS: "Palestine",
};

let displayNames;

function cldrCountryName(code) {
  try {
    displayNames = displayNames || new Intl.DisplayNames(["en"], { type: "region" });
    return displayNames.of(code) || null;
  } catch {
    return null;
  }
}

function englishCountryName(code) {
  const upper = String(code || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return upper;
  return ALIASES[upper] || cldrCountryName(upper) || upper;
}

function normalizeCountryName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[-_/.]/g, " ")
    .replace(/\bthe\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Picks the provider's spelling for a country code from the choices list that
 * Gluetun echoes in `... choices available A, B, C`. Returns null when nothing
 * matches confidently.
 */
function matchCountryChoice(choices, code) {
  const wanted = [englishCountryName(code), cldrCountryName(code), code]
    .filter(Boolean)
    .map(normalizeCountryName)
    .filter(Boolean);

  const normalized = (choices || [])
    .map((choice) => ({ choice, key: normalizeCountryName(choice) }))
    .filter((entry) => entry.key);

  for (const needle of wanted) {
    const exact = normalized.find((entry) => entry.key === needle);
    if (exact) return exact.choice;
  }

  // A fuzzy match must be unambiguous: "Niger" is contained in "Nigeria".
  for (const needle of wanted) {
    const matches = normalized.filter(
      (entry) => entry.key.includes(needle) || needle.includes(entry.key)
    );
    if (matches.length === 1) return matches[0].choice;
  }

  return null;
}

function parseCountryChoices(message) {
  const text = String(message || "");
  const match = /choices available (.+)$/is.exec(text);
  if (!match) return [];

  return match[1]
    .split(/,\s+/)
    .map((choice) => choice.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

module.exports = {
  englishCountryName,
  matchCountryChoice,
  normalizeCountryName,
  parseCountryChoices,
};
