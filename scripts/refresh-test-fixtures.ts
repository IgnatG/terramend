#!/usr/bin/env node
/**
 * refresh checked-in test fixtures for mcp/checkout.test.ts and
 * mcp/reviewComments.test.ts.
 *
 * those tests used to hit live GitHub on every run, which made them
 * cred-gated (GH_TOKEN or GITHUB_APP_ID + GITHUB_PRIVATE_KEY) and
 * non-deterministic. they now read from action/mcp/__fixtures__/*.json,
 * which this script regenerates on demand.
 *
 * run with creds set (locally via .env, or in a CI cron with secrets):
 *
 *   GH_TOKEN=… node action/scripts/refresh-test-fixtures.ts
 *   # or
 *   GITHUB_APP_ID=… GITHUB_PRIVATE_KEY=… node action/scripts/refresh-test-fixtures.ts
 *
 * commit the resulting fixture changes; review the diff before merging
 * (anything unexpected indicates real GitHub API drift).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Octokit } from "@octokit/rest";
import { config as loadDotenv } from "dotenv";
import {
  REVIEW_THREADS_QUERY,
  type ReviewThread,
  type ReviewThreadsQueryResponse,
} from "#app/mcp/reviewComments";
import { acquireNewToken } from "#app/utils/github";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const fixturesDir = resolve(scriptDir, "../src/mcp/__fixtures__");

loadDotenv({ path: resolve(repoRoot, ".env") });

type DiffFixture = {
  owner: string;
  name: string;
  pullNumber: number;
  files: unknown;
};

type ReviewFixture = {
  owner: string;
  name: string;
  pullNumber: number;
  reviewId: number;
  review: { body: string | null | undefined; user: { login: string } | null | undefined };
  threads: ReviewThread[];
  prFiles: Array<{ filename: string; patch?: string | undefined }>;
};

const DIFF_TARGETS: Array<Pick<DiffFixture, "owner" | "name" | "pullNumber">> = [
  { owner: "terramend", name: "test-repo", pullNumber: 1 },
];

const REVIEW_TARGETS: Array<Pick<ReviewFixture, "owner" | "name" | "pullNumber" | "reviewId">> = [
  { owner: "terramend", name: "scratch", pullNumber: 49, reviewId: 3485940013 },
  { owner: "terramend", name: "scratch", pullNumber: 64, reviewId: 3531000326 },
];

async function getToken(): Promise<string> {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  return await acquireNewToken();
}

async function refreshDiffFixture(
  octokit: Octokit,
  target: (typeof DIFF_TARGETS)[number]
): Promise<void> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: target.owner,
    repo: target.name,
    pull_number: target.pullNumber,
    per_page: 100,
  });
  const fixture: DiffFixture = { ...target, files };
  const path = resolve(
    fixturesDir,
    `${target.owner}-${target.name}-pr-${target.pullNumber}.diff.json`
  );
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path}`);
}

async function refreshReviewFixture(
  octokit: Octokit,
  target: (typeof REVIEW_TARGETS)[number]
): Promise<void> {
  const [review, threadsResp] = await Promise.all([
    octokit.rest.pulls.getReview({
      owner: target.owner,
      repo: target.name,
      pull_number: target.pullNumber,
      review_id: target.reviewId,
    }),
    octokit.graphql<ReviewThreadsQueryResponse>(REVIEW_THREADS_QUERY, {
      owner: target.owner,
      name: target.name,
      prNumber: target.pullNumber,
    }),
  ]);

  const allThreads = threadsResp.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const threads = allThreads.filter((thread): thread is ReviewThread => {
    if (!thread?.comments?.nodes) return false;
    return thread.comments.nodes.some((c) => c?.pullRequestReview?.databaseId === target.reviewId);
  });

  // skip listFiles entirely when there are no threads — prFiles is only
  // used for thread blocks, so an empty array short-circuits in the
  // formatter. mirrors getReviewData's runtime perf optimization and
  // keeps body-only-review fixtures small.
  const prFiles =
    threads.length > 0
      ? await octokit.paginate(octokit.rest.pulls.listFiles, {
          owner: target.owner,
          repo: target.name,
          pull_number: target.pullNumber,
          per_page: 100,
        })
      : [];

  // strip prFiles down to the fields the formatter actually reads. keeps
  // fixtures small and avoids capturing volatile fields (sha, blob_url,
  // contents_url, etc.) that would churn unrelated to formatter behavior.
  const trimmedFiles = prFiles.map((f) => ({
    filename: f.filename,
    ...(f.patch ? { patch: f.patch } : {}),
  }));

  const fixture: ReviewFixture = {
    ...target,
    review: {
      body: review.data.body,
      user: review.data.user ? { login: review.data.user.login } : null,
    },
    threads,
    prFiles: trimmedFiles,
  };
  const path = resolve(
    fixturesDir,
    `${target.owner}-${target.name}-pr-${target.pullNumber}-review-${target.reviewId}.json`
  );
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path}`);
}

async function main(): Promise<void> {
  const token = await getToken();
  const octokit = new Octokit({ auth: token });
  mkdirSync(fixturesDir, { recursive: true });

  for (const t of DIFF_TARGETS) await refreshDiffFixture(octokit, t);
  for (const t of REVIEW_TARGETS) await refreshReviewFixture(octokit, t);
}

await main();
