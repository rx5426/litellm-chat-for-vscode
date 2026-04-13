# LiteLLM Provider for GitHub Copilot Chat on VS Code

Use 100+ LLMs in VS Code with GitHub Copilot Chat powered by [LiteLLM](https://docs.litellm.ai).

## Features

- Access 100+ LLMs (OpenAI, Anthropic, Google, AWS, Azure, and more) through a unified API
- Automatic provider selection with `cheapest` and `fastest` modes
- Support for streaming, function calling, and vision models
- Fallback chat participant `@litellm` for VS Code builds where third-party model picking is limited
- Optional auto-apply workflow for code blocks generated in fallback chat
- Chat reference support in fallback chat (selected code, files, and attached context)
- Self-hosted or cloud-based deployment options

## Requirements

- VS Code 1.103.0 or higher
- LiteLLM proxy running (self-hosted or cloud)
- LiteLLM API key (if required by your setup)

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=rx5426.litellm-chat-for-vscode)
2. Open VS Code's chat interface
3. Click the model picker → "Manage Models..." → "LiteLLM"
4. Enter your LiteLLM base URL (e.g., `http://localhost:4000`)
5. Enter your API key (if required)
6. Select models to add
7. If model picker integration is unavailable in your VS Code version, open chat and use `@litellm`

## Fallback Chat (`@litellm`)

When VS Code cannot surface LiteLLM models directly in the model picker, you can still chat through LiteLLM using the built-in fallback participant.

### How To Use

1. Open Chat in VS Code
2. Type `@litellm` followed by your prompt
3. (Optional) Attach files or code references in Chat; they are included in the sent prompt
4. Receive streamed responses from the LiteLLM-selected model

### Fallback Commands

Use Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

- `LiteLLM: Open Fallback Chat` - Opens chat and prepares `@litellm` usage
- `LiteLLM: Use 1.103 Model Picker Workaround` - Picks a LiteLLM model and opens `@litellm` chat when third-party Manage Models UI is limited
- `LiteLLM: Select Chat Model` - Sets which LiteLLM model fallback chat should use
- `LiteLLM: Show Available Models` - Lists models returned by your LiteLLM server
- `LiteLLM: Set Fallback Task Goal` - Sets a persistent goal for long-running fallback workflows
- `LiteLLM: Add Fallback Task Note` - Adds a persistent note/checkpoint for fallback workflows
- `LiteLLM: Show Fallback Task State` - Displays current fallback goal/notes
- `LiteLLM: Clear Fallback Task State` - Clears persistent fallback goal/notes
- `LiteLLM: Approve Tool Call (Fallback Chat)` - Executes tool call pending approval
- `LiteLLM: Reject Tool Call (Fallback Chat)` - Skips a tool call
- `LiteLLM: Show Tool Call Status (Fallback Chat)` - Displays tool call history
- `LiteLLM: Toggle Auto-Apply Code Edits (Fallback Chat)` - Turns automatic code-block application on/off
- `LiteLLM: Show Staged Edits (Fallback Chat)` - Shows the current staged multi-file edit batch
- `LiteLLM: Apply Staged Edits (Fallback Chat)` - Applies all staged edits that are not rejected
- `LiteLLM: Discard Staged Edits (Fallback Chat)` - Clears the current staged edit batch without applying it

### Long-Workflow State In Fallback Chat

Fallback chat can maintain explicit task goals and state across long workflows.

Use slash commands directly in `@litellm` chat:

- `/goal <text>` set persistent task goal
- `/note <text>` add a persistent task note/checkpoint
- `/show-state` show current goal and notes
- `/clear-state` clear stored workflow state
- `/help-state` show command help
- `/loop-start <goal>` start an autonomous loop with checkpoint tracking
- `/loop-step <instruction>` run exactly one guarded loop step
- `/loop-approve` approve the latest checkpoint and unlock the next loop step
- `/loop-rollback [checkpoint-id|last]` rollback state to a checkpoint
- `/loop-status` show loop status, approval gate, and latest checkpoint summary

The stored state is automatically injected into future fallback prompts (when enabled), improving continuity for multi-step work.

Autonomous-loop behavior is guarded by checkpoints and approval gates by default:
- Each `/loop-step` creates a checkpoint snapshot (goal, notes, instruction, and response summary)
- The next `/loop-step` is blocked until `/loop-approve` (or rollback) when approval gating is enabled
- `/loop-rollback` restores task state to a prior checkpoint for safe recovery

