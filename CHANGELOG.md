# Changelog

## 0.1.0 - 2026-10-21

Initial public release.

- Standalone `weapp` command for WeChat DevTools automation, page and element
  inspection, screenshots, visual baselines, assertions and reproducible scripts.
- Explicit installation wizard for Codex, DeepSeek Harness, VS Code Copilot and
  Claude Code, with shared skills, per-agent copies and CLI-only installation.
- Managed skill synchronization, conflict checks, backups, transaction recovery,
  uninstall, package updates and environment diagnostics.
- Global npm installation and an npx installer that hands off to a fixed global
  package version without retaining paths into the npx cache.
- Node.js 22 or newer; Windows acceptance completed. macOS remains unverified.

Validation: 158 unit/integration checks, nine isolated Windows distribution
scenarios, interactive cancellation, and read-only simulator connection, page,
screenshot and element-baseline checks. Copilot and Claude Code still require
chat-session reload and invocation verification; installed files alone do not
establish that a chat has loaded the skill.

The legacy SDK retains an upstream moderate dependency advisory. Compatible
security fixes and the remaining limitation are described in the README and
Windows acceptance report. Private screenshots and raw acceptance artifacts are
kept outside version control and the npm package.
