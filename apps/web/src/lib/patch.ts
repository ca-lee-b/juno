export type PatchLine = {
  text: string;
  kind: "context" | "addition" | "deletion" | "meta";
  oldLine?: number;
  newLine?: number;
};
export type PatchFile = {
  path: string;
  status: "A" | "D" | "M";
  lines: PatchLine[];
  additions: number;
  deletions: number;
};

/** Read unified diff hunks without changing the patch used for downloads. */
export function parsePatch(patch: string): PatchFile[] {
  if (!patch.trim()) return [];
  return patch
    .split(/(?=^diff --git )/m)
    .filter((section) => section.trim())
    .map((section, index) => {
      const source = section.split("\n");
      const path =
        section.match(/^\+\+\+ b\/(.+)$/m)?.[1] ||
        section.match(/^--- a\/(.+)$/m)?.[1] ||
        section.match(/^diff --git .* b\/(.+)$/m)?.[1] ||
        `Patch ${index + 1}`;
      let oldLine = 0;
      let newLine = 0;
      let inHunk = false;
      let additions = 0;
      let deletions = 0;
      const lines: PatchLine[] = [];
      for (const text of source) {
        const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
          oldLine = Number(hunk[1]);
          newLine = Number(hunk[2]);
          inHunk = true;
          lines.push({ text, kind: "meta" });
        } else if (inHunk && text.startsWith("+")) {
          lines.push({ text: text.slice(1), kind: "addition", newLine: newLine++ });
          additions++;
        } else if (inHunk && text.startsWith("-")) {
          lines.push({ text: text.slice(1), kind: "deletion", oldLine: oldLine++ });
          deletions++;
        } else if (inHunk && text.startsWith(" ")) {
          lines.push({
            text: text.slice(1),
            kind: "context",
            oldLine: oldLine++,
            newLine: newLine++,
          });
        } else if (inHunk && text.startsWith("\\")) lines.push({ text, kind: "meta" });
      }
      if (!lines.length) lines.push(...source.map((text) => ({ text, kind: "meta" as const })));
      return {
        path,
        status: /^--- \/dev\/null$/m.test(section)
          ? "A"
          : /^\+\+\+ \/dev\/null$/m.test(section)
            ? "D"
            : "M",
        lines,
        additions,
        deletions,
      };
    });
}
