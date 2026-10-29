# Third-party notices

The Obsidian plugin source is MIT licensed (see LICENSE). The bundled Claude runtime is a separate third-party component and is not relicensed under the plugin's MIT license.

## Claude Agent SDK

- Package: `@anthropic-ai/claude-agent-sdk` **0.3.312**
- Publisher: Anthropic PBC
- Source package: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- Repository: https://github.com/anthropics/claude-agent-sdk-typescript
- Distributed here as a JavaScript-only CommonJS bundle: `claude-sdk.cjs`.
- No Anthropic native CLI binary is included. The plugin requires the user's separately installed Claude Code executable and always passes that path explicitly.

The package's `LICENSE.md` states:

> © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.

The SDK README links its [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), [Privacy Policy](https://www.anthropic.com/legal/privacy), and [Claude Code data usage documentation](https://code.claude.com/docs/en/data-usage). Those terms and provider policies apply to the SDK/Claude service; this plugin does not replace them.

The runtime preserves bundled dependency copyright/license comments at the end of `claude-sdk.cjs` (`legalComments: "eof"`). These include the notices distributed in the official SDK. They must remain with redistributed runtime copies.

## Packaging adaptations

The SDK JavaScript is bundled with esbuild. A scoped CommonJS prelude supplies the real module file URL, Node timers, and Node-native AbortController/AbortSignal. This addresses Electron renderer globals without modifying Obsidian's browser globals. Session, streaming, and permission behavior continues to use the official SDK and the separately installed CLI.

Obsidian and Node/Electron APIs are provided by the host application and are not redistributed by this plugin. Development-only packages (TypeScript, esbuild, happy-dom, tsx, Prettier, and types) are not runtime requirements and are not copied to the release.
