# Supported models

<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with `pnpm docs:models` after changing src/models.ts. -->

Terramend resolves models through the curated alias registry in
[`src/models.ts`](../src/models.ts). Users select a model by **alias slug**
(e.g. `anthropic/claude-fable`), which resolves to a concrete model id —
so version bumps happen in the catalog, not in every workflow file.

## How model selection works

The effective model for a run is resolved with this priority:

1. **`TERRAMEND_MODEL` env var** — highest priority, an escape hatch that
   overrides everything (including Bedrock/Vertex routing). Accepts an alias
   slug or a raw specifier.
2. **Dispatch payload `model`** — set per-run by `workflow_dispatch` JSON.
3. **Action input `model:`** — the `with: model:` value in the workflow.
4. **Repo settings `model`** — the stored per-repo default.
5. **Auto-select** — when none of the above is set, the agent introspects
   which models the available API keys can actually route (`opencode models`)
   and picks the first match: a `preferred` alias if its provider key is
   present, otherwise the first routable alias in catalog order.

So: **providing only an API key (no model) gets you that provider's
`preferred` model**; specifying a model explicitly always wins.

Unknown slugs log a warning and fall through to auto-select. If a provider
key is present but the requested model is not routable with it, the run
fails loudly with the list of models the key can serve. If **no** key is
present at all, the run falls back to the free model so it still produces
value.

### Agent harness routing

- `anthropic/*` models with Claude Code auth (`ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN`) run on the **Claude Code** harness.
- Everything else runs on the **OpenCode** harness.
- `TERRAMEND_AGENT=claude|opencode` overrides the routing.

## Anthropic (`anthropic/`)

