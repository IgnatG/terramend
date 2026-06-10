import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PayloadEvent } from "#app/external";
import { resolveBody, resolveBodyAssets } from "#app/utils/body";
import type { OctokitWithPlugins } from "#app/utils/github";
import type { RunContextData } from "#app/utils/runContextData";

vi.mock("#app/utils/assets", () => ({
  // echo the markdown back with a marker so call-through is observable
  downloadAssetsInMarkdown: vi.fn(async (markdown: string) => `downloaded:${markdown}`),
}));

import { downloadAssetsInMarkdown } from "#app/utils/assets";

const downloadMock = vi.mocked(downloadAssetsInMarkdown);

const repo = { owner: "acme", name: "infra" } as RunContextData["repo"];

function makeOctokit() {
  const issuesGetComment = vi.fn(async () => ({ data: { body_html: "<p>comment html</p>" } }));
  const issuesGet = vi.fn(async () => ({ data: { body_html: "<p>issue html</p>" } }));
  const pullsGetReview = vi.fn(async () => ({ data: { body_html: "<p>review html</p>" } }));
  const pullsGetReviewComment = vi.fn(async () => ({
    data: { body_html: "<p>review comment html</p>" },
  }));
  const octokit = {
    rest: {
      issues: { getComment: issuesGetComment, get: issuesGet },
      pulls: { getReview: pullsGetReview, getReviewComment: pullsGetReviewComment },
    },
  } as unknown as OctokitWithPlugins;
  return { octokit, issuesGetComment, issuesGet, pullsGetReview, pullsGetReviewComment };
}

function ctxFor(event: Record<string, unknown>, octokit: OctokitWithPlugins) {
  return {
    event: event as unknown as PayloadEvent,
    octokit,
    repo,
    tmpdir: "/tmp/run",
    githubToken: "tok",
  };
}

const IMG_BODY = "look: ![shot](https://github.com/user-attachments/assets/abc)";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveBodyAssets", () => {
  it("returns null for a missing body", async () => {
    await expect(
      resolveBodyAssets({ body: null, bodyHtml: undefined, tmpdir: "/t", githubToken: "x" }),
    ).resolves.toBeNull();
    await expect(
      resolveBodyAssets({ body: undefined, bodyHtml: "<p>hi</p>", tmpdir: "/t", githubToken: "x" }),
    ).resolves.toBeNull();
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("downloads assets for a plain markdown body without conversion", async () => {
    const result = await resolveBodyAssets({
      body: "no images here",
      bodyHtml: "<p>ignored</p>",
      tmpdir: "/t",
      githubToken: "x",
    });
    expect(result).toBe("downloaded:no images here");
    expect(downloadMock).toHaveBeenCalledWith("no images here", "/t", "x");
  });

  it("converts body_html to markdown when the body has images", async () => {
    const result = await resolveBodyAssets({
      body: IMG_BODY,
      bodyHtml: '<p>see <img src="https://signed.example/img.png" alt="shot"></p>',
      tmpdir: "/t",
      githubToken: "x",
    });
    expect(result).toContain("downloaded:");
    expect(result).toContain("https://signed.example/img.png");
    expect(result).not.toContain("user-attachments");
  });

  it("keeps the raw body when it has images but no rendered html", async () => {
    const result = await resolveBodyAssets({
      body: IMG_BODY,
      bodyHtml: undefined,
      tmpdir: "/t",
      githubToken: "x",
    });
    expect(result).toBe(`downloaded:${IMG_BODY}`);
  });
});

