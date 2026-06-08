export interface PRWatchState {
  owner: string;
  repo: string;
  prNumber: number;
  lastCommentId?: number;
  lastChecked: string;
  checkCount: number;
}

export async function fetchPRState(
  owner: string,
  repo: string,
  prNumber: number,
  token?: string
): Promise<{
  title: string;
  state: string;
  mergeable: boolean | null;
  ciStatus: string;
  lastCommentBody: string | null;
  commentCount: number;
}> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'TRIDENT-CLI/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Fetch PR details
  const prResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    { headers }
  );
  if (!prResp.ok) throw new Error(`GitHub API error: ${prResp.status}`);
  const pr = await prResp.json() as { title: string; state: string; mergeable: boolean | null };

  // Fetch comments
  const commentsResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers }
  );
  const comments = commentsResp.ok
    ? await commentsResp.json() as Array<{ body: string }>
    : [];

  // Fetch CI status from check runs on the PR head commit (not reviews — reviews
  // are human code-review approvals, not CI pipeline results).
  const prFull = pr as { title: string; state: string; mergeable: boolean | null; head?: { sha?: string } };
  const headSha = prFull.head?.sha;
  let ciStatus = 'unknown';
  if (headSha) {
    const checkRunsResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
      { headers }
    );
    if (checkRunsResp.ok) {
      const checkRunsData = await checkRunsResp.json() as { check_runs: Array<{ status: string; conclusion: string | null }> };
      const runs = checkRunsData.check_runs ?? [];
      if (runs.length === 0) {
        ciStatus = 'no checks';
      } else if (runs.some(r => r.status !== 'completed')) {
        ciStatus = 'pending';
      } else if (runs.every(r => r.conclusion === 'success' || r.conclusion === 'skipped' || r.conclusion === 'neutral')) {
        ciStatus = 'success';
      } else {
        ciStatus = 'failure';
      }
    }
  }

  return {
    title: pr.title,
    state: pr.state,
    mergeable: pr.mergeable,
    ciStatus,
    lastCommentBody: comments.length > 0 ? comments[comments.length - 1].body : null,
    commentCount: comments.length,
  };
}

export interface PRWatcher {
  owner: string;
  repo: string;
  prNumber: number;
  intervalHandle: ReturnType<typeof setInterval>;
  lastCommentCount: number;
  lastCiStatus: string;
  token?: string;
}
