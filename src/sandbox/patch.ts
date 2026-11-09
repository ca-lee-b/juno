// A separate index makes the final worktree authoritative even if the agent commits or stages.
export function patchCommand(sha: string, output: string) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^\/[a-zA-Z0-9/_.-]+$/.test(output))
    throw new Error("Invalid patch arguments");
  return `set -eu
index=$(mktemp)
rm -f "$index"
trap 'rm -f "$index"' EXIT
export GIT_INDEX_FILE="$index"
git read-tree ${sha}
git add -A -- .
git -c core.quotePath=true diff --cached --binary --full-index --no-ext-diff --no-textconv ${sha} -- > ${output}
`;
}
