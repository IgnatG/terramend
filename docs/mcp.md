# Terramend MCP server (IDE integration)

`terramend mcp` starts a **local MCP server over stdio** exposing terramend's read-only Terraform
intelligence to any MCP client — Claude Code, Cursor, Windsurf. It runs entirely on your machine,
scoped to one working directory, and **holds no cloud or GitHub credentials**: it cannot push,
comment, or open PRs. (The PR-raising remediation flow stays in the GitHub Action.)

## Registration

Claude Code:

```sh
claude mcp add terramend -- npx -y terramend mcp
```

Cursor / Windsurf (`mcpServers` JSON):

```json
{
  "mcpServers": {
    "terramend": {
      "command": "npx",
      "args": ["-y", "terramend", "mcp"]
    }
  }
}
```

Pass options after `mcp` as needed: `--cwd <dir>` (workspace to scan; defaults to the directory the
client starts the server in), `--severity-threshold <critical|high|medium|low|info>`,
`--scan-scope <full|diff>`, `--module-catalogue <list>`.

## Tools exposed

| Tool | What it answers |
| --- | --- |
| `terraform_scan` | every best-practice concern (fmt/validate/tflint/trivy/checkov), grouped for remediation |
| `terraform_validate` | is the workspace well-formed + idiomatic right now (pre-PR gate) |
| `terraform_verify_remediation` | ✗→✓ proof: did the edit clear the named concerns, with regression check |
| `terraform_plan` | planned add/change/destroy, blast radius, destructive ops, plan stability (needs cloud creds) |
| `terraform_version_currency` | which providers / registry modules trail the registry's latest version |
| `infracost_diff` | monthly cost delta of the current change (needs `INFRACOST_API_KEY`) |
| `read_findings` | ingest an external findings.json / SARIF instead of scanning |
| `terraform_emit_sarif` | write the current scan as SARIF 2.1.0 |
| `list_modules` / `terraform_module_graph` / `terraform_module_interface` | module catalogue, call-graph, and a module's variables/outputs |
| `module_extraction_candidates` | clusters of raw resources that should become a module call (M2) |
| `terraform_provider_schema` | the installed provider's argument schema |
| `terraform_roots` | the Terraform roots discovered in the workspace |

Scanners that aren't installed are reported as skipped, never as failures — install
`terraform`, `tflint`, `trivy`, `checkov`, `infracost` for full coverage.

## Pairing with the HashiCorp Terraform MCP server

For live **registry knowledge** (module/provider docs, current argument shapes) run HashiCorp's
[terraform-mcp-server](https://github.com/hashicorp/terraform-mcp-server) alongside:

```sh
claude mcp add terraform -- docker run -i --rm hashicorp/terraform-mcp-server:0.5.2 --toolsets=registry
```

The pairing is deliberate: **terramend** answers questions about *your workspace* (findings,
structure, verification); **terraform-mcp-server** answers questions about *the ecosystem*
(which registry module, which provider arguments). Together they cover the module-aware
best-practice loop from the IDE.

### In the GitHub Action

The same pairing is available to the remediation agent itself — set the `terraform_mcp` input:

```yaml
- uses: terramend/terramend@v0
  with:
    mode: remediate
    terraform_mcp: "true"   # needs docker on the runner (ubuntu-latest has it)
```

The action registers the server as a second MCP endpoint next to terramend's, running the
**version-pinned** image with the read-only `registry` toolset only — no TFE operations, no
TFE token. When docker is absent the run continues with a log note (degrade-green), falling
back to `terraform_version_currency` / `terraform_provider_schema` for registry knowledge.
