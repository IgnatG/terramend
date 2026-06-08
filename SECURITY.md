# Security Policy

Terramend runs AI coding agents with write access to repositories and CI
secrets, and is positioned for security- and compliance-sensitive (incl.
UK/EU public-sector) use. We take vulnerability reports seriously.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately via GitHub's [private vulnerability reporting](https://github.com/terramend/terramend/security/advisories/new)
(Security → Report a vulnerability), or email **security@terramend.dev**.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal workflow/repo is ideal).
- Affected version / action ref (tag or commit SHA).
- Any logs or proof-of-concept (redact secrets).

## What to expect

- **Acknowledgement** within 3 working days.
- **Triage + initial assessment** within 10 working days.
- A coordinated **disclosure timeline** agreed with you; we aim to ship a fix
  and publish a GitHub Security Advisory (with credit, if you wish) within 90
  days, sooner for actively-exploited issues.

## Scope

In scope: the action runtime, the MCP tool surface, the dependency-bootstrap
path, the guardrails (push/shell/secret/path enforcement), and the credential
handling in CI. Out of scope: vulnerabilities in third-party scanners
(`terraform`, `tflint`, `trivy`, `checkov`, …) or LLM providers — report those
upstream, though we welcome a heads-up if Terramend's use amplifies them.

## Supported versions

Security fixes target the latest minor release line (the `v0` float tag). Pin
the action to a commit SHA in production (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).
