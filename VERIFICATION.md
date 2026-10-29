# Verification record

Date: 2026-10-28 (Asia/Seoul).

Implementation was delegated to GPT-6.1-Sol with high reasoning. The parent agent independently reviewed the source, ran checks, exercised the real Codex server, and used the Computer Use tools against native Obsidian.

## Environment

- macOS; Obsidian 1.14.4; Codex CLI 0.164.0.
- Real conversation tests used `gpt-6.1-sol`, high reasoning, read-only permissions, and the existing Codex login.
- A separate **Verification Vault** contained synthetic notes and an intentionally faulty JavaScript file. The existing personal vault was not used for prompts or modified.

## Native Obsidian checks

The plugin was installed and enabled in the test vault. The following were observed in the application, rather than inferred from unit tests:

- Plugin commands registered; the dockable panel loaded and connected to Codex.
- The model and reasoning selectors displayed the real server catalog, with read-only permissions selected.
- **+ Note** attached the active `Welcome.md` snapshot. A real prompt returned the expected project **Lantern**, launch date **November 12, 2026**, and verification code **ORBIT-731**.
- The conversation and its response returned after a full application reload.
- Attached source text appeared in a separate, collapsed **Attached context** section.
- History search found the saved conversation for this working folder.
- The rename command changed the chat title to **Lantern verification**.
- Export created a Markdown note containing the complete prompt, attached context, and response; its saved contents were checked on disk.
- Review streamed command activity and correctly identified the deliberate subtraction-versus-addition error in `release.js`.
- A live review exposed differing server turn IDs that left the composer busy after completion. After the fix, a second native review completed, retained its finding, enabled all four selectors, disabled Stop, and restored Send. The installed runtime matched the final build by SHA-256.
- Layout defects found during testing were corrected: the Send button clears Obsidian's floating status bar, and long conversation titles do not wrap the header actions.

Mouse targeting became unreliable in Computer Use, including for Obsidian's own controls. History, rename, export, and review were therefore exercised through the native command palette. Successful command invocation and resulting UI state were checked separately. This is not a claim that every mouse path was verified.

## Real-server integration checks

An independent script used the shipped `CodexClient` against the installed CLI and passed:

1. Initialization, account/model discovery, and skills/MCP discovery.
2. A fresh read-only conversation and a real streamed high-reasoning turn returning `OBSIDIAN-LIVE-OK`.
3. Rename and working-folder-filtered history listing.
4. Resume and paginated retrieval of the actual assistant response.
5. Fork, archive, restore, and re-archive. The extra protocol-test conversations were archived afterward.

## Automated checks and review scope

For the initial Codex-only release, the independent `npm run check` passed: TypeScript checking, **27 tests**, and the production build. Tests run child-process protocol fixtures and actual view/controller code against a minimal Obsidian host and happy-dom. They cover response ordering, Unicode/invalid frames, process failures, timeouts, reconnect races, permission parameters, attached-context separation, paginated history/export, structured questions, approval denial and resolution, review permission refresh, and the real server's review turn-ID lifecycle.

The parent review prompted fixes for process error handling, stale initialization promises, permissions when entering review, duplicate approval responses, cross-thread approval routing, completion races, context presentation, and changed-file path resolution.

Real native permission-grant dialogs, image uploads, all MCP form variations, Windows/Linux, older Obsidian versions, and every CLI/provider combination were not exhaustively tested. Mock-based tests cover approval/question behavior; they do not substitute for a claim of complete native feature parity. See the README feature matrix for intentionally unsupported features.

## Version 0.2.0 — Claude Code CLI

Verified on the same date and disposable vault, using installed Claude Code **2.1.312**, the packaged Anthropic Agent SDK **0.3.312**, and the existing signed-in account. Implementation again used the GPT-6.1-Sol high-reasoning worker, with independent parent review and live testing.

Native Computer Use checks passed:

- Selected Claude Code through the command palette. Its model catalog loaded, with high reasoning and read-only tools selected.
- Attached `Welcome.md` and sent a real prompt. Claude returned Lantern, November 12, 2026, and ORBIT-731.
- Selected Manual approvals and requested a synthetic file write. The real Claude approval dialog appeared; Escape denied the request. Claude reported the denial, and an independent filesystem check confirmed the file was absent.
- Reloaded Obsidian. Claude history returned without duplicated assistant messages. A new follow-up remembered ORBIT-731 and displayed exactly one answer.
- Switched Claude → Codex → Claude. Each provider restored its own conversation, model, reasoning and permissions. The original Codex conversation remained available.
- Opened Claude history and observed the saved test conversations.
- Ran Review changes. Claude identified the deliberate subtraction error in `release.js:3`; controls returned to idle and files were unchanged.
- Exported the Claude conversation. The saved Markdown contained the provider label, attached context, all four assistant responses exactly once, and the review result.

