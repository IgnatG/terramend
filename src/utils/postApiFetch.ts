/** stdlib-only Terramend API fetch for entryPost.ts (no node_modules). */

type PostApiFetchOptions = {
  path: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
};

function getApiUrl(): string {
  return process.env.API_URL || "https://terramend.com";
}

export async function postApiFetch(options: PostApiFetchOptions): Promise<Response> {
  const url = new URL(options.path, getApiUrl());

  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    url.searchParams.set("x-vercel-protection-bypass", bypassSecret);
  }

  const headers: Record<string, string> = {
    ...options.headers,
  };

  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  if (!options.body) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-type") delete headers[key];
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
      signal: controller.signal,
    };
    if (options.body) init.body = options.body;

    return await fetch(url, init);
  } finally {
    clearTimeout(timeoutId);
  }
}
