# Fallback Chat vs Non-Fallback Provider Comparison

## Feature Parity Analysis

### ✅ Features Present in Both

| Feature | Fallback Chat (@litellm) | Non-Fallback (LM Provider) | Notes |
|---------|--------------------------|--------------------------|-------|
| **Core Messaging** | ✅ | ✅ | Both handle user messages and chat history |
| **Tool Calling** | ✅ | ✅ | Both support `toolMode: Auto` and tool call parsing |
| **Token Counting** | ✅ | ✅ | Both estimate token usage before requests |
| **Prompt Caching** | ✅ | ✅ | Both respect `promptCaching.enabled` config |
| **Code Block Extraction** | ✅ | ✅ | Both parse and extract code blocks from responses |
| **Code Block Application** | ✅ | ✅ | Both can apply code edits (with manual approval in fallback) |
| **Auto-Apply Code Edits** | ✅ | ✅ | Fallback-only feature (via new `autoApplyCodeEdits` setting) with toggle command |
| **Streaming Response** | ✅ | ✅ | Both stream responses from LiteLLM API |
| **Error Handling** | ✅ | ✅ | Both have error reporting and user notifications |
| **Configuration Reading** | ✅ | ✅ | Both read workspace settings (`litellm-vscode-chat.*`) |

### ❌ Features Missing in Fallback Chat

| Feature | Non-Fallback Provider | Fallback Chat | Impact |
|---------|----------------------|---------------|--------|
| **Model-Specific Options** | ✅ `modelOptions` parameter | ❌ Not available | Users cannot set temperature, top_p, frequency_penalty, etc. per request |
| **Runtime Temperature Control** | ✅ Via `options.modelOptions.temperature` | ❌ | Fallback always uses provider's defaults |
| **Request Penalties** | ✅ `frequency_penalty`, `presence_penalty` | ❌ | Fallback cannot tune response diversity |
| **Stop Sequences** | ✅ Via `options.modelOptions.stop` | ❌ | Fallback cannot set custom stop tokens |
| **Max Tokens Override** | ✅ Via `options.modelOptions.max_tokens` | ❌ | Fallback relies on config `modelParameters` only |
| **Reference Handling** | ✅ Advanced reference types | ❌ Limited | Fallback extracts references but only uses them in prompt text |
| **Vision Capabilities** | ✅ Detected in model metadata | ❌ | Fallback doesn't advertise or validate vision support |
| **Tool Requirement Enforcement** | ✅ Can require/disable tools | ❌ | Fallback always uses `toolMode: Auto` |

### 📊 Configuration Differences

**Non-Fallback Provider (LM API)** supports:
```json
{
  "litellm-vscode-chat.modelParameters": {
    "gpt-4": { "temperature": 0.3, "top_p": 0.9 },
    "claude": { "temperature": 0.8 }
  },
  "litellm-vscode-chat.promptCaching.enabled": true,
  "litellm-vscode-chat.defaultMaxOutputTokens": 16000
}
```

**Fallback Chat** supports:
```json
{
  "litellm-vscode-chat.modelParameters": {
    "gpt-4": { "temperature": 0.3 }  // ⚠️ Used but not passed to requests
  },
  "litellm-vscode-chat.promptCaching.enabled": true,
  "litellm-vscode-chat.autoApplyCodeEdits": true  // ✨ Fallback-only (enabled by default)
}
```

## Why These Gaps Exist

The fallback chat uses VS Code's `chat.createChatParticipant()` API, which has a simpler interface:
- ❌ No `modelOptions` parameter in the callback
- ❌ No mechanism to pass per-request parameters
- ✅ Uses only the provider's internal `provideLanguageModelChatResponse()` method

The non-fallback provider uses `lm.registerLanguageModelChatProvider()`, which receives full `ProvideLanguageModelChatResponseOptions`:
- ✅ Full `options.modelOptions` support
- ✅ Full `options.tools` and `toolMode` control
- ✅ Can be called by Copilot Chat with custom parameters

## Recommendations