Independent terminal integration checks also passed: direct CLI output; loading the packaged SDK and resuming a session; adapter model discovery, new chat, streaming, rename, history, resume and follow-up memory; interrupting a streaming first turn and continuing that same persisted session.

The final independent `npm run check` for version 0.2.0 passed TypeScript checking, both production bundles, and **41 tests** with no failures.

The final ZIP was integrity-checked against the source artifacts, and its runtime matched the installed files. After loading that exact build, the native chat returned `CLAUDE-RELEASE-OK` once and restored Send/idle controls. One reload displayed a blank window in Computer Use; refocusing/reloading restored the window, connection and history. Its cause was not isolated, and the subsequent smoke test passed.

Native testing exposed browser-versus-Node timer and AbortSignal incompatibilities that terminal tests did not reveal. The fixes keep Node timers and cancellation constructors scoped to the transport/SDK, without replacing Obsidian's globals. Testing also exposed duplicate stream/final responses caused by Claude's per-block assistant events; the adapter now reconciles them and retains distinct history blocks. Regression tests cover these cases, read-only tool enforcement, approval/question responses, interrupted-session reuse, Git snapshots, and provider isolation.

Claude's read-only tool restrictions are not a Codex-style OS sandbox. Live steering, manual compaction, and provider rate-limit inspection are not implemented for Claude. Claude archive state is a plugin-local history filter. Real image uploads, permission grants, every MCP integration, and non-macOS platforms were not exhaustively exercised.

## v0.3.0 — compact composer (2026-10-28)

Replaced the persistent five-field settings grid with two compact composer buttons: model/effort (provider, model and effort picker) and mode/permissions. Attachments now use a `+` menu and commands use `/`. The prompt starts at 64 px and remains vertically resizable. Picker choices retain the existing provider-specific persistence and access policy. Long changed-file paths now wrap within narrow transcripts.

