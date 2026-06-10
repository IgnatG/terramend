import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "arktype";
import { fileTypeFromBuffer } from "file-type";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool } from "#app/mcp/shared";
import { apiFetch } from "#app/utils/apiFetch";
import { log } from "#app/utils/cli";

const UploadFileParams = type({
  path: type.string.describe(
    "absolute path to a file inside the repo working tree or the temp dir",
  ),
});

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve and validate an upload path. `upload_file` returns a permanent PUBLIC
 * URL, so an unconstrained read is a one-shot secret-exfiltration primitive
 * under prompt injection (auth.json, materialized cloud-credential JSON,
 * $GITHUB_EVENT_PATH, …). Constrain reads to the repo working tree or the OS
 * temp dir (where agents scratch screenshots/artifacts), and never the `.git`
 * dir. realpath both sides so symlinks can't escape the boundary.
 */
function resolveUploadPath(requested: string): string {
  const real = fs.realpathSync(requested);
  const repoRoot = fs.realpathSync(process.env.GITHUB_WORKSPACE || process.cwd());
  const tmpRoot = fs.realpathSync(os.tmpdir());

  const inRepo = isWithin(real, repoRoot);
  const inTmp = isWithin(real, tmpRoot);
  if (!inRepo && !inTmp) {
    throw new Error(
      `upload_file: refusing to read '${requested}' — only files inside the repo ` +
        `working tree or the temp dir may be uploaded.`,
    );
  }
  if (inRepo && isWithin(real, path.join(repoRoot, ".git"))) {
    throw new Error("upload_file: refusing to read from the .git directory.");
  }
  return real;
}

export function UploadFileTool(ctx: ToolContext) {
  return tool({
    name: "upload_file",
    description:
      "upload a file to get a permanent public URL. use for screenshots, artifacts, or any files you want to reference in PRs/comments. max 10MB, images/text/archives allowed. when embedding uploaded images in comments or PR bodies, always use markdown image syntax: ![description](url)",
    parameters: UploadFileParams,
    execute: execute(async (params) => {
      // validate + resolve the path before reading: upload_file yields a
      // permanent public URL, so an unconstrained read is an exfiltration sink.
      const safePath = resolveUploadPath(params.path);
      // read file from disk eagerly on purpose to avoid its content being changed by the time it's uploaded
      const buffer = fs.readFileSync(safePath);
      const filename = path.basename(safePath);
      const contentLength = buffer.length;

      const fileType = await fileTypeFromBuffer(buffer);
      const contentType = fileType?.mime || "application/octet-stream";

      const response = await apiFetch({
        path: "/api/upload/signed-url",
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filename,
          contentType,
          contentLength,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`failed to get upload URL: ${error}`);
      }

      const { uploadUrl, publicUrl, contentDisposition } = (await response.json()) as {
        uploadUrl: string;
        publicUrl: string;
        contentDisposition?: string | undefined;
      };

      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          // should be set automatically, but given this header is signed it's better to be explicit
          "Content-Length": String(contentLength),
          ...(contentDisposition && { "Content-Disposition": contentDisposition }),
        },
        body: buffer,
      });

      if (!uploadResponse.ok) {
        throw new Error(`failed to upload file: ${uploadResponse.statusText}`);
      }

      log.info(`» uploaded file ${publicUrl}`);

      return { success: true, publicUrl, filename, contentLength, contentType };
    }),
  });
}
