const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EgressJournal } = require("../src/egress/egress-journal");

test("writes JSONL and masks credentials", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "egress-journal-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "egress.jsonl");

  const journal = new EgressJournal({ file, logAction: () => {} });
  journal.record("egress.attempt.start", {
    attempt: 1,
    kind: "proxy",
    username: "user",
    password: "super-secret",
    error: "none",
  });

  const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);

  const entry = JSON.parse(lines[0]);
  assert.equal(entry.action, "egress.attempt.start");
  assert.equal(entry.kind, "proxy");
  assert.equal(entry.username, "***");
  assert.equal(entry.password, "***");
  assert.equal(entry.error, "none");
});

test("rotates the journal once it exceeds the size limit", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "egress-rotate-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "egress.jsonl");

  const journal = new EgressJournal({ file, maxBytes: 120, logAction: () => {} });
  journal.record("egress.attempt.start", { attempt: 1, padding: "x".repeat(100) });
  journal.record("egress.attempt.success", { attempt: 1 });

  const rotated = await fs.stat(`${file}.1`);
  assert.ok(rotated.size > 0);

  const current = JSON.parse(
    (await fs.readFile(file, "utf8")).trim().split("\n").at(-1)
  );
  assert.equal(current.action, "egress.attempt.success");
});
