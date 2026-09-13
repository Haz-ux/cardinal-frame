/**
 * GitHub service connector — self-registers as 'github'.
 *
 * Auth: personal access token (PAT) stored encrypted in the connector row's
 * secret_json. Native fetch only, api.github.com only. PAT never appears in
 * logs, errors, or audit records.
 */
import { registerConnector, sanitizeError } from './registry.mjs';

const GH_API = 'https://api.github.com';
const FETCH_TIMEOUT_MS = 15000;

async function ghRequest(secrets, path, { method = 'GET', body } = {}) {
  const pat = secrets?.pat;
  if (!pat) throw new Error('GitHub PAT is not configured — run POST /api/connectors/github/configure with secrets.pat');

  const url = GH_API + path; // path is always constructed internally from literals + validated ids
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cardinal-frame',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // fetch errors (DNS, TLS, timeout) — never echo the URL unfiltered is fine,
    // but never let a secret leak through here either.
    throw new Error(`GitHub request failed: ${sanitizeError(err)}`);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = data && data.message ? sanitizeError(data.message) : `HTTP ${res.status}`;
    throw new Error(`GitHub API error (${res.status}): ${detail}`);
  }
  return data;
}

function requireStr(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requireOwnerRepo(args) {
  const owner = requireStr(args.owner, 'owner');
  const repo = requireStr(args.repo, 'repo');
  // Keep the path segment safe: GitHub owner/repo names are [A-Za-z0-9_.-].
  for (const [label, v] of [['owner', owner], ['repo', repo]]) {
    if (!/^[A-Za-z0-9_.-]+$/.test(v)) throw new Error(`Invalid ${label}: ${v}`);
  }
  return { owner, repo };
}

function pickIssueFields(i) {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    user: i.user?.login,
    labels: (i.labels || []).map(l => l.name ?? l),
    created_at: i.created_at,
    updated_at: i.updated_at,
    html_url: i.html_url,
    body: i.body ? String(i.body).slice(0, 2000) : null,
    pull_request: !!i.pull_request,
  };
}

registerConnector({
  id: 'github',
  name: 'GitHub',
  kind: 'service',
  configSchema: {
    type: 'object',
    properties: {
      // Optional defaults so agents don't have to repeat owner/repo.
      default_owner: { type: 'string', description: 'Default repo owner' },
      default_repo: { type: 'string', description: 'Default repository name' },
    },
    additionalProperties: false,
  },
  testConnection: async ({ secrets }) => {
    const me = await ghRequest(secrets, '/user');
    return { ok: true, message: `Authenticated as ${me.login}` };
  },
  actions: {
    github_list_issues: {
      description: 'List issues for a GitHub repository (open by default).',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
        },
        required: [],
      },
      handler: async ({ config, secrets, args }) => {
        const owner = args.owner || config.default_owner;
        const repo = args.repo || config.default_repo;
        const { owner: o, repo: r } = requireOwnerRepo({ owner, repo });
        const state = ['open', 'closed', 'all'].includes(args.state) ? args.state : 'open';
        const data = await ghRequest(secrets, `/repos/${o}/${r}/issues?state=${state}&per_page=30`);
        return { issues: (Array.isArray(data) ? data : []).map(pickIssueFields) };
      },
    },

    github_get_issue: {
      description: 'Get a single GitHub issue by number.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          issue_number: { type: 'integer' },
        },
        required: ['issue_number'],
      },
      handler: async ({ config, secrets, args }) => {
        const owner = args.owner || config.default_owner;
        const repo = args.repo || config.default_repo;
        const { owner: o, repo: r } = requireOwnerRepo({ owner, repo });
        const n = parseInt(args.issue_number, 10);
        if (!Number.isInteger(n) || n <= 0) throw new Error('issue_number must be a positive integer');
        const data = await ghRequest(secrets, `/repos/${o}/${r}/issues/${n}`);
        return { issue: pickIssueFields(data) };
      },
    },

    github_list_prs: {
      description: 'List pull requests for a GitHub repository (open by default).',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
        },
        required: [],
      },
      handler: async ({ config, secrets, args }) => {
        const owner = args.owner || config.default_owner;
        const repo = args.repo || config.default_repo;
        const { owner: o, repo: r } = requireOwnerRepo({ owner, repo });
        const state = ['open', 'closed', 'all'].includes(args.state) ? args.state : 'open';
        const data = await ghRequest(secrets, `/repos/${o}/${r}/pulls?state=${state}&per_page=30`);
        return {
          pull_requests: (Array.isArray(data) ? data : []).map(pr => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            user: pr.user?.login,
            draft: !!pr.draft,
            merged: pr.merged_at != null,
            created_at: pr.created_at,
            html_url: pr.html_url,
          })),
        };
      },
    },

    github_create_issue_comment: {
      description: 'Post a comment on a GitHub issue or pull request.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          issue_number: { type: 'integer' },
          body: { type: 'string', description: 'Comment markdown body' },
        },
        required: ['issue_number', 'body'],
      },
      handler: async ({ config, secrets, args }) => {
        const owner = args.owner || config.default_owner;
        const repo = args.repo || config.default_repo;
        const { owner: o, repo: r } = requireOwnerRepo({ owner, repo });
        const n = parseInt(args.issue_number, 10);
        if (!Number.isInteger(n) || n <= 0) throw new Error('issue_number must be a positive integer');
        const body = requireStr(args.body, 'body');
        const data = await ghRequest(secrets, `/repos/${o}/${r}/issues/${n}/comments`, {
          method: 'POST',
          body: { body },
        });
        return { comment: { id: data.id, html_url: data.html_url, created_at: data.created_at } };
      },
    },
  },
});
