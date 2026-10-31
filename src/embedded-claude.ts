// The production build replaces this module with the bundled SDK runtime.
export function embeddedClaudeRuntime(): never {
  throw new Error("The Claude SDK runtime was not included in this build.");
}
