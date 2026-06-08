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

  // Fetch CI status (check runs / reviews)
  const reviewsResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    { headers }
  );
  const reviews = reviewsResp.ok
    ? await reviewsResp.json() as Array<{ state: string }>
    : [];
  const ciStatus = reviews.length > 0 ? reviews[reviews.length - 1].state : 'pending';

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
