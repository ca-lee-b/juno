import assert from "node:assert/strict";
import { parsePatch } from "../src/lib/patch.ts";
const patch =
  "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -4,2 +4,3 @@\n context\n-before\n+after\n+++actual content\n\\ No newline at end of file\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new";
const files = parsePatch(patch);
assert.equal(files.length, 2);
assert.equal(files[0].path, "a.txt");
assert.equal(files[0].additions, 2);
assert.equal(files[0].deletions, 1);
assert.deepEqual(files[0].lines[1], { text: "context", kind: "context", oldLine: 4, newLine: 4 });
assert.deepEqual(files[0].lines[2], { text: "before", kind: "deletion", oldLine: 5 });
assert.deepEqual(files[0].lines[4], { text: "++actual content", kind: "addition", newLine: 6 });
assert.equal(files[1].status, "A");
assert.deepEqual(parsePatch(""), []);
assert.equal(parsePatch("diff --git a/a b/a\nBinary files a/a and b/a differ")[0].path, "a");
console.log(
  "PASS: multi-file diffs, hunk numbers, content prefixes, new files, binary files, empty patch",
);
