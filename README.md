# Obsidian Codex + Claude Code

A native, dockable Obsidian desktop chat for **Codex CLI or Claude Code CLI**, using your installed executable and existing provider login. Attach notes, selections, text files, and images; stream Markdown; handle tool approvals; resume saved conversations; and export answers to notes.

This unofficial community integration is independent of OpenAI, Anthropic, and Obsidian. It does not embed either provider's entire IDE extension.

[한국어 안내](README.ko.md) · [Verification record](VERIFICATION.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

## Install or upgrade

Requires Obsidian desktop 1.8+ and at least one installed, authenticated CLI. Tested with **Codex CLI 0.164.0**, **Claude Code 2.1.312**, and the pinned **Claude Agent SDK 0.3.312**. Codex app-server uses experimental APIs; CLI/SDK changes may require a compatible plugin update.

1. Check `codex --version` or `claude --version` in a terminal. Complete your provider's normal terminal login if needed. No API key or password is entered in the plugin.
2. Extract `obsidian-codex-0.4.0.zip` and copy its `obsidian-codex` folder into `<vault>/.obsidian/plugins/`. Replace the previous plugin files when upgrading. **Include `claude-sdk.cjs` and `THIRD_PARTY_NOTICES.md`**, not just the old three-file Codex build.
3. Restart Obsidian and enable **Settings → Community plugins → Codex**. The existing plugin ID/name is retained for upgrades and command-palette compatibility.
4. Open **Codex: Open chat**, then click the **model · effort** button below the prompt and choose the **Codex** or **Claude** tab. Settings also offer a provider selector. Keyboard users can run **Codex: Use Claude Code CLI** or **Codex: Use Codex CLI**.
5. The **model · effort** picker has compact Codex/Claude tabs, a checked model list, and reasoning buttons. Model and effort changes apply immediately; arrow keys navigate the choices, and Enter or Space selects a model or provider. The adjacent **Work/Plan · permissions** picker contains mode and permissions. Press Escape to close a picker. Then send a prompt. Read-only is the default for a newly selected provider.

Each provider keeps its own model, effort, permission mode, and last conversation. Switching clears the composer and attachments and restores the selected provider's history. Finish or stop a running turn before switching. Existing Codex settings/history remain available.

If a GUI app cannot find a CLI, run `which codex` or `which claude` and put the **absolute executable path** into **Settings → Codex**. Automatic discovery checks PATH, Homebrew, npm-global, and user-local locations. A leading `~` expands to your home folder. Executable settings accept a path, not a shell command or arguments.

To build and install from source without downloading the SDK's optional native CLI packages:

```sh
npm ci --omit=optional
npm rebuild esbuild
npm run check
node scripts/install.mjs "/absolute/path/to/your/vault"
```

The installer copies the runtime files and license/notices, backs up earlier plugin files outside the plugins directory, and leaves enablement and other plugins unchanged. Use a disposable vault for development. The release includes all JavaScript runtime dependencies; it needs no npm install inside your vault. **The CLIs themselves are not bundled.**

## Context and everyday use

The header uses a pencil-in-square icon for **New conversation** and a clock-arrow icon for **Conversation history**. Hover for labels; both remain keyboard-accessible.

- **+ → Attach active note** attaches a snapshot of the active note, including unsaved editor text.
- **Select a passage → Attach selection**: a direct button appears beside `+` while note text is selected. It supports source text, Live Preview rendered blocks, and reading view. In the editor, you can also right-click → **Attach selection to chat**, use **+ → Attach selection**, or run **Codex: Attach selection to chat**. You can assign that command a shortcut under **Settings → Hotkeys**.
- Selection attachments show the source note, a line range when reliable, and an excerpt summary. Click the excerpt to inspect the exact text before sending; `×` removes it. Selection attaches a snapshot, not the whole note. Deselecting or selecting chat/UI text does not reuse an old note selection.
- **+ → Attach file or image** selects a vault text file or image. PNG/JPEG/WebP/GIF images are limited to eight per message, each under 10 MiB. Codex checks model-advertised image support; Claude images are sent as typed image blocks.
- Attached text is explicitly labeled quoted reference material, separate from your request. The transcript collapses it under **Attached context**. Attachments are used once and cleared after an accepted send.
- Send with **Cmd+Enter / Ctrl+Enter**. **Stop** interrupts the current provider. Codex additionally supports **Steer** during a turn; Claude accepts the next follow-up after the current turn finishes or is stopped, preserving the same session.
- **History** lists/searches sessions for the current working folder. Recent Codex turns load first with **Load earlier messages** for older turns. Claude history is read through the official SDK session helpers.
- Commands/tools are collapsible. Changes show tool details/diffs and buttons to open changed vault files. Claude edit displays reflect tool inputs/results, rather than a complete Git staging interface.
- **⋯** offers rename, fork, archive/restore, review, copying, note exports, account/skills/MCP inspection. Conversation copy/export includes the available full history; exporting during work captures the currently available snapshot. You can also save/copy only the latest answer.
- Claude archive/restore is a **vault-local visibility preference**: it hides/restores a session in this plugin and does not move or delete the CLI transcript. Codex archive uses the Codex server's archive operation.

Command-palette actions include **Open chat**, **Show conversation history**, **New chat**, **Export conversation to note**, **Copy latest response**, **Review changes**, **Rename conversation**, provider switching, and note/selection attachments.

The **/ Commands** menu lists local client commands:

| Command    | Action                                  |
| ---------- | --------------------------------------- |
| `/new`     | Start a conversation                    |
| `/history` | Search/resume/restore history           |
| `/review`  | Review uncommitted Git changes          |
| `/skills`  | Inspect discovered skills/commands      |
| `/mcp`     | Inspect configured MCP servers          |
| `/status`  | Account and available usage information |
| `/export`  | Save the conversation to a vault note   |
| `/help`    | Client command help                     |

These commands are not a full terminal command interface. Codex skills use `$skill-name`; Claude skills use `/skill-name`. Names matching a local command above are handled by this client. Provider settings, agents, hooks, and MCP/skill installation are managed with the provider's CLI.

## Permissions

The providers have different execution boundaries; the labels describe those differences.

| Selection                      | Codex                                                                                                  | Claude Code                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only                      | Codex read-only sandbox, no command network access by default; restricted actions can request approval | Restricted built-in tool list plus a `PreToolUse` deny hook for writes, shell/code execution, agents, and unknown/MCP tools. These blocked tools cannot be approved in this mode. |
| Agent / Manual approvals       | Codex workspace-write sandbox for the working folder                                                   | Claude `default` manual permission mode, following existing Claude allow/deny/ask rules; unresolved tool requests appear in the panel                                             |
| Full access / Bypass approvals | Codex sandbox restrictions removed                                                                     | Claude `bypassPermissions`, subject to Claude's remaining rules and managed restrictions                                                                                          |
| Plan                           | Codex collaboration Plan mode                                                                          | Claude `plan` permission/workflow mode; read-only tool restrictions still apply when selected                                                                                     |

Selecting full access/bypass requires an explicit confirmation. Controls are locked during execution, and each new turn reapplies the selected policy. Approvals show the provider, tool/command, target file where available, cwd, and full input. **Allow once** returns a one-call SDK decision; the plugin never writes persistent allow rules. Closing/cancelling denies. User questions support choices, multiple selections when requested, and free text where permitted.

**Claude's tool restrictions are not an OS sandbox or a guarantee that all local activity is read-only.** The SDK intentionally loads the normal `claude_code` system prompt and user/project/local settings so your CLAUDE.md, skills, MCP configuration, and customizations work. Existing CLI hooks/settings can run their own code outside the plugin's tool guard, and manual mode honors already configured allow rules. Treat that configuration as trusted, just as when running Claude Code yourself. The plugin does not use `--bare`, which would bypass normal OAuth login.

The plugin does not automatically attach your whole vault. Both agents can still read files through tools according to their current permissions. This is not an attachment-only isolation boundary. Provider policies govern prompts, attachments, tool-read content, and usage data.

Credentials stay with the CLIs. The plugin does not read login files or save tokens/passwords. Its `data.json` stores provider preferences, CLI paths, working folder, last session IDs, and vault-local Claude archive IDs. Conversations stay in provider-managed storage unless you explicitly export Markdown notes.

Closing the panel/disabling the plugin closes its owned processes and denies pending approvals. Reopening resumes persisted history. Requests are not automatically replayed after failures/timeouts: inspect history before resending an action with an unknown outcome.

## Capabilities and limits

| Feature                                    | Codex                            | Claude Code                                                                                                    |
| ------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Existing login and installed executable    | Yes                              | Yes, official SDK with explicit installed CLI path                                                             |
| Dynamic models/reasoning options           | `model/list`                     | SDK `supportedModels`; CLI aliases/default retained                                                            |
| Streamed Markdown, explicit context/images | Yes                              | Yes; partial/final blocks reconciled without duplicate answers                                                 |
| Resume, search, rename, fork               | Yes                              | Official SDK session helpers                                                                                   |
| Archive/restore                            | Provider archive                 | Vault-local hidden-session preference                                                                          |
| Stop                                       | Interrupt RPC                    | SDK interrupt with close fallback; session remains resumable                                                   |
| Live steering                              | Yes                              | Unavailable; finish/stop then send a follow-up                                                                 |
| Tool approvals/user questions              | Yes                              | SDK `canUseTool`, with cancellation and structured answers                                                     |
| Plan and tool/change display               | Yes                              | Yes; Claude tool policy differs as above                                                                       |
| Review                                     | Codex reviewer                   | Prompt-based read-only review with a bounded, real Git status/staged/unstaged/untracked-source snapshot        |
| Manual compaction                          | Yes                              | Not exposed; managed by Claude Code                                                                            |
| Account/limits                             | Provider account/rate-limit API  | Account plus completed-turn tokens/cost; no stable plan rate-limit API exposed here. Use Claude Code `/usage`. |
| Skills/MCP discovery                       | Codex metadata                   | SDK supported commands/server status. Read-only runs exclude MCP execution.                                    |
| MCP elicitation                            | Ordinary forms/verification URLs | No dedicated MCP elicitation UI; ordinary tool approvals are supported                                         |
| Response/conversation copy and note export | Yes                              | Yes                                                                                                            |

Neither provider's full IDE UI is embedded. VS Code inline edits/diagnostics, integrated terminal, Git staging/revert/merge, cloud-task/worktree/PR management interfaces, rich MCP app widgets, voice/Realtime, remote hosts/WSL selection, and Obsidian mobile are not included. CLI/provider behavior, managed policies, and available account models may impose further limits.

Git review requires a Git working folder. Claude review supplies fixed-argument, read-only Git command output because shell execution is blocked in read-only mode. Source snapshots are bounded and labeled reference data; large diffs may be truncated. Review never enables write/shell tools to gather the snapshot.

## Troubleshooting

- **Login:** complete normal `codex login` or Claude's `/login` flow in a terminal as the same OS user; then reconnect. No auth configuration is changed by the plugin.
- **Missing `claude-sdk.cjs`:** reinstall the entire release folder; copying only `main.js` from an old three-file installation is insufficient.
- **Working folder:** blank uses your vault root. Set an existing absolute folder and reconnect for another project. History uses that folder; note/file attachments still come from the current vault. Start a new conversation when changing projects.
- **CLI/protocol error:** use **⋯ → Reconnect** after fixing executable/login/version issues. Prompts rejected before acceptance stay in the composer. For errors after acceptance, inspect the conversation before retrying; an action may already have run.
- **Long attachments:** total text defaults to 60,000 characters per message; settings permit 1,000–500,000. Select a smaller excerpt to use less context. A character limit does not guarantee a token budget.
- **Claude blocked tool:** read-only deliberately blocks shell, editing, agents, and MCP tools even when existing settings would allow them. Switch explicitly to Manual approvals for work that needs those tools.

## Development

```sh
npm ci --omit=optional
npm rebuild esbuild
npm run check          # typecheck, production builds, transport/adapter/view tests
npm run dev            # watch main + SDK runtime
npm run bundle         # dist/obsidian-codex-0.4.0.zip
```

`npm ci --omit=optional` avoids downloading Anthropic's optional native CLI packages. Rebuilding esbuild supplies its own platform build executable. The shipped SDK is a JavaScript-only CJS sidecar with scoped Node timers/AbortSignal for Electron; it never replaces renderer globals. No native CLI binary is embedded or silently downloaded at runtime.

- `src/protocol.ts`: Codex JSONL transport, process lifecycle, executable discovery, policies.
- `src/claude.ts`: official-SDK adapter, streaming/block reconciliation, session helpers, approvals/questions, interruption.
- `src/claude-review.ts`: bounded read-only Git review snapshots.
- `src/claude-sdk-runtime.ts`: SDK sidecar entry point.
- `src/session.ts`, `src/forms.ts`: turn races, explicit context, typed form validation.
- `src/main.ts`: native Obsidian view/settings/dialogs and serialized provider switching.
- Tests include child-process protocol fixtures, the actual built SDK under browser-like globals with real permission control messages, adapter lifecycle/policy/session/block regressions, and happy-dom view tests for history/export/approvals/provider isolation. They require no credentials or network calls. Native/provider-backed evidence is recorded separately in VERIFICATION.md.

Official references: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [Claude SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [Claude user input](https://code.claude.com/docs/en/agent-sdk/user-input), [Obsidian plugin development](https://docs.obsidian.md/Plugins/Getting%20started/Build%20a%20plugin).

Plugin source: MIT. Claude runtime: [third-party terms/notices](THIRD_PARTY_NOTICES.md). Keep license/notices with redistributed builds.
