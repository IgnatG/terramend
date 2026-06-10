import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "#app/mcp/server";
import { UploadFileTool } from "#app/mcp/upload";
import { apiFetch } from "#app/utils/apiFetch";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    realpathSync: vi.fn((p: unknown) => String(p)),
    readFileSync: vi.fn(() => Buffer.from("file-bytes")),
  };
});

vi.mock("file-type", () => ({
  fileTypeFromBuffer: vi.fn(async () => ({ mime: "image/png", ext: "png" })),
}));

vi.mock("#app/utils/apiFetch", () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);
const fileTypeMock = vi.mocked(fileTypeFromBuffer);
const realpathMock = vi.mocked(fs.realpathSync);

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

const REPO_ROOT = path.join(path.sep, "ws", "repo");

function makeCtx(): ToolContext {
  return { apiToken: "jwt-token" } as unknown as ToolContext;
}

function signedUrlResponse(body: Record<string, unknown>, ok = true) {
  return {
    ok,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const putFetch = vi.fn(async () => ({ ok: true, statusText: "OK" }));

beforeEach(() => {
  vi.clearAllMocks();
  realpathMock.mockImplementation((p: unknown) => String(p));
  fileTypeMock.mockResolvedValue({ mime: "image/png", ext: "png" } as never);
  vi.stubEnv("GITHUB_WORKSPACE", REPO_ROOT);
  vi.stubGlobal("fetch", putFetch);
  putFetch.mockImplementation(async () => ({ ok: true, statusText: "OK" }));
  apiFetchMock.mockResolvedValue(
    signedUrlResponse({
      uploadUrl: "https://bucket/upload?sig=1",
      publicUrl: "https://cdn/file.png",
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("UploadFileTool", () => {
  it("uploads a repo file and returns the public URL", async () => {
    const filePath = path.join(REPO_ROOT, "shot.png");
    const result = await runTool(UploadFileTool(makeCtx()), { path: filePath });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("https://cdn/file.png");
    expect(result.content[0].text).toContain("filename: shot.png");
    expect(result.content[0].text).toContain("contentType: image/png");
    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/upload/signed-url",
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }),
      }),
    );
    expect(putFetch).toHaveBeenCalledWith(
      "https://bucket/upload?sig=1",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "Content-Type": "image/png",
          "Content-Length": String(Buffer.from("file-bytes").length),
        }),
      }),
    );
  });

  it("allows files inside the OS temp dir", async () => {
    const filePath = path.join(os.tmpdir(), "scratch", "artifact.txt");
    const result = await runTool(UploadFileTool(makeCtx()), { path: filePath });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("success: true");
  });

  it("refuses to read a file outside the repo and the temp dir", async () => {
    const filePath = path.join(path.sep, "etc", "secrets", "auth.json");
    const result = await runTool(UploadFileTool(makeCtx()), { path: filePath });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("refusing to read");
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();
  });

  it("refuses to read from the .git directory", async () => {
    const filePath = path.join(REPO_ROOT, ".git", "config");
    const result = await runTool(UploadFileTool(makeCtx()), { path: filePath });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(".git directory");
  });

  it("falls back to process.cwd() when GITHUB_WORKSPACE is unset", async () => {
    vi.stubEnv("GITHUB_WORKSPACE", "");
    const filePath = path.join(process.cwd(), "inside.txt");
    const result = await runTool(UploadFileTool(makeCtx()), { path: filePath });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("success: true");
  });

  it("defaults the content type when file-type cannot detect one", async () => {
    fileTypeMock.mockResolvedValue(undefined as never);
    const filePath = path.join(REPO_ROOT, "notes.txt");
    const result = await runTool(UploadFileTool(makeCtx()), { path: filePath });

    expect(result.content[0].text).toContain("contentType: application/octet-stream");
  });

  it("sets Content-Disposition only when the API returns one", async () => {
    apiFetchMock.mockResolvedValue(
      signedUrlResponse({
        uploadUrl: "https://bucket/upload",
        publicUrl: "https://cdn/f",
        contentDisposition: "attachment",
      }),
    );
    await runTool(UploadFileTool(makeCtx()), { path: path.join(REPO_ROOT, "f.bin") });

    const headers = (putFetch.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
    expect(headers.headers["Content-Disposition"]).toBe("attachment");
  });

  it("surfaces a signed-url failure as a tool error", async () => {
    apiFetchMock.mockResolvedValue(signedUrlResponse({ error: "quota exceeded" }, false));
    const result = await runTool(UploadFileTool(makeCtx()), {
      path: path.join(REPO_ROOT, "f.bin"),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("failed to get upload URL");
    expect(putFetch).not.toHaveBeenCalled();
  });

  it("surfaces a failed PUT upload as a tool error", async () => {
    putFetch.mockImplementation(async () => ({ ok: false, statusText: "Forbidden" }));
    const result = await runTool(UploadFileTool(makeCtx()), {
      path: path.join(REPO_ROOT, "f.bin"),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("failed to upload file: Forbidden");
  });
});
