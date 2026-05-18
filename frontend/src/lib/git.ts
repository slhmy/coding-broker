export type GitDiffSummary = {
  additions: number
  deletions: number
}

export type BranchDiffDisplay = GitDiffSummary & {
  branchLabel: string
}

export function summarizeGitDiff(
  diff: string | null | undefined
): GitDiffSummary {
  if (!diff) {
    return { additions: 0, deletions: 0 }
  }

  let additions = 0
  let deletions = 0

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue
    }
    if (line.startsWith("+")) {
      additions += 1
      continue
    }
    if (line.startsWith("-")) {
      deletions += 1
    }
  }

  return { additions, deletions }
}

export function buildBranchDiffDisplay(
  branchLabel: string,
  summary: GitDiffSummary
): BranchDiffDisplay {
  return {
    branchLabel,
    additions: summary.additions,
    deletions: summary.deletions,
  }
}
