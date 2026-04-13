# Fallback Chat vs Non-Fallback Provider Comparison

This document reflects the current implementation status.

## Feature Parity Analysis

### Features Available in Both Modes

| Feature | Fallback Chat (@litellm) | Non-Fallback (LM Provider) | Notes |
|---------|--------------------------|----------------------------|-------|
| Core messaging and history replay | Yes | Yes | Fallback replays prior turns into provider requests |
| Streaming response | Yes | Yes | Both stream from LiteLLM chat completions |
| Tool calling (auto mode) | Yes | Yes | Fallback currently uses tool mode auto |
| Prompt caching support | Yes | Yes | Respects prompt caching support + settings |
| Model parameter support | Yes | Yes | Provider applies temperature, top_p, penalties, max_tokens, stop |
| Stop sequences | Yes | Yes | Resolved with runtime, model, and global fallback precedence |
| Reference handling | Yes | Yes | Fallback injects reference context into prompt text |
| Code block extraction | Yes | Yes | Shared extraction logic remains as fallback |
| Structured edit contract | Yes | No equivalent workaround needed | Fallback now supports `litellm-edit` JSON blocks with path + intent + content |
| Code edit application | Yes | Yes | Fallback supports staged multi-file review for structured edits plus code-block fallback |
| Fallback edit safety policies | Configurable | Native platform protections | Fallback supports path-required, same-file-only, workspace-only, and max-files-per-response guards |
| Diagnostics/logging | Yes | Yes | Output channel + status reporting |

### Fallback Workarounds Added

| Workaround | Status | Notes |
|------------|--------|-------|
| Fallback model-specific options | Implemented | `litellm-vscode-chat.fallbackModelOptions` resolves options by normalized model ID and prefix |
| Claude model alias matching | Implemented | Supports aliases such as `claude-code-haiku-4-5`, `claude-code-sonnet-4-6`, `claude-code-opus-4-6` |
| Routed model ID handling | Implemented | Handles variants like `:cheapest`, `:fastest`, and provider suffixes |
| Stop-sequence fallback setting | Implemented | `litellm-vscode-chat.stopSequences` applies when runtime/model stop is not provided |
| Reference prompt rewrite ordering | Implemented | Reorders references by prompt position and rewrites inline mentions to stable placeholders |

## Remaining Differences

| Area | Non-Fallback Provider | Fallback Chat |
|------|-----------------------|---------------|
| Native request-time model options from VS Code UI | Full | Not exposed directly by participant API; fallback uses config-driven workaround |
| Tool mode controls | Flexible (depends on caller options) | Currently fixed to auto mode |
| Vision capability signaling in participant layer | Explicit model metadata path | Not surfaced separately in participant UX |

## Current Configuration for Fallback Chat

```json
{
  "litellm-vscode-chat.promptCaching.enabled": true,
  "litellm-vscode-chat.autoApplyCodeEdits": true,
  "litellm-vscode-chat.stopSequences": ["<END>"],
  "litellm-vscode-chat.fallbackModelOptions": {
    "claude-code-haiku-4-5": {
      "max_tokens": 8192,
      "temperature": 0.6
    },
    "claude-code-sonnet-4-6": {
      "max_tokens": 12000,
      "temperature": 0.7,
      "top_p": 0.95
    },
    "claude-code-opus-4-6": {
      "max_tokens": 16000,
      "temperature": 0.5,
      "stop": ["<END_OF_TASK>"]
    }
  }
}
```

## Auto-Apply Code Edits (Fallback)

Default behavior is enabled unless changed by user settings.

- Preferred: structured `litellm-edit` blocks are staged for review, preview, accept/reject, and batch apply
- Fallback: extracted code blocks are still supported when the model does not emit structured edits
- Disabled: fallback shows per-block apply buttons
- Toggle command: LiteLLM: Toggle Auto-Apply Code Edits (Fallback Chat)

## Test Coverage Snapshot

Implemented coverage includes:

- stop sequence normalization and precedence
- fallback model-option matching and Claude alias behavior
- reference ordering and prompt mention rewrite
- provider request option handling in shared provider pipeline

## Summary

Fallback chat is no longer a basic text-only mode. It now supports practical model-specific runtime tuning through configuration-driven workarounds, including Claude-focused mappings, stop-sequence handling, stronger reference-context injection, and a structured edit contract that reduces reliance on raw code-fence heuristics.