### Option 1: Accept Limitations (Current State)
- Fallback chat is a "basic" fallback for when the LM API is unavailable
- Document these limitations in the README
- **Pros:** No changes needed; code remains simple
- **Cons:** Users hitting limitations may be confused

### Option 2: Extend Fallback with Request-Level Options
Modify the fallback chat to accept/parse parameters from user requests (e.g., `@litellm temp:0.3`):
- Would require custom parsing logic
- Could support some parameters but not all
- **Pros:** Better UX for advanced users
- **Cons:** More complex code; different syntax than LM API

### Option 3: Document Fallback as "Lite" Version
Create clear documentation showing:
- When to use fallback vs. non-fallback
- Which features are available in each mode
- How to enable the full LM provider (GitHub Copilot Chat requirement)

## Test Coverage

The fallback chat lacks dedicated tests for:
- ✅ Code block extraction (covered by utils tests)
- ✅ Streaming response handling (uses provider method)
- ❌ Parameter forwarding (N/A due to API limitations)
- ❌ Integration with chat history
- ❌ Reference handling in fallback mode
- ❌ Automatic code edit application

## How to Use Auto-Apply Code Edits (Fallback Chat Workaround)

### Default Behavior

Auto-apply code edits is **enabled by default** for the fallback chat. All code blocks are automatically opened in new untitled editors.

### Disable Auto-Apply Globally

**Via Settings UI:**
1. Open VS Code Settings (`Ctrl+,` / `Cmd+,`)
2. Search for: `litellm-vscode-chat.autoApplyCodeEdits`
3. Uncheck the box to disable

**Via Settings JSON:**
```json
{
  "litellm-vscode-chat.autoApplyCodeEdits": false
}
```

### Toggle During Session

Use the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:
```
LiteLLM: Toggle Auto-Apply Code Edits (Fallback Chat)
```

This instantly enables/disables auto-apply for the current session without reloading. Useful if you want to temporarily switch between automatic and manual application.

### How It Works

When auto-apply is **enabled**:
- All code blocks extracted from fallback chat responses are automatically opened in new untitled editors
- Progress messages show: `✓ Applied [language] code to new editor (1/3)`
- Errors display with ✗ markers if an edit fails
- No manual button clicking needed

When auto-apply is **disabled** (default):
- Code blocks show as interactive buttons: `Apply [language] edit`
- Click to manually apply to new editor or replace current file
- Full control over which edits get applied

### Safety Features

1. **Batch notifications** - Shows total number of edits being applied
2. **Atomic operations** - Each code block is independent; failures don't block others
3. **Error reporting** - Failed edits show in progress and output channel
4. **Logging** - All auto-apply actions logged to "LiteLLM" output channel
5. **Easy toggle** - Disable with one command if needed

### Use Cases

**✅ Best for:**
- Generating multiple small code snippets (utilities, helpers)
- Quick prototyping where you want all suggestions applied
- Testing different model responses side-by-side
- Exploring code variations in separate editors

**❌ Avoid for:**
- High-risk code changes (use manual review mode instead)
- Replacing existing files (auto-apply creates new untitled editors only)
- Complex refactoring (still show buttons and review manually)

### Example Workflow

```
User: @litellm create 5 utility functions for string manipulation
LiteLLM: [Response with 5 code blocks]
Auto-Apply: Creates 5 new untitled editors automatically
User: Reviews each editor tab, saves the ones they like
```

## Summary This is a **workaround** that leverages the fallback chat's direct access to `applyCodeEdit()`. While the fallback chat API doesn't support per-request parameters like the full LM provider, the auto-apply setting provides a practical solution for common use cases.

**Key Benefits Over Manual Application:**
- Faster workflow for generating multiple code snippets
- Same functionality as LM provider's code blocks
- Can be toggled on/off instantly
- Non-destructive (creates new editors, doesn't overwrite)

**Limitations:**
- Only applies to new untitled editors (not existing files)
- Cannot replace specific ranges
- All-or-nothing per response (no selective application)

To apply edits to existing files with full control, use the **non-fallback LM provider** (requires GitHub Copilot Chat).
