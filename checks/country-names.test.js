const assert = require("node:assert/strict");
const test = require("node:test");
const {
  englishCountryName,
  matchCountryChoice,
  normalizeCountryName,
  parseCountryChoices,
} = require("../src/egress/country-names");

test("translates ISO codes to provider country names", () => {
  assert.equal(englishCountryName("DE"), "Germany");
  assert.equal(englishCountryName("US"), "United States");
  assert.equal(englishCountryName("GB"), "United Kingdom");
  assert.equal(englishCountryName("de"), "Germany");

  // Provider spellings that differ from CLDR.
  assert.equal(englishCountryName("CZ"), "Czech Republic");
  assert.equal(englishCountryName("TR"), "Turkey");
  assert.equal(englishCountryName("HK"), "Hong Kong");
  assert.equal(englishCountryName("VN"), "Vietnam");
});

test("normalizes names for comparison", () => {
  assert.equal(normalizeCountryName("United States"), "united states");
  assert.equal(normalizeCountryName("Türkiye"), "turkiye");
  assert.equal(normalizeCountryName("Côte d’Ivoire"), "cote divoire");
  assert.equal(normalizeCountryName("Trinidad & Tobago"), "trinidad and tobago");
});

test("matches provider choices including alternate spellings", () => {
  const choices = [
    "Germany",
    "France",
    "Czech Republic",
    "Turkey",
    "Hong Kong",
    "Türkiye",
    "United States",
  ];

  assert.equal(matchCountryChoice(choices, "DE"), "Germany");
  assert.equal(matchCountryChoice(choices, "CZ"), "Czech Republic");
  assert.equal(matchCountryChoice(choices, "TR"), "Turkey");
  assert.equal(matchCountryChoice(choices, "HK"), "Hong Kong");
  assert.equal(matchCountryChoice(["Türkiye"], "TR"), "Türkiye");
  assert.equal(matchCountryChoice(choices, "US"), "United States");
});

test("does not guess when no choice is close", () => {
  assert.equal(matchCountryChoice(["Germany", "France"], "US"), null);
  assert.equal(matchCountryChoice([], "DE"), null);
});

test("parses the choices from a Gluetun validation error", () => {
  const message =
    "provider settings: server selection: for VPN service provider nordvpn: " +
    "the country specified is not valid: value is not one of the possible " +
    "choices: none of DE is one of the choices available Afghanistan, Albania, " +
    "Germany, Zimbabwe.";

  const choices = parseCountryChoices(message);
  assert.equal(choices.length, 4);
  assert.deepEqual(choices, ["Afghanistan", "Albania", "Germany", "Zimbabwe"]);
  assert.equal(matchCountryChoice(choices, "DE"), "Germany");
});