### Tool Calling In Fallback Chat

Fallback chat can request and execute tools (file operations, terminal commands, git, tests) with user approval:

- Models can call tools to accomplish tasks (enabled by default when model supports tool calling)
- Tool calls are displayed to the user with arguments before execution
- `/tool-approve` executes the requested tool and displays output
- `/tool-reject` skips the tool call
- `/tool-checkpoint` creates a checkpoint capturing all executed tools for this step
- `/tool-status` shows the history of pending, approved, executed, and failed tool calls

Supported tools:
- `read_file` - Read file content (`path` argument)
- `write_file` - Write or create files (`path`, `content` arguments)
- `execute_command` - Run shell commands (`command`, optional `cwd` argument)
- `git_command` - Run git operations (`action`: status, log, diff, branch, checkout, commit, push, pull; `repo_path` argument)
- `run_tests` - Execute tests (`test_path`, optional `framework` and `cwd` arguments)

Example workflow:
1. Ask the model to "fix failing tests"
2. Model requests `run_tests` tool to check test status
3. You see the tool call and run `/tool-approve`
4. Model sees results and requests `write_file` to fix the bug
5. Approve again to apply the fix
6. Create a checkpoint with `/tool-checkpoint` to save progress

Configuration settings for tool calling:

| Setting | Default | Description |
|---------|---------|-------------|
| `litellm-vscode-chat.fallbackToolCalling.enabled` | `true` | Enable tool calling in fallback chat |
| `litellm-vscode-chat.fallbackToolCalling.requireApprovalForExecution` | `true` | Require `/tool-approve` before executing tool calls |
| `litellm-vscode-chat.fallbackToolCalling.maxToolCalls` | `50` | Maximum tool calls retained in workflow state |
| `litellm-vscode-chat.fallbackToolCalling.maxOutputChars` | `4000` | Maximum characters of tool output displayed in chat |

### Code Edit Application In Fallback Chat

Fallback chat can extract fenced code blocks from responses and apply them in VS Code:

- Preferred format: structured `litellm-edit` blocks with JSON containing `path`, `intent` (`create` or `replace`), and full file `content`
- Structured edits are now staged for review before they modify workspace files
- Auto-apply enabled: code blocks are applied automatically to detected file paths when available
- If no path is detected, the first untargeted block can fall back to the active editor file
- Remaining untargeted blocks are opened in new untitled editors
- Auto-apply disabled: you get an `Apply ... edit` button for each detected code block
- Manual apply command prompts to replace the active file, apply to a suggested path (when present), or open in a new untitled editor

Structured edit format:

```litellm-edit
{
  "path": "src/example.ts",
  "intent": "replace",
  "language": "ts",
  "content": "export const example = true;"
}
```

Fallback chat now prefers these structured edit blocks over raw code-fence heuristics. Intent is enforced during apply:
- `create` fails if the target file already exists
- `replace` fails if the target file does not exist
- patch-only structured edits are parsed but not auto-applied yet

When fallback receives multiple structured edits, it stages them as a review batch:
- A staged summary is shown in chat
- Each file gets `Preview`, `Accept`, and `Reject` controls
- `Apply Staged Edits` applies all files that are not rejected
- `Discard Staged Edits` clears the batch without changing workspace files

Safer auto-apply policy modes:
- `fallbackEditPolicy.pathRequired`: skip untargeted edits entirely
- `fallbackEditPolicy.sameFileOnly`: only allow edits that target the active file
- `fallbackEditPolicy.workspaceOnly`: block edits outside the current workspace
- `fallbackEditPolicy.maxFilesPerResponse`: reject oversized multi-file edit batches

Setting:

| Setting | Default | Description |
|---------|---------|-------------|
| `litellm-vscode-chat.autoApplyCodeEdits` | `true` | Auto-apply fallback chat code blocks to editors |
| `litellm-vscode-chat.fallbackEditPolicy.pathRequired` | `false` | Require fallback edits to specify a target path |
| `litellm-vscode-chat.fallbackEditPolicy.sameFileOnly` | `false` | Restrict fallback edits to the active file |
| `litellm-vscode-chat.fallbackEditPolicy.workspaceOnly` | `false` | Block fallback edits outside the workspace |
| `litellm-vscode-chat.fallbackEditPolicy.maxFilesPerResponse` | `null` | Maximum files a single fallback response may stage or auto-apply |