Reference inspection: the installed Claude Code VS Code extension exposes its model/effort button and permission mode beside the prompt. Its [official VS Code documentation](https://code.claude.com/docs/en/vs-code) describes the model/effort picker and permission indicator there. [Codex IDE features](https://developers.openai.com/codex/ide/features) was also consulted for the editor/composer workflow; the exact Codex extension controls were not independently visually verified in this pass.

The requested GPT-6.1-Sol/high worker drafted the compact implementation but hit its usage limit. The parent independently reviewed it, corrected theme-specific button sizing and transcript overflow, added interaction regressions, and finished verification/packaging.

`npm run check` passed TypeScript checking, production builds, and **43 tests**. The added regressions exercise picker focus, Escape and outside dismissal, persistence of mode choices, closure/disabled controls during a turn, confirmation cancellation, and rejection of a stale full-access confirmation after work starts. Prior transport, provider-switching and permission tests also pass.

Native Computer Use in Obsidian 1.14.4, disposable Verification Vault:

- Loaded the new build with Claude history intact; the old settings grid is absent.
- Dragged the right sidebar to a saved width of **336.5 px**. Compact controls and Send remained visible. The model picker fit inside the panel above its trigger.
- Opened model/effort settings, selected Medium, observed the button update, and dismissed the picker with Escape, returning focus to the trigger.
- Opened mode/permissions settings and selected Plan; the mode button updated while keeping Read-only visible.
- Selected Bypass approvals, observed the explicit confirmation, and chose Keep current permissions. Access remained read-only.
- Opened `+` and observed all three attachment actions.
- Reloaded and observed Medium, Plan, read-only and the saved Claude history restored.
- Inspected the final wrapping fix: the long changed-file path fits the narrow transcript without the earlier horizontal scrollbar.

Limitation: a further fresh Claude response after the final reload was not verified. Native pointer actions stopped changing focus, despite window activation/reconnection attempts; the cause was not isolated. The attempted test draft was cleared. The completed v0.2 live CLI checks above remain the evidence for backend behavior; this release changes composer presentation and interaction, not provider transport. Native UI testing used the default dark theme on macOS, not every community theme/platform.

## v0.3.1 — note selection attachments (2026-10-29)

The reported failure was reproduced in the real Verification Vault before changes. A passage inside a Live Preview rendered HTML block remained visibly selected, but `+ → Attach selection` displayed “Select text in a note first…” and added no attachment. The old implementation only consulted `workspace.activeEditor` / the active Markdown editor after chat focus. It did not read the note's DOM selection. After moving focus to chat, the editor-only palette command was also unavailable. As a control, selecting a source-editor line with the keyboard and invoking the palette command immediately did attach that exact 26-character selection.

A synthetic `Selection verification.md` fixture contains a source selection token (ASTER-592), an independent rendered-HTML token (VIOLET-627), and an unselected control token (COPPER-184), allowing checks against whole-note or stale-selection attachment.

The requested GPT-6.1-Sol/high worker implemented the scoped DOM/editor resolver and regression tests. The parent independently reviewed the source, corrected attachment-card sizing, and ran `npm run check`: TypeScript, production builds, and **52 tests passed**. Coverage includes DOM-first selection, explicit editor callbacks, focus transitions, gesture-scoped snapshots, source identity during async opening, rejected chat/title/metadata/cross-source ranges, selection changes, exact previews and outgoing payloads.

Native Computer Use checks passed on Obsidian 1.14.4:

- Highlighted the rendered Live Preview HTML excerpt. The direct Attach selection button appeared; one click attached only that excerpt (44 characters including its whitespace), labeled with `Selection verification.md`, and focused the composer.
- Expanded the attachment preview and confirmed the precise excerpt. Started a new Claude conversation and sent a prompt asking for its token and owner, with tools prohibited. The sent context contained only VIOLET-627's excerpt, excluding ASTER-592 and the unselected COPPER-184 control text. Claude returned **VIOLET-627 / Jun**, with controls returning to idle. This also completes the fresh post-reload live-response check that was blocked in the v0.3.0 run.
- Repeated the originally failing `+ → Attach selection` route on rendered HTML: it now attached the same excerpt correctly.
- Selected source line 5 with the keyboard, right-clicked and chose Attach selection to chat: the resulting attachment showed L5 and the exact 26-character ASTER-592 line.
- Repeated the source selection via the command palette: the command remained available and attached the same exact line.
- Switched to reading view, selected the ASTER-592 passage and attached it through the direct button. Deselecting beforehand removed the action; reselecting restored it.
- Selected chat response text after a note selection: the direct note-attachment action disappeared instead of reusing the previous note text.
- Resized the sidebar to approximately 336 px. The direct selection action, `+`, `/`, Stop and Send fit in the footer without covering one another.

Selections are limited to one note body; titles, properties, chat text and embedded other-note content are excluded. Rendered line numbers are omitted unless an editor range reliably matches. Verification used macOS/default dark theme and the shared attachment path with Claude; Codex transport regression tests passed, but a second live Codex response was not required for this UI-only attachment change. The release ZIP and installed runtime were checked for matching contents and version.

## v0.3.2 — compact header icons (2026-10-29)

Replaced the New/History text buttons with Obsidian square-pen/history icons in 28 px buttons, retaining titles, accessible names and existing actions. Native Computer Use confirmed both icons render, History opens the saved-conversation list, and New returns to an empty conversation. TypeScript/build and all 52 existing tests passed; the existing history test now locates the icon action by its accessible label.

## v0.4.0 — compact model picker (2026-10-29)

Replaced the Provider/Model/Reasoning native-select form with a 280 px popover: Codex/Claude tabs, 30 px checked model rows in a 180 px scrolling list, and a full-width wrapping reasoning control. The reference was the installed Codex VS Code extension's selectable model list and compact effort control. Computer Use access to the Codex desktop app was blocked, so it was not inspected. The plugin uses the options returned by each backend rather than copying the reference's available models or access settings.

The requested GPT-6.1-Sol/high worker implemented the picker and behavioral tests. The parent independently reviewed the code, reduced the model-list height, and moved reasoning choices below their label to use the full width. TypeScript, production build, and all **58 tests passed**, including supported-effort fallback, unlisted saved models, arrow/Enter/Space navigation, provider preference isolation, busy/stale-event guards, failed connections, cancellation of delayed reopening after another user action, and repositioning when model changes alter popup height.

Native Computer Use checks passed in Obsidian 1.14.4/default dark theme:

- Opening focuses the checked Opus 5.5 row; the trigger tooltip is absent while the picker is open.
- Down + Enter selects Fable 5.1 in place; Tab + Right changes Medium to High and updates the composer label. Restored Opus 5.5/Medium afterwards.
- On the final build, selected the last model (Sonnet 4.6), observed its four reported effort choices, and restored Opus 5.5/Medium and its five choices. Clicking the composer dismisses the picker.
- Escape closes the picker and returns focus to its trigger. End reaches the final model in the scrolling list without changing the selected model.
- Switching to Codex disables controls during connection, restores GPT-6.1-Sol/High/Work/read-only and its history, then reopens with the actual Codex model/effort list. Switching back restores Claude Opus 5.5/Medium/Plan/read-only.
- Resized the sidebar to approximately 336 px. The compact picker stays within it; the model list scrolls and reasoning choices remain visible. Reload confirmed the saved Claude settings and the final shorter layout.

This release changes picker presentation and interaction; no additional live model response was needed. Backend transport and existing attachment/mode/permission tests remain passing. Native verification covered macOS/default dark theme, not every community theme or platform.