Env vars: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`.

| Slug | Display name | Resolves to | OpenRouter route | Notes |
| ---- | ------------ | ----------- | ---------------- | ----- |
| `anthropic/claude-fable` | Claude Fable | `anthropic/claude-fable-5` | — | **preferred** (auto-select pick); review subagents run on `anthropic/claude-sonnet` |
| `anthropic/claude-opus` | Claude Opus | `anthropic/claude-opus-4-8` | `openrouter/anthropic/claude-opus-4.8` | review subagents run on `anthropic/claude-sonnet` |
| `anthropic/claude-sonnet` | Claude Sonnet | `anthropic/claude-sonnet-4-6` | `openrouter/anthropic/claude-sonnet-4.6` | — |
| `anthropic/claude-haiku` | Claude Haiku | `anthropic/claude-haiku-4-5` | `openrouter/anthropic/claude-haiku-4.5` | — |

## OpenAI (`openai/`)

Env vars: `OPENAI_API_KEY`. CLI-managed: `CODEX_AUTH_JSON`.

| Slug | Display name | Resolves to | OpenRouter route | Notes |
| ---- | ------------ | ----------- | ---------------- | ----- |
| `openai/gpt` | GPT | `openai/gpt-5.5` | `openrouter/openai/gpt-5.5` | **preferred** (auto-select pick); review subagents run on `openai/gpt-5.4` |
| `openai/gpt-pro` | GPT Pro | `openai/gpt-5.5-pro` | `openrouter/openai/gpt-5.5-pro` | review subagents run on `openai/gpt` |
| `openai/gpt-5.4` | GPT 5.4 | `openai/gpt-5.4` | `openrouter/openai/gpt-5.4` | hidden — internal subagent target, not user-selectable |
| `openai/gpt-mini` | GPT Mini | `openai/gpt-5.4-mini` | `openrouter/openai/gpt-5.4-mini` | — |
| `openai/gpt-codex` | GPT Codex | `openai/gpt-5.3-codex` | `openrouter/openai/gpt-5.3-codex` | deprecated — resolves via `openai/gpt` |
| `openai/gpt-codex-mini` | GPT Codex Mini | `openai/gpt-5.1-codex-mini` | `openrouter/openai/gpt-5.1-codex-mini` | deprecated — resolves via `openai/gpt-mini` |
| `openai/o3` | O3 | `openai/o3` | `openrouter/openai/o3` | — |

## Google (`google/`)

Env vars: `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`.

| Slug | Display name | Resolves to | OpenRouter route | Notes |
| ---- | ------------ | ----------- | ---------------- | ----- |
| `google/gemini-pro` | Gemini Pro | `google/gemini-3.1-pro-preview` | `openrouter/google/gemini-3.1-pro-preview` | **preferred** (auto-select pick) |
| `google/gemini-flash` | Gemini Flash | `google/gemini-3.5-flash` | `openrouter/google/gemini-3.5-flash` | — |

## xAI (`xai/`)

Env vars: `XAI_API_KEY`.

| Slug | Display name | Resolves to | OpenRouter route | Notes |
| ---- | ------------ | ----------- | ---------------- | ----- |
| `xai/grok` | Grok | `xai/grok-4.3` | `openrouter/x-ai/grok-4.3` | **preferred** (auto-select pick) |
| `xai/grok-fast` | Grok Fast | `xai/grok-4-1-fast` | `openrouter/x-ai/grok-4.3` | deprecated — resolves via `xai/grok` |
| `xai/grok-code-fast` | Grok Code Fast | `xai/grok-code-fast-1` | `openrouter/x-ai/grok-4.3` | deprecated — resolves via `xai/grok` |

## DeepSeek (`deepseek/`)

Env vars: `DEEPSEEK_API_KEY`.

| Slug | Display name | Resolves to | OpenRouter route | Notes |
| ---- | ------------ | ----------- | ---------------- | ----- |
| `deepseek/deepseek-pro` | DeepSeek Pro | `deepseek/deepseek-v4-pro` | `openrouter/deepseek/deepseek-v4-pro` | **preferred** (auto-select pick) |
| `deepseek/deepseek-flash` | DeepSeek Flash | `deepseek/deepseek-v4-flash` | `openrouter/deepseek/deepseek-v4-flash` | — |
| `deepseek/deepseek-reasoner` | DeepSeek Reasoner | `deepseek/deepseek-reasoner` | `openrouter/deepseek/deepseek-v3.2` | deprecated — resolves via `deepseek/deepseek-pro` |
| `deepseek/deepseek-chat` | DeepSeek Chat | `deepseek/deepseek-chat` | `openrouter/deepseek/deepseek-v3.2` | deprecated — resolves via `deepseek/deepseek-flash` |

## Moonshot AI (`moonshotai/`)

Env vars: `MOONSHOT_API_KEY`.

| Slug | Display name | Resolves to | OpenRouter route | Notes |
| ---- | ------------ | ----------- | ---------------- | ----- |
| `moonshotai/kimi-k2` | Kimi K2 | `moonshotai/kimi-k2.6` | `openrouter/moonshotai/kimi-k2.6` | **preferred** (auto-select pick) |

## OpenCode (`opencode/`)

Env vars: `OPENCODE_API_KEY`.

| Slug | Display name | Resolves to | OpenRouter route | Notes |
| ---- | ------------ | ----------- | ---------------- | ----- |
| `opencode/big-pickle` | Big Pickle | `opencode/big-pickle` | — | **preferred** (auto-select pick); free — no API key required |
| `opencode/claude-opus` | Claude Opus | `opencode/claude-opus-4-8` | `openrouter/anthropic/claude-opus-4.8` | review subagents run on `opencode/claude-sonnet` |
| `opencode/claude-sonnet` | Claude Sonnet | `opencode/claude-sonnet-4-6` | `openrouter/anthropic/claude-sonnet-4.6` | — |
| `opencode/claude-haiku` | Claude Haiku | `opencode/claude-haiku-4-5` | `openrouter/anthropic/claude-haiku-4.5` | — |
| `opencode/gpt` | GPT | `opencode/gpt-5.5` | `openrouter/openai/gpt-5.5` | review subagents run on `opencode/gpt-5.4` |
| `opencode/gpt-pro` | GPT Pro | `opencode/gpt-5.5-pro` | `openrouter/openai/gpt-5.5-pro` | review subagents run on `opencode/gpt` |
| `opencode/gpt-5.4` | GPT 5.4 | `opencode/gpt-5.4` | `openrouter/openai/gpt-5.4` | hidden — internal subagent target, not user-selectable |
| `opencode/gpt-mini` | GPT Mini | `opencode/gpt-5.4-mini` | `openrouter/openai/gpt-5.4-mini` | — |
| `opencode/gpt-codex` | GPT Codex | `opencode/gpt-5.3-codex` | `openrouter/openai/gpt-5.3-codex` | deprecated — resolves via `opencode/gpt` |
| `opencode/gpt-codex-mini` | GPT Codex Mini | `opencode/gpt-5.1-codex-mini` | `openrouter/openai/gpt-5.1-codex-mini` | deprecated — resolves via `opencode/gpt-mini` |
| `opencode/gemini-pro` | Gemini Pro | `opencode/gemini-3.1-pro` | `openrouter/google/gemini-3.1-pro-preview` | — |
| `opencode/gemini-flash` | Gemini Flash | `opencode/gemini-3.5-flash` | `openrouter/google/gemini-3.5-flash` | — |
| `opencode/kimi-k2` | Kimi K2 | `opencode/kimi-k2.6` | `openrouter/moonshotai/kimi-k2.6` | — |
| `opencode/minimax-m2.5` | MiniMax M2.5 | `opencode/minimax-m2.5` | `openrouter/minimax/minimax-m2.5` | — |
| `opencode/gpt-5-nano` | GPT Nano | `opencode/gpt-5-nano` | `openrouter/openai/gpt-5-nano` | — |
| `opencode/mimo-v2-pro-free` | MiMo V2 Pro | `opencode/mimo-v2-pro-free` | — | free — no API key required; deprecated — resolves via `opencode/big-pickle` |
| `opencode/minimax-m2.5-free` | MiniMax M2.5 | `opencode/minimax-m2.5-free` | — | free — no API key required; hidden — internal subagent target, not user-selectable; deprecated — resolves via `opencode/big-pickle` |

## Amazon Bedrock (`bedrock/`)

Env vars: `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION`, `BEDROCK_MODEL_ID`.

| Slug | Display name | Resolves to | OpenRouter route | Notes |
| ---- | ------------ | ----------- | ---------------- | ----- |
| `bedrock/byok` | Amazon Bedrock | _(from env)_ | — | routing entry — model id read from env (see below) |

## Google Vertex AI (`vertex/`)

Env vars: `VERTEX_SERVICE_ACCOUNT_JSON`, `GOOGLE_CLOUD_PROJECT`, `VERTEX_LOCATION`, `VERTEX_MODEL_ID`.

| Slug | Display name | Resolves to | OpenRouter route | Notes |
| ---- | ------------ | ----------- | ---------------- | ----- |
| `vertex/byok` | Google Vertex AI | _(from env)_ | — | routing entry — model id read from env (see below) |

## OpenRouter (`openrouter/`)

Env vars: `OPENROUTER_API_KEY`.

| Slug | Display name | Resolves to | OpenRouter route | Notes |
| ---- | ------------ | ----------- | ---------------- | ----- |
| `openrouter/claude-opus` | Claude Opus | `openrouter/anthropic/claude-opus-4.8` | `openrouter/anthropic/claude-opus-4.8` | **preferred** (auto-select pick); review subagents run on `openrouter/claude-sonnet` |
| `openrouter/claude-sonnet` | Claude Sonnet | `openrouter/anthropic/claude-sonnet-4.6` | `openrouter/anthropic/claude-sonnet-4.6` | — |
| `openrouter/claude-haiku` | Claude Haiku | `openrouter/anthropic/claude-haiku-4.5` | `openrouter/anthropic/claude-haiku-4.5` | — |
| `openrouter/gpt` | GPT | `openrouter/openai/gpt-5.5` | `openrouter/openai/gpt-5.5` | review subagents run on `openrouter/gpt-5.4` |
| `openrouter/gpt-pro` | GPT Pro | `openrouter/openai/gpt-5.5-pro` | `openrouter/openai/gpt-5.5-pro` | review subagents run on `openrouter/gpt` |
| `openrouter/gpt-5.4` | GPT 5.4 | `openrouter/openai/gpt-5.4` | `openrouter/openai/gpt-5.4` | hidden — internal subagent target, not user-selectable |
| `openrouter/gpt-mini` | GPT Mini | `openrouter/openai/gpt-5.4-mini` | `openrouter/openai/gpt-5.4-mini` | — |
| `openrouter/gpt-codex` | GPT Codex | `openrouter/openai/gpt-5.3-codex` | `openrouter/openai/gpt-5.3-codex` | deprecated — resolves via `openrouter/gpt` |
| `openrouter/gpt-codex-mini` | GPT Codex Mini | `openrouter/openai/gpt-5.1-codex-mini` | `openrouter/openai/gpt-5.1-codex-mini` | deprecated — resolves via `openrouter/gpt-mini` |
| `openrouter/o4-mini` | O4 Mini | `openrouter/openai/o4-mini` | `openrouter/openai/o4-mini` | — |
| `openrouter/gemini-pro` | Gemini Pro | `openrouter/google/gemini-3.1-pro-preview` | `openrouter/google/gemini-3.1-pro-preview` | — |
| `openrouter/gemini-flash` | Gemini Flash | `openrouter/google/gemini-3.5-flash` | `openrouter/google/gemini-3.5-flash` | — |
| `openrouter/grok` | Grok | `openrouter/x-ai/grok-4.3` | `openrouter/x-ai/grok-4.3` | — |
| `openrouter/deepseek-pro` | DeepSeek Pro | `openrouter/deepseek/deepseek-v4-pro` | `openrouter/deepseek/deepseek-v4-pro` | — |
| `openrouter/deepseek-flash` | DeepSeek Flash | `openrouter/deepseek/deepseek-v4-flash` | `openrouter/deepseek/deepseek-v4-flash` | — |
| `openrouter/deepseek-chat` | DeepSeek Chat | `openrouter/deepseek/deepseek-v3.2` | `openrouter/deepseek/deepseek-v3.2` | deprecated — resolves via `openrouter/deepseek-flash` |
| `openrouter/kimi-k2` | Kimi K2 | `openrouter/moonshotai/kimi-k2.6` | `openrouter/moonshotai/kimi-k2.6` | — |
| `openrouter/minimax-m2.5` | MiniMax M2.5 | `openrouter/minimax/minimax-m2.5` | `openrouter/minimax/minimax-m2.5` | — |

## Routing entries (Bedrock / Vertex)

`bedrock/byok` and `vertex/byok` are **routing** aliases: instead of a fixed
model id, they read the concrete id from a per-run env var —
`BEDROCK_MODEL_ID` (an AWS Bedrock model id, e.g.
`eu.anthropic.claude-opus-4-8`) or `VERTEX_MODEL_ID` (a Vertex Model Garden
id). Anthropic ids route to the Claude Code harness; everything else goes
through OpenCode's `amazon-bedrock` / `google-vertex` provider.