## Configuration

### Connection Settings

To update your base URL or API key:
- **Command Palette**: `Ctrl+Shift+P` / `Cmd+Shift+P` → "Manage LiteLLM Provider"
- **Model Picker**: Chat interface → Model picker → "Manage Models..." → "LiteLLM"

Credentials are stored securely in VS Code's secret storage.

### Token Limits (Automatic)

The extension automatically reads token limits from your LiteLLM server's model info. You can configure fallback defaults in VS Code settings:

**To access**: `Ctrl+,` / `Cmd+,` → Search "litellm-vscode-chat"

| Setting | Default | Description |
|---------|---------|-------------|
| `litellm-vscode-chat.defaultMaxOutputTokens` | `16000` | Max tokens per response (fallback) |
| `litellm-vscode-chat.defaultContextLength` | `128000` | Total context window (fallback) |
| `litellm-vscode-chat.defaultMaxInputTokens` | `null` | Max input tokens (auto-calculated if null) |
| `litellm-vscode-chat.stopSequences` | `[]` | Global fallback stop sequences (used when request/model parameters do not set `stop`) |
| `litellm-vscode-chat.fallbackModelOptions` | `{}` | Fallback-chat-only model options (with normalized matching for routed model IDs) |
| `litellm-vscode-chat.fallbackWorkflowState.enabled` | `true` | Enable persistent fallback goal/state injection and slash-command state controls |
| `litellm-vscode-chat.fallbackWorkflowState.maxNotes` | `20` | Max number of persistent fallback notes to keep |
| `litellm-vscode-chat.fallbackWorkflowState.maxCheckpoints` | `30` | Max number of autonomous-loop checkpoints to retain |
| `litellm-vscode-chat.fallbackWorkflowState.maxCheckpointSummaryChars` | `600` | Max characters stored for each checkpoint summary |
| `litellm-vscode-chat.fallbackWorkflowState.requireApprovalGate` | `true` | Require explicit `/loop-approve` between `/loop-step` iterations |

**Priority**: LiteLLM model info → Workspace settings → Defaults

### Custom Model Parameters (Optional)

Override default request parameters for specific models using the `modelParameters` setting. This is useful for models with specific requirements (like gpt-5 requiring `temperature: 1`) or to customize behavior per model.

**To configure**: Add to your `settings.json`:

```json
{
  "litellm-vscode-chat.modelParameters": {
    "gpt-5": {
      "temperature": 1
    },
    "gpt-4": {
      "max_tokens": 8000,
      "temperature": 0.8,
      "top_p": 0.9
    },
    "claude-opus": {
      "max_tokens": 16000,
      "temperature": 0.5
    }
  }
}
```

**Supported parameters:**
- `max_tokens` - Maximum tokens in response
- `temperature` - Randomness (0.0-2.0)
- `top_p` - Nucleus sampling (0.0-1.0)
- `frequency_penalty` - Reduce repetition (-2.0 to 2.0)
- `presence_penalty` - Encourage new topics (-2.0 to 2.0)
- `stop` - Stop sequences (string or array)
- And any parameter supported by your litellm and model provier back end

**Prefix matching**: Configuration keys use longest prefix matching. For example, `"gpt-4"` will match `"gpt-4-turbo:openai"`, `"gpt-4:azure"`, etc. More specific keys take precedence.

**Parameter precedence**: Runtime options > User config > Defaults

### Fallback Model-Specific Options Workaround

When using `@litellm`, routed model IDs can vary (for example `model:cheapest`, `model:fastest`, or `model:provider`).
Use `litellm-vscode-chat.fallbackModelOptions` to apply runtime options specifically for fallback chat with robust matching.

The fallback matcher supports normalized keys and Claude-first aliases, including:
- `claude-code-haiku-4-5`
- `claude-code-sonnet-4-6`
- `claude-code-opus-4-6`

Example:

```json
{
  "litellm-vscode-chat.fallbackModelOptions": {
    "claude-code-haiku-4-5": {
      "max_tokens": 8192,
      "temperature": 0.6,
      "top_p": 0.95
    },
    "claude-code-sonnet-4-6": {
      "max_tokens": 12000,
      "temperature": 0.7
    },
    "claude-code-opus-4-6": {
      "max_tokens": 16000,
      "temperature": 0.5,
      "stop": ["<END_OF_TASK>"]
    }
  }
}
```

