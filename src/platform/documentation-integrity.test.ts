import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("documentation retains its own identity instead of test code or another document", async () => {
  const documents = [
    ["README.md", "# ScienceMotion AI"],
    ["docs/PLAN.md", "# Development Plan"],
    ["docs/ARCHITECTURE.md", "# Architecture"],
    ["docs/P1.1-E.md", "# P1.1-E"],
  ];
  const contents: string[] = [];
  for (const [path, title] of documents) {
    const content = await readFile(path, "utf8");
    assert.ok(content.startsWith(title), `${path} must start with ${title}`);
    assert.ok(!/^import\s.*node:test/m.test(content), `${path} contains top-level test source`);
    contents.push(content);
  }
  assert.equal(new Set(contents).size, documents.length);
});