describe("resolveBody", () => {
  it("does not fetch body_html when the body has no images", async () => {
    const { octokit, issuesGet, issuesGetComment } = makeOctokit();
    const result = await resolveBody(
      ctxFor({ trigger: "issues_opened", issue_number: 3, body: "plain text" }, octokit),
    );
    expect(result).toBe("downloaded:plain text");
    expect(issuesGet).not.toHaveBeenCalled();
    expect(issuesGetComment).not.toHaveBeenCalled();
  });

  it("fetches comment html for issue_comment_created", async () => {
    const { octokit, issuesGetComment } = makeOctokit();
    const result = await resolveBody(
      ctxFor({ trigger: "issue_comment_created", comment_id: 11, body: IMG_BODY }, octokit),
    );
    expect(issuesGetComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "infra",
        comment_id: 11,
        headers: { accept: "application/vnd.github.full+json" },
      }),
    );
    expect(result).toBe("downloaded:comment html");
  });

  it("returns undefined html when issue_comment_created lacks a comment id", async () => {
    const { octokit, issuesGetComment } = makeOctokit();
    const result = await resolveBody(
      ctxFor({ trigger: "issue_comment_created", body: IMG_BODY }, octokit),
    );
    expect(issuesGetComment).not.toHaveBeenCalled();
    expect(result).toBe(`downloaded:${IMG_BODY}`);
  });

  it.each([
    "issues_opened",
    "issues_assigned",
    "issues_labeled",
  ])("fetches the issue html for %s", async (trigger) => {
    const { octokit, issuesGet } = makeOctokit();
    const result = await resolveBody(ctxFor({ trigger, issue_number: 5, body: IMG_BODY }, octokit));
    expect(issuesGet).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 5 }));
    expect(result).toBe("downloaded:issue html");
  });

  it.each([
    "pull_request_opened",
    "pull_request_ready_for_review",
    "pull_request_synchronize",
    "pull_request_review_requested",
    "check_suite_completed",
  ])("fetches the PR body html via issues.get for %s", async (trigger) => {
    const { octokit, issuesGet } = makeOctokit();
    const result = await resolveBody(ctxFor({ trigger, issue_number: 9, body: IMG_BODY }, octokit));
    expect(issuesGet).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 9 }));
    expect(result).toBe("downloaded:issue html");
  });

  it("fetches the review html for pull_request_review_submitted", async () => {
    const { octokit, pullsGetReview } = makeOctokit();
    const result = await resolveBody(
      ctxFor(
        {
          trigger: "pull_request_review_submitted",
          issue_number: 9,
          review_id: 21,
          body: IMG_BODY,
        },
        octokit,
      ),
    );
    expect(pullsGetReview).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 9, review_id: 21 }),
    );
    expect(result).toBe("downloaded:review html");
  });

  it("skips the fetch when pull_request_review_submitted lacks a review id", async () => {
    const { octokit, pullsGetReview } = makeOctokit();
    await resolveBody(
      ctxFor(
        { trigger: "pull_request_review_submitted", issue_number: 9, body: IMG_BODY },
        octokit,
      ),
    );
    expect(pullsGetReview).not.toHaveBeenCalled();
  });

  it("fetches the review comment html for pull_request_review_comment_created", async () => {
    const { octokit, pullsGetReviewComment } = makeOctokit();
    const result = await resolveBody(
      ctxFor(
        { trigger: "pull_request_review_comment_created", comment_id: 31, body: IMG_BODY },
        octokit,
      ),
    );
    expect(pullsGetReviewComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 31 }));
    expect(result).toBe("downloaded:review comment html");
  });

  it("fetches the plan comment html for implement_plan", async () => {
    const { octokit, issuesGetComment } = makeOctokit();
    const result = await resolveBody(
      ctxFor({ trigger: "implement_plan", plan_comment_id: 41, body: IMG_BODY }, octokit),
    );
    expect(issuesGetComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 41 }));
    expect(result).toBe("downloaded:comment html");
  });

  it.each([
    "workflow_dispatch",
    "fix_review",
    "unknown",
  ])("never fetches html for bodyless trigger %s", async (trigger) => {
    const { octokit, issuesGet, issuesGetComment } = makeOctokit();
    const result = await resolveBody(ctxFor({ trigger, body: IMG_BODY }, octokit));
    expect(issuesGet).not.toHaveBeenCalled();
    expect(issuesGetComment).not.toHaveBeenCalled();
    expect(result).toBe(`downloaded:${IMG_BODY}`);
  });
});