### Prompt Caching (Anthropic Claude)

The extension supports prompt caching for models that advertise this capability (currently Anthropic Claude models). Prompt caching reduces costs and improves response times by caching the system prompt across requests.

**To configure**: Add to your `settings.json`:

```json
{
  "litellm-vscode-chat.promptCaching.enabled": true
}
```

**How it works:**
- Automatically detects prompt caching support from LiteLLM's `/v1/model/info` endpoint
- Only affects models that explicitly support prompt caching (primarily Claude models)
- Adds `cache_control` blocks to system messages when enabled
- Disabled by default for models without support

**Benefits:**
- Reduced API costs (cached tokens are cheaper)
- Faster response times (cached content doesn't need reprocessing)
- Transparent to the user (works automatically when supported)

## Troubleshooting

### Mock LiteLLM Server (Local)

For quick manual testing, you can run a tiny mock LiteLLM server that serves a static model list and canned chat replies.

```bash
node scripts/mock-litellm-server.js
```

Optional port override:

```bash
PORT=4001 node scripts/mock-litellm-server.js
```

Then set your base URL to `http://localhost:4000` (or the port you chose).

### Status Bar Indicator

The LiteLLM status bar indicator (bottom right corner) shows your connection status:

| Icon | Status | Description |
|------|--------|-------------|
| `⚠️ LiteLLM` | Not Configured | Click to set up your connection |
| `⟳ LiteLLM` | Loading | Fetching models from server |
| `✓ LiteLLM (N)` | Connected | Successfully connected with N models available |
| `✗ LiteLLM` | Error | Connection failed - click for diagnostics |

Click the status bar indicator at any time to view detailed diagnostics.

### Test Your Connection

After configuring the extension, verify your setup:

1. **Command Palette**: `Ctrl+Shift+P` / `Cmd+Shift+P` → "LiteLLM: Test Connection"
2. Or click "Test Connection" after saving configuration

This will:
- Attempt to connect to your LiteLLM server
- Show the number of models found
- Display detailed error messages if connection fails
- Update the status bar with results

### Diagnostic Tools

**View Diagnostics**
- **Command Palette**: `Ctrl+Shift+P` / `Cmd+Shift+P` → "LiteLLM: Show Diagnostics"
- Or click the status bar indicator

Shows:
- Current configuration (base URL, API key status)
- Connection state and model count
- Last check timestamp
- Quick access to output channel

**Output Channel**

View detailed logs for debugging:
1. Open Output panel: `Ctrl+Shift+U` / `Cmd+Shift+U`
2. Select "LiteLLM" from the dropdown

The output channel logs:
- Configuration changes
- Model fetch attempts and results
- Error messages with full details
- Server response information

### Common Issues

**"No models appear in the model picker"**
- Check the status bar - it will show the actual state
- Click "Test Connection" to verify your setup
- Check the "LiteLLM" output channel for error details
- Verify your LiteLLM server is running and accessible

**"Server returned 0 models"**
- Your LiteLLM proxy is running but has no models configured
- Check your LiteLLM proxy configuration (`litellm_config.yaml`)
- Run `litellm --config your_config.yaml` to start the proxy with models

**"Authentication failed"**
- Your server requires an API key
- Run "Manage LiteLLM Provider" and enter your API key
- Verify the key is correct in your LiteLLM proxy configuration

**"Connection Error: Unable to connect"**
- Verify the base URL is correct (e.g., `http://localhost:4000`)
- Ensure your LiteLLM proxy is running
- Check firewall/network settings

## Development

```bash
git clone https://github.com/rx5426/litellm-chat-for-vscode
cd litellm-chat-for-vscode
bun install
bun run compile
```

Press `F5` to launch the Extension Development Host.

| Command | Description |
|---------|-------------|
| `bun run compile` | Build |
| `bun run watch` | Watch mode |
| `bun run lint` | Lint |
| `bun run format` | Format |
| `bun test` | Run tests |

## Resources

- [LiteLLM Documentation](https://docs.litellm.ai)
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [Report Issues](https://github.com/rx5426/litellm-chat-for-vscode/issues)
