import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadAssetsInMarkdown } from "#app/utils/assets";

const TOKEN = "ghs_assets_test_token";

type FetchResponseSpec = {
  ok?: boolean;
  status?: number;
  contentType?: string | null;
  body?: string;
};

function makeResponse(spec: FetchResponseSpec = {}): Response {
  const body = spec.body ?? "binary-bytes";
  const headers = new Headers();
  if (spec.contentType) headers.set("content-type", spec.contentType);
  return {
    ok: spec.ok ?? true,
    status: spec.status ?? 200,
    headers,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "terramend-assets-test-"));
  fetchMock = vi.fn(async () => makeResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("downloadAssetsInMarkdown", () => {
  it("returns the markdown unchanged and skips fetch when no asset urls are present", async () => {
    const markdown = "plain text ![alt](https://example.com/image.png) not a github asset";
    const result = await downloadAssetsInMarkdown(markdown, dir, TOKEN);
    expect(result).toBe(markdown);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads a github.com asset with the installation token and rewrites the url", async () => {
    const url = "https://github.com/user-attachments/assets/abc-123";
    fetchMock.mockResolvedValueOnce(makeResponse({ contentType: "image/png", body: "png-data" }));

    const result = await downloadAssetsInMarkdown(`before ![shot](${url}) after`, dir, TOKEN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(url);
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });

    expect(result).not.toContain(url);
    const localPathMatch = /!\[shot\]\((.+)\)/.exec(result);
    expect(localPathMatch).not.toBeNull();
    const localPath = localPathMatch?.[1] ?? "";
    expect(localPath.startsWith(path.join(dir, "assets"))).toBe(true);
    expect(localPath.endsWith(".png")).toBe(true);
    expect(readFileSync(localPath, "utf-8")).toBe("png-data");
  });

  it("fetches signed CDN urls WITHOUT an Authorization header", async () => {
    const url = "https://private-user-images.githubusercontent.com/1/2.png?jwt=sig";
    await downloadAssetsInMarkdown(`![cdn](${url})`, dir, TOKEN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({});
  });

  it("extracts urls from html <img> tags and owner/repo asset paths", async () => {
    const url = "https://github.com/octo/repo/assets/99/deadbeef.gif";
    const markdown = `<p><img alt="x" src="${url}"></p>`;
    const result = await downloadAssetsInMarkdown(markdown, dir, TOKEN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).not.toContain(url);
  });

  it("downloads each unique url once and rewrites every occurrence", async () => {
    const url = "https://github.com/user-attachments/assets/dup-1.png";
    const markdown = `![a](${url})\n![b](${url})\n<img src="${url}">`;
    const result = await downloadAssetsInMarkdown(markdown, dir, TOKEN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).not.toContain(url);
  });

  it("leaves the url untouched when the download responds non-ok", async () => {
    const url = "https://github.com/user-attachments/assets/missing.png";
    fetchMock.mockResolvedValueOnce(makeResponse({ ok: false, status: 404 }));

    const result = await downloadAssetsInMarkdown(`![x](${url})`, dir, TOKEN);
    expect(result).toContain(url);
  });

  it("leaves the url untouched when fetch throws", async () => {
    const url = "https://github.com/user-attachments/assets/error.png";
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const result = await downloadAssetsInMarkdown(`![x](${url})`, dir, TOKEN);
    expect(result).toContain(url);
  });
});

describe("extension resolution", () => {
  async function localPathFor(url: string, contentType: string | null): Promise<string> {
    fetchMock.mockResolvedValueOnce(makeResponse({ contentType }));
    const result = await downloadAssetsInMarkdown(`![x](${url})`, dir, TOKEN);
    const match = /!\[x\]\((.+)\)/.exec(result);
    expect(match).not.toBeNull();
    return match?.[1] ?? "";
  }

  const base = "https://github.com/user-attachments/assets";

  it("keeps a whitelisted extension from the url path", async () => {
    expect(await localPathFor(`${base}/clip.webm`, null)).toMatch(/\.webm$/);
  });

  it("normalizes .jpeg in the url path to .jpg", async () => {
    expect(await localPathFor(`${base}/photo.jpeg`, null)).toMatch(/\.jpg$/);
  });

  it.each([
    ["image/jpeg", ".jpg"],
    ["image/gif", ".gif"],
    ["image/webp", ".webp"],
    ["image/svg+xml", ".svg"],
    ["video/mp4", ".mp4"],
    ["video/quicktime", ".mov"],
    ["video/webm", ".webm"],
  ])("derives %s from the response content-type as %s", async (contentType, ext) => {
    const localPath = await localPathFor(`${base}/raw-${ext.slice(1)}`, contentType);
    expect(localPath.endsWith(ext)).toBe(true);
  });

  it("defaults to .png when neither path nor content-type resolve", async () => {
    expect(await localPathFor(`${base}/opaque-blob`, "application/octet-stream")).toMatch(/\.png$/);
  });

  it("defaults to .png when the response has no content-type header at all", async () => {
    expect(await localPathFor(`${base}/headerless-blob`, null)).toMatch(/\.png$/);
  });
});
