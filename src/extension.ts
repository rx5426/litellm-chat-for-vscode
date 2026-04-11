import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "./provider";
import {
	buildPromptWithReferences,
	extractCodeBlocks,
	applyCodeEdit,
	resolveFallbackModelOptions,
	executeFallbackTool,
} from "./utils";

const LITELLM_VENDOR = "litellm";
const LITELLM_CHAT_PARTICIPANT_ID = "rx5426.litellm-chat";
const LITELLM_SELECTED_CHAT_MODEL_KEY = "litellm.selectedChatModel";
const LITELLM_FALLBACK_WORKFLOW_STATE_KEY = "litellm.fallbackWorkflowState";

interface FallbackToolCall {
	id: string;
	name: string; // "read_file" | "write_file" | "execute_command" | "git_command" | "run_tests"
	arguments: Record<string, unknown>;
	status: "pending" | "approved" | "rejected" | "executed" | "failed";
	createdAt: number;
	executedAt?: number;
	result?: string;
	error?: string;
}

interface FallbackWorkflowState {
	goal?: string;
	notes: string[];
	loopEnabled: boolean;
	pendingApproval: boolean;
	checkpoints: FallbackWorkflowCheckpoint[];
	toolCalls: FallbackToolCall[];
	pendingToolCallId?: string; // The currently-pending tool call awaiting approval
	updatedAt: number;
}

interface FallbackWorkflowCheckpoint {
	id: string;
	createdAt: number;
	goal?: string;
	notes: string[];
	instruction: string;
	responseSummary: string;
	approved: boolean;
	toolCallsIncluded?: string[]; // IDs of tool calls in this checkpoint
}

interface FallbackWorkflowCommandResult {
	handled: boolean;
	promptOverride?: string;
	metadataMode?: string;
	loopInstruction?: string;
}

/**
 * Check if the current VS Code version meets the minimum required version.
 * @param current The current VS Code version (e.g., "1.103.0")
 * @param required The minimum required version (e.g., "1.103.0")
 * @returns true if current version is compatible, false otherwise
 */
function isVersionCompatible(current: string, required: string): boolean {
	const parse = (v: string) =>
		v
			.split(".")
			.slice(0, 3)
			.map((n) => parseInt(n.replace(/[^0-9]/g, ""), 10));
	const [cMaj, cMin, cPat] = parse(current);
	const [rMaj, rMin, rPat] = parse(required);
	if (cMaj !== rMaj) {
		return cMaj > rMaj;
	}
	if (cMin !== rMin) {
		return cMin > rMin;
	}
	return cPat >= rPat;
}

export function activate(context: vscode.ExtensionContext) {
	// Check VS Code version compatibility
	const minVersion = "1.103.0";
	if (!isVersionCompatible(vscode.version, minVersion)) {
		vscode.window
			.showErrorMessage(
				`LiteLLM requires VS Code ${minVersion} or higher. You have ${vscode.version}. Please update VS Code.`,
				"Download Update"
			)
			.then((sel) => {
				if (sel) {
					vscode.env.openExternal(vscode.Uri.parse("https://code.visualstudio.com/"));
				}
			});
		return; // Don't register provider
	}
	// Build a descriptive User-Agent to help quantify API usage
	const ext = vscode.extensions.getExtension("rx5426.litellm-chat-for-vscode");
	const extVersion = ext?.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	const likelyLimitedModelPickerUi = !isVersionCompatible(vscode.version, "1.108.0");
	// Keep UA minimal: only extension version and VS Code version
	const ua = `litellm-chat-for-vscode/${extVersion} VSCode/${vscodeVersion}`;

	// Create output channel for diagnostics
	const outputChannel = vscode.window.createOutputChannel("LiteLLM");
	context.subscriptions.push(outputChannel);
	outputChannel.appendLine(`LiteLLM Extension activated (v${extVersion})`);
	if (likelyLimitedModelPickerUi) {
		outputChannel.appendLine(
			`[${new Date().toISOString()}] Running on VS Code ${vscode.version}. Third-party providers may not appear in Manage Models on 1.103.x.`
		);
	}

	const provider = new LiteLLMChatModelProvider(context.secrets, ua, outputChannel, likelyLimitedModelPickerUi);
	context.subscriptions.push(provider);
	const copilotChatExtension = vscode.extensions.all.find(
		(extInfo) => extInfo.id.toLowerCase() === "github.copilot-chat"
	);
	const getLanguageModelApi = () =>
		(
			vscode as unknown as {
				lm?: { registerLanguageModelChatProvider?: typeof vscode.lm.registerLanguageModelChatProvider };
			}
		).lm;

	const selectLiteLLMChatModel = async (interactive: boolean, forcePrompt = false) => {
		const models = await provider.prepareLanguageModelChatInformation(
			{ silent: !interactive },
			new vscode.CancellationTokenSource().token
		);

		if (models.length === 0) {
			if (interactive) {
				void vscode.window.showWarningMessage(
					"LiteLLM: No models are available yet. Run Test Connection or reconfigure your LiteLLM server."
				);
			}
			return undefined;
		}

		const storedModelId = context.globalState.get<string>(LITELLM_SELECTED_CHAT_MODEL_KEY);
		if (!forcePrompt && storedModelId) {
			const storedModel = models.find((model) => model.id === storedModelId);
			if (storedModel) {
				return storedModel;
			}
		}

		if (!interactive || (models.length === 1 && !forcePrompt)) {
			const defaultModel = models[0];
			await context.globalState.update(LITELLM_SELECTED_CHAT_MODEL_KEY, defaultModel.id);
			return defaultModel;
		}

		const picked = await vscode.window.showQuickPick(
			models.map((model) => ({
				label: model.name,
				description: model.id,
				detail: `${model.maxInputTokens} input / ${model.maxOutputTokens} output tokens`,
				model,
			})),
			{
				title: "Select LiteLLM Chat Model",
				matchOnDescription: true,
				matchOnDetail: true,
				ignoreFocusOut: true,
			}
		);

		if (!picked) {
			return undefined;
		}

		await context.globalState.update(LITELLM_SELECTED_CHAT_MODEL_KEY, picked.model.id);
		return picked.model;
	};

	const showLiteLLMModels = async () => {
		const models = await provider.prepareLanguageModelChatInformation(
			{ silent: false },
			new vscode.CancellationTokenSource().token
		);

		if (models.length === 0) {
			await vscode.window.showWarningMessage(
				"LiteLLM: No models are currently available. Reconfigure LiteLLM or test the connection."
			);
			return;
		}

		const currentModelId = context.globalState.get<string>(LITELLM_SELECTED_CHAT_MODEL_KEY);
		const picked = await vscode.window.showQuickPick(
			models.map((model) => ({
				label: model.name,
				description: model.id === currentModelId ? `${model.id}  [selected]` : model.id,
				detail: `${model.maxInputTokens} input / ${model.maxOutputTokens} output tokens`,
				model,
			})),
			{
				title: `LiteLLM Models (${models.length})`,
				placeHolder: "Pick a model to make it the fallback chat model",
				matchOnDescription: true,
				matchOnDetail: true,
				ignoreFocusOut: true,
			}
		);

		if (!picked) {
			return;
		}

		await context.globalState.update(LITELLM_SELECTED_CHAT_MODEL_KEY, picked.model.id);
		await vscode.window.showInformationMessage(`LiteLLM model selected: ${picked.model.id}`);
	};

	const copyLitellmMention = async () => {
		const choice = await vscode.window.showInformationMessage(
			"LiteLLM fallback chat is ready. In Chat, type @litellm to send messages through LiteLLM.",
			"Copy Mention"
		);
		if (choice === "Copy Mention") {
			await vscode.env.clipboard.writeText("@litellm ");
		}
	};

	const runModelPickerWorkaround = async () => {
		const model = await selectLiteLLMChatModel(true, true);
		if (!model) {
			return;
		}

		await vscode.commands.executeCommand("workbench.action.chat.open");
		await copyLitellmMention();
	};

	const getFallbackWorkflowState = (): FallbackWorkflowState | undefined => {
		const raw = context.globalState.get<FallbackWorkflowState>(LITELLM_FALLBACK_WORKFLOW_STATE_KEY);
		if (!raw) {
			return undefined;
		}
		return {
			goal: raw.goal?.trim() || undefined,
			notes: Array.isArray(raw.notes) ? raw.notes.filter((n) => typeof n === "string" && n.trim().length > 0) : [],
			loopEnabled: raw.loopEnabled === true,
			pendingApproval: raw.pendingApproval === true,
			checkpoints: Array.isArray(raw.checkpoints)
				? raw.checkpoints
						.filter(
							(checkpoint) =>
								typeof checkpoint?.id === "string" &&
								Array.isArray(checkpoint?.notes) &&
								typeof checkpoint?.instruction === "string"
						)
						.map((checkpoint) => ({
							id: checkpoint.id,
							createdAt: typeof checkpoint.createdAt === "number" ? checkpoint.createdAt : Date.now(),
							goal: checkpoint.goal?.trim() || undefined,
							notes: checkpoint.notes.filter((n) => typeof n === "string" && n.trim().length > 0),
							instruction: checkpoint.instruction,
							responseSummary:
								typeof checkpoint.responseSummary === "string" ? checkpoint.responseSummary : "(no summary)",
							approved: checkpoint.approved === true,
							toolCallsIncluded: Array.isArray((checkpoint as unknown as Record<string, unknown>).toolCallsIncluded)
								? ((checkpoint as unknown as Record<string, unknown>).toolCallsIncluded as string[])
								: undefined,
						}))
				: [],
			toolCalls: Array.isArray((raw as unknown as Record<string, unknown>).toolCalls)
				? ((raw as unknown as Record<string, unknown>).toolCalls as FallbackToolCall[])
						.filter((tc) => typeof tc?.id === "string" && typeof tc?.name === "string")
						.map((tc) => ({
							id: tc.id,
							name: tc.name,
							arguments: typeof tc.arguments === "object" ? tc.arguments : {},
							status: (["pending", "approved", "rejected", "executed", "failed"] as const).includes(
								tc.status as FallbackToolCall["status"]
							)
								? (tc.status as FallbackToolCall["status"])
								: "pending",
							createdAt: typeof tc.createdAt === "number" ? tc.createdAt : Date.now(),
							executedAt: typeof tc.executedAt === "number" ? tc.executedAt : undefined,
							result: typeof tc.result === "string" ? tc.result : undefined,
							error: typeof tc.error === "string" ? tc.error : undefined,
						}))
				: [],
			pendingToolCallId:
				typeof (raw as unknown as Record<string, unknown>).pendingToolCallId === "string"
					? ((raw as unknown as Record<string, unknown>).pendingToolCallId as string)
					: undefined,
			updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
		};
	};

	const saveFallbackWorkflowState = async (state: FallbackWorkflowState): Promise<void> => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const maxNotes = Math.max(1, config.get<number>("fallbackWorkflowState.maxNotes", 20));
		const maxCheckpoints = Math.max(1, config.get<number>("fallbackWorkflowState.maxCheckpoints", 30));
		const maxToolCalls = Math.max(1, config.get<number>("fallbackWorkflowState.maxToolCalls", 50));
		const normalized: FallbackWorkflowState = {
			goal: state.goal?.trim() || undefined,
			notes: state.notes
				.map((n) => n.trim())
				.filter((n) => n.length > 0)
				.slice(-maxNotes),
			loopEnabled: state.loopEnabled === true,
			pendingApproval: state.pendingApproval === true,
			checkpoints: (state.checkpoints ?? []).slice(-maxCheckpoints),
			toolCalls: (state.toolCalls ?? []).slice(-maxToolCalls),
			pendingToolCallId: state.pendingToolCallId,
			updatedAt: Date.now(),
		};
		await context.globalState.update(LITELLM_FALLBACK_WORKFLOW_STATE_KEY, normalized);
	};

	const clearFallbackWorkflowState = async (): Promise<void> => {
		await context.globalState.update(LITELLM_FALLBACK_WORKFLOW_STATE_KEY, undefined);
	};

	const formatFallbackWorkflowState = (state?: FallbackWorkflowState): string => {
		if (!state || (!state.goal && state.notes.length === 0 && state.checkpoints.length === 0)) {
			return "No fallback workflow goal/state stored.";
		}

		const lines: string[] = ["Fallback workflow state:"];
		if (state.goal) {
			lines.push(`Goal: ${state.goal}`);
		}
		lines.push(`Loop: ${state.loopEnabled ? "enabled" : "disabled"}`);
		if (state.loopEnabled) {
			lines.push(`Approval gate: ${state.pendingApproval ? "waiting for approval" : "ready"}`);
		}
		if (state.notes.length > 0) {
			lines.push("Notes:");
			for (const [index, note] of state.notes.entries()) {
				lines.push(`${index + 1}. ${note}`);
			}
		}
		if (state.checkpoints.length > 0) {
			const latest = state.checkpoints[state.checkpoints.length - 1];
			lines.push(`Checkpoints: ${state.checkpoints.length} (latest: ${latest.id})`);
			lines.push(`Latest summary: ${latest.responseSummary}`);
		}
		lines.push(`Updated: ${new Date(state.updatedAt).toLocaleString()}`);
		return lines.join("\n");
	};

	const createCheckpointId = (): string => `cp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

	const toResponseSummary = (text: string): string => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const maxChars = Math.max(120, config.get<number>("fallbackWorkflowState.maxCheckpointSummaryChars", 600));
		const normalized = text.replace(/\s+/g, " ").trim();
		if (!normalized) {
			return "(no response text)";
		}
		if (normalized.length <= maxChars) {
			return normalized;
		}
		return `${normalized.slice(0, maxChars - 14)}... [truncated]`;
	};

	const buildWorkflowContextPrefix = (): string | undefined => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const enabled = config.get<boolean>("fallbackWorkflowState.enabled", true);
		if (!enabled) {
			return undefined;
		}

		const state = getFallbackWorkflowState();
		if (!state || (!state.goal && state.notes.length === 0)) {
			return undefined;
		}

		const lines: string[] = [
			"Persistent workflow context:",
			"Use this as task state for long-running multi-step work unless the user overrides it.",
		];
		if (state.goal) {
			lines.push(`Goal: ${state.goal}`);
		}
		if (state.notes.length > 0) {
			lines.push("State notes:");
			for (const note of state.notes) {
				lines.push(`- ${note}`);
			}
		}
		return lines.join("\n");
	};

	const withWorkflowContext = (prompt: string): string => {
		const workflowContext = buildWorkflowContextPrefix();
		if (!workflowContext) {
			return prompt;
		}
		const trimmedPrompt = prompt.trim();
		if (!trimmedPrompt) {
			return workflowContext;
		}
		return `${workflowContext}\n\n${trimmedPrompt}`;
	};

	const createToolCallId = (): string => `tc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

	const addToolCall = async (toolCall: FallbackToolCall): Promise<void> => {
		const state = getFallbackWorkflowState() ?? {
			notes: [],
			loopEnabled: false,
			pendingApproval: false,
			checkpoints: [],
			toolCalls: [],
			updatedAt: Date.now(),
		};
		await saveFallbackWorkflowState({
			...state,
			toolCalls: [...(state.toolCalls ?? []), toolCall],
			pendingToolCallId: toolCall.id,
		});
	};

	const updateToolCall = async (toolCallId: string, updates: Partial<FallbackToolCall>): Promise<void> => {
		const state = getFallbackWorkflowState();
		if (!state || !state.toolCalls) {
			return;
		}
		const updated = state.toolCalls.map((tc) => (tc.id === toolCallId ? { ...tc, ...updates } : tc));
		await saveFallbackWorkflowState({
			...state,
			toolCalls: updated,
			pendingToolCallId: updates.status === "rejected" ? undefined : state.pendingToolCallId,
		});
	};

	const getPendingToolCall = (): FallbackToolCall | undefined => {
		const state = getFallbackWorkflowState();
		if (!state || !state.pendingToolCallId) {
			return undefined;
		}
		return state.toolCalls.find((tc) => tc.id === state.pendingToolCallId);
	};

	const handleFallbackWorkflowCommand = async (
		prompt: string,
		stream: vscode.ChatResponseStream
	): Promise<FallbackWorkflowCommandResult> => {
		const trimmed = prompt.trim();
		if (!trimmed.startsWith("/")) {
			return { handled: false };
		}

		const emptyState: FallbackWorkflowState = {
			notes: [],
			loopEnabled: false,
			pendingApproval: false,
			checkpoints: [],
			toolCalls: [],
			updatedAt: Date.now(),
		};

		if (trimmed.startsWith("/goal ")) {
			const goal = trimmed.slice("/goal ".length).trim();
			if (!goal) {
				stream.markdown("Provide a goal after `/goal`, for example `/goal Finish API migration`.");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			const existing = getFallbackWorkflowState() ?? emptyState;
			await saveFallbackWorkflowState({ ...existing, goal });
			stream.markdown(`Saved fallback workflow goal:\n\n${goal}`);
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed.startsWith("/note ")) {
			const note = trimmed.slice("/note ".length).trim();
			if (!note) {
				stream.markdown("Provide a note after `/note`, for example `/note Endpoint schema validated`.");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			const existing = getFallbackWorkflowState() ?? emptyState;
			await saveFallbackWorkflowState({
				...existing,
				notes: [...existing.notes, note],
			});
			stream.markdown(`Added workflow note:\n\n${note}`);
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed.startsWith("/loop-start ")) {
			const goal = trimmed.slice("/loop-start ".length).trim();
			if (!goal) {
				stream.markdown("Provide a goal after `/loop-start`, for example `/loop-start Ship release candidate`.");
				return { handled: true, metadataMode: "fallback-loop-command" };
			}
			await saveFallbackWorkflowState({
				goal,
				notes: [],
				loopEnabled: true,
				pendingApproval: false,
				checkpoints: [],
				toolCalls: [],
				updatedAt: Date.now(),
			});
			stream.markdown(
				`Autonomous loop started.\n\nGoal: ${goal}\n\nNext: run /loop-step <instruction> to execute one guarded step.`
			);
			return { handled: true, metadataMode: "fallback-loop-command" };
		}

		if (trimmed === "/loop-status") {
			const state = getFallbackWorkflowState();
			if (!state?.loopEnabled) {
				stream.markdown("Autonomous loop is not enabled. Start with `/loop-start <goal>`. ");
				return { handled: true, metadataMode: "fallback-loop-command" };
			}
			stream.markdown(formatFallbackWorkflowState(state));
			return { handled: true, metadataMode: "fallback-loop-command" };
		}

		if (trimmed === "/loop-approve") {
			const state = getFallbackWorkflowState();
			if (!state?.loopEnabled) {
				stream.markdown("Autonomous loop is not enabled.");
				return { handled: true, metadataMode: "fallback-loop-command" };
			}
			if (!state.pendingApproval) {
				stream.markdown("No pending checkpoint approval. Run /loop-step to create a new checkpoint.");
				return { handled: true, metadataMode: "fallback-loop-command" };
			}
			if (state.checkpoints.length > 0) {
				state.checkpoints[state.checkpoints.length - 1].approved = true;
			}
			await saveFallbackWorkflowState({
				...state,
				pendingApproval: false,
				notes: [
					...state.notes,
					`Approved checkpoint ${state.checkpoints[state.checkpoints.length - 1]?.id ?? "latest"}`,
				],
			});
			stream.markdown("Checkpoint approved. You can run the next step with `/loop-step <instruction>`. ");
			return { handled: true, metadataMode: "fallback-loop-command" };
		}

		if (trimmed.startsWith("/loop-rollback")) {
			const state = getFallbackWorkflowState();
			if (!state?.loopEnabled || state.checkpoints.length === 0) {
				stream.markdown("No checkpoints available to rollback.");
				return { handled: true, metadataMode: "fallback-loop-command" };
			}
			const rawTarget = trimmed.replace("/loop-rollback", "").trim();
			let target = state.checkpoints[state.checkpoints.length - 1];
			if (rawTarget && rawTarget !== "last") {
				const found = state.checkpoints.find((checkpoint) => checkpoint.id === rawTarget);
				if (!found) {
					stream.markdown(`Checkpoint '${rawTarget}' not found.`);
					return { handled: true, metadataMode: "fallback-loop-command" };
				}
				target = found;
			}
			const targetIndex = state.checkpoints.findIndex((checkpoint) => checkpoint.id === target.id);
			await saveFallbackWorkflowState({
				goal: target.goal,
				notes: [...target.notes, `Rolled back to ${target.id}`],
				loopEnabled: true,
				pendingApproval: false,
				checkpoints: state.checkpoints.slice(0, targetIndex + 1),
				toolCalls: state.toolCalls,
				updatedAt: Date.now(),
			});
			stream.markdown(`Rolled back to checkpoint ${target.id}. Approval gate reset.`);
			return { handled: true, metadataMode: "fallback-loop-command" };
		}

		if (trimmed.startsWith("/loop-step")) {
			const state = getFallbackWorkflowState();
			if (!state?.loopEnabled) {
				stream.markdown("Autonomous loop is not enabled. Start with `/loop-start <goal>`. ");
				return { handled: true, metadataMode: "fallback-loop-command" };
			}
			if (state.pendingApproval) {
				stream.markdown(
					"Approval gate is active. Run `/loop-approve` to continue or `/loop-rollback [checkpoint-id|last]` to revert."
				);
				return { handled: true, metadataMode: "fallback-loop-command" };
			}
			if (!state.goal) {
				stream.markdown("Loop goal is missing. Set one with `/loop-start <goal>` or `/goal <goal>`. ");
				return { handled: true, metadataMode: "fallback-loop-command" };
			}
			const explicitInstruction = trimmed.replace("/loop-step", "").trim();
			const instruction = explicitInstruction || "Continue with the next safe, concrete step toward the goal.";
			const checkpointPreview = state.checkpoints
				.slice(-3)
				.map((checkpoint) => `- ${checkpoint.id}: ${checkpoint.responseSummary}`)
				.join("\n");
			const overridePrompt = [
				`Loop goal: ${state.goal}`,
				"Loop mode: execute exactly one step, then provide a concise checkpoint summary and ask for approval.",
				state.notes.length > 0 ? `State notes:\n${state.notes.map((n) => `- ${n}`).join("\n")}` : undefined,
				checkpointPreview ? `Recent checkpoints:\n${checkpointPreview}` : undefined,
				`Current step instruction: ${instruction}`,
			]
				.filter((line): line is string => Boolean(line))
				.join("\n\n");
			return {
				handled: false,
				promptOverride: overridePrompt,
				loopInstruction: instruction,
			};
		}

		if (trimmed === "/show-state") {
			stream.markdown(formatFallbackWorkflowState(getFallbackWorkflowState()));
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed === "/clear-state") {
			await clearFallbackWorkflowState();
			stream.markdown("Cleared fallback workflow state.");
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		// Tool call commands
		if (trimmed === "/tool-approve") {
			const pending = getPendingToolCall();
			if (!pending) {
				stream.markdown("No pending tool call to approve.");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}

			stream.progress(`Executing tool: ${pending.name}...`);

			try {
				const result = await executeFallbackTool(pending.name, pending.arguments);
				const executedAt = Date.now();

				if (result.success) {
					await updateToolCall(pending.id, {
						status: "executed",
						executedAt,
						result: result.output,
					});

					stream.markdown(
						`\n✓ **Tool executed successfully**: \`${pending.name}\`\n\n**Output:**\n\`\`\`\n${result.output.slice(0, 2000)}\n\`\`\``
					);

					// Clear pending flag so next tool call can be made
					const state = getFallbackWorkflowState();
					if (state) {
						await saveFallbackWorkflowState({
							...state,
							pendingToolCallId: undefined,
						});
					}
				} else {
					await updateToolCall(pending.id, {
						status: "failed",
						executedAt,
						error: result.error,
					});

					stream.markdown(`\n✗ **Tool execution failed**: \`${pending.name}\`\n\nError: \`${result.error}\``);
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				await updateToolCall(pending.id, {
					status: "failed",
					executedAt: Date.now(),
					error: errorMsg,
				});

				stream.markdown(`\n✗ **Unexpected error**: ${errorMsg}`);
			}

			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed === "/tool-reject") {
			const pending = getPendingToolCall();
			if (!pending) {
				stream.markdown("No pending tool call to reject.");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			await updateToolCall(pending.id, { status: "rejected" });

			// Clear pending flag
			const state = getFallbackWorkflowState();
			if (state) {
				await saveFallbackWorkflowState({
					...state,
					pendingToolCallId: undefined,
				});
			}

			stream.markdown(`✗ Tool call rejected: \`${pending.name}\``);
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed === "/tool-checkpoint") {
			const state = getFallbackWorkflowState();
			if (!state) {
				stream.markdown("No workflow state. Start with `/goal` or `/loop-start` first.");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}

			const toolCallsInCheckpoint = state.toolCalls.filter((tc) => tc.status === "executed").map((tc) => tc.id);

			const newCheckpoint: FallbackWorkflowCheckpoint = {
				id: createCheckpointId(),
				createdAt: Date.now(),
				goal: state.goal,
				notes: [...state.notes],
				instruction: `Tool checkpoint (${toolCallsInCheckpoint.length} executed tools)`,
				responseSummary: `Captured ${toolCallsInCheckpoint.length} tool execution${toolCallsInCheckpoint.length === 1 ? "" : "s"}`,
				approved: false,
				toolCallsIncluded: toolCallsInCheckpoint,
			};

			await saveFallbackWorkflowState({
				...state,
				checkpoints: [...state.checkpoints, newCheckpoint],
				notes: [...state.notes, `Tool checkpoint ${newCheckpoint.id}: ${newCheckpoint.responseSummary}`],
			});

			stream.markdown(
				`✓ Tool checkpoint created: \`${newCheckpoint.id}\` with ${toolCallsInCheckpoint.length} tool calls`
			);
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed === "/tool-status") {
			const state = getFallbackWorkflowState();
			if (!state || !state.toolCalls || state.toolCalls.length === 0) {
				stream.markdown("No tool calls in workflow state.");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}

			const lines: string[] = ["Tool call status:"];
			const groupedByStatus = state.toolCalls.reduce(
				(acc, tc) => {
					const group = acc[tc.status] || [];
					group.push(tc);
					acc[tc.status] = group;
					return acc;
				},
				{} as Record<string, FallbackToolCall[]>
			);

			for (const status of ["pending", "approved", "executed", "rejected", "failed"] as const) {
				const calls = groupedByStatus[status] || [];
				if (calls.length > 0) {
					lines.push(`\n**${status}** (${calls.length}):`);
					for (const tc of calls) {
						lines.push(`- ${tc.name}: ${tc.error || tc.result || "(no output yet)"}`.slice(0, 100));
					}
				}
			}

			stream.markdown(lines.join("\n"));
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed === "/help-state") {
			stream.markdown(
				"Fallback workflow commands:\n- `/goal <text>` set persistent goal\n- `/note <text>` add persistent note\n- `/show-state` show current goal/notes\n- `/clear-state` clear goal/notes\n- `/loop-start <goal>` start guarded autonomous loop\n- `/loop-step <instruction>` run one loop step\n- `/loop-approve` approve latest checkpoint\n- `/loop-rollback [checkpoint-id|last]` rollback loop state\n- `/loop-status` show loop status\n\nTool call commands:\n- `/tool-approve` approve pending tool call\n- `/tool-reject` reject pending tool call\n- `/tool-checkpoint` create checkpoint for executed tools\n- `/tool-status` show tool call statuses"
			);
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		return { handled: false };
	};

	const buildCodeBlockFingerprint = (block: { language: string; code: string }): string => {
		const normalizedLanguage = block.language.trim().toLowerCase();
		const normalizedCode = block.code.replace(/\r\n/g, "\n").trim();
		return `${normalizedLanguage}::${normalizedCode}`;
	};

	const fallbackParticipant = vscode.chat.createChatParticipant(
		LITELLM_CHAT_PARTICIPANT_ID,
		async (request, chatContext, stream, token) => {
			try {
				const workflowCommand = await handleFallbackWorkflowCommand(request.prompt, stream);
				if (workflowCommand.handled && !workflowCommand.promptOverride) {
					return {
						metadata: {
							mode: workflowCommand.metadataMode ?? "fallback-workflow-command",
						},
					};
				}

				const effectivePrompt = workflowCommand.promptOverride ?? request.prompt;

				stream.progress("Resolving LiteLLM model...");
				const selectedModel = await selectLiteLLMChatModel(true);
				if (!selectedModel) {
					return {
						errorDetails: {
							message:
								"No LiteLLM model is available. Run 'LiteLLM: Test Connection' or 'LiteLLM: Select Chat Model' first.",
						},
					};
				}

				const messages: vscode.LanguageModelChatRequestMessage[] = [];
				for (const turn of chatContext.history) {
					if (turn instanceof vscode.ChatRequestTurn) {
						messages.push(
							vscode.LanguageModelChatMessage.User(
								withWorkflowContext(await buildPromptWithReferences(turn.prompt, turn.references))
							)
						);
					} else if (turn instanceof vscode.ChatResponseTurn) {
						const text = turn.response
							.map((part) => (part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : undefined))
							.filter((value): value is string => Boolean(value))
							.join("\n\n");
						if (text) {
							messages.push(vscode.LanguageModelChatMessage.Assistant(text));
						}
					}
				}
				messages.push(
					vscode.LanguageModelChatMessage.User(
						withWorkflowContext(await buildPromptWithReferences(effectivePrompt, request.references))
					)
				);

				const fallbackModelOptionsConfig = vscode.workspace
					.getConfiguration("litellm-vscode-chat")
					.get<Record<string, Record<string, unknown>>>("fallbackModelOptions", {});
				const resolvedFallbackOptions = resolveFallbackModelOptions(selectedModel.id, fallbackModelOptionsConfig);
				if (resolvedFallbackOptions.matchedKey) {
					outputChannel.appendLine(
						`[${new Date().toISOString()}] Fallback model options matched '${resolvedFallbackOptions.matchedKey}' for ${selectedModel.id}`
					);
				}

				// Check if automatic code edits are enabled
				const autoApplyEdits = vscode.workspace
					.getConfiguration("litellm-vscode-chat")
					.get<boolean>("autoApplyCodeEdits", false);

				// Track applied edits for notification
				let appliedEditsCount = 0;
				let streamedTextBuffer = "";
				const emittedCodeBlocks = new Set<string>();
				let pendingToolCall: FallbackToolCall | undefined;

				await provider.provideLanguageModelChatResponse(
					selectedModel,
					messages,
					{
						toolMode: vscode.LanguageModelChatToolMode.Auto,
						modelOptions: resolvedFallbackOptions.options,
					},
					{
						report: (part) => {
							if (part instanceof vscode.LanguageModelTextPart) {
								const text = part.value;
								stream.markdown(text);
								streamedTextBuffer += text;

								// Parse accumulated content so fenced blocks split across streaming chunks are detected.
								const detectedBlocks = extractCodeBlocks(streamedTextBuffer);
								const blocks = detectedBlocks.filter((block) => {
									const fingerprint = buildCodeBlockFingerprint(block);
									if (emittedCodeBlocks.has(fingerprint)) {
										return false;
									}
									emittedCodeBlocks.add(fingerprint);
									return true;
								});

								if (blocks.length > 0 && autoApplyEdits) {
									stream.progress(`Auto-applying ${blocks.length} new code block${blocks.length > 1 ? "s" : ""}...`);
								}

								for (const block of blocks) {
									if (autoApplyEdits) {
										// Automatically apply to untitled editor
										applyCodeEdit(block.code)
											.then((_uri) => {
												appliedEditsCount++;
												stream.progress(
													`✓ Applied ${block.language} code to new editor (${appliedEditsCount}/${blocks.length})`
												);
											})
											.catch((error) => {
												const errorMsg = error instanceof Error ? error.message : String(error);
												stream.progress(`✗ Failed to apply ${block.language} edit: ${errorMsg}`);
												outputChannel.appendLine(
													`[${new Date().toISOString()}] Failed to auto-apply code edit: ${errorMsg}`
												);
											});
									} else {
										// Show button for manual application
										stream.button({
											title: `Apply ${block.language} edit`,
											command: "litellm.applyCodeEdit",
											arguments: [{ code: block.code, language: block.language, blockId: block.id }],
										});
									}
								}
							} else if (part instanceof vscode.LanguageModelToolCallPart) {
								// Capture tool call from model
								pendingToolCall = {
									id: createToolCallId(),
									name: part.name,
									arguments: (typeof part.input === "object" && part.input !== null ? part.input : {}) as Record<
										string,
										unknown
									>,
									status: "pending",
									createdAt: Date.now(),
								};

								// Display tool call to user
								stream.markdown(
									`\n🔧 **Tool call requested**: \`${part.name}\`\n\`\`\`json\n${JSON.stringify(part.input ?? {}, null, 2)}\n\`\`\``
								);
								stream.markdown(
									"Use `/tool-approve` to execute this tool or `/tool-reject` to skip it. Waiting for your decision..."
								);
							}
						},
					},
					token
				);

				// If there was a tool call, add it to the workflow state and wait for approval
				if (pendingToolCall) {
					await addToolCall(pendingToolCall);

					// Show approval action buttons
					stream.button({
						title: "✓ Approve Tool",
						command: "vscode.chat.openSymbolFromResult",
						arguments: [],
					});
					stream.button({
						title: "✗ Reject Tool",
						command: "vscode.chat.openSymbolFromResult",
						arguments: [],
					});

					// For now, in fallback chat we just inform the user to use commands
					stream.markdown(
						"\n**Next step:** Type `/tool-approve` to execute the tool request, or `/tool-reject` to skip it."
					);
				}

				if (workflowCommand.loopInstruction) {
					const state = getFallbackWorkflowState();
					if (state?.loopEnabled) {
						const checkpoint: FallbackWorkflowCheckpoint = {
							id: createCheckpointId(),
							createdAt: Date.now(),
							goal: state.goal,
							notes: [...state.notes],
							instruction: workflowCommand.loopInstruction,
							responseSummary: toResponseSummary(streamedTextBuffer),
							approved: false,
						};
						const requireApproval = vscode.workspace
							.getConfiguration("litellm-vscode-chat")
							.get<boolean>("fallbackWorkflowState.requireApprovalGate", true);
						await saveFallbackWorkflowState({
							...state,
							pendingApproval: requireApproval,
							checkpoints: [...state.checkpoints, checkpoint],
							notes: [...state.notes, `Checkpoint ${checkpoint.id}: ${checkpoint.responseSummary}`],
						});
						if (requireApproval) {
							stream.progress(
								`Checkpoint ${checkpoint.id} created. Approval required before next /loop-step. Use /loop-approve or /loop-rollback.`
							);
						}
					}
				}

				return {
					metadata: {
						modelId: selectedModel.id,
						mode: workflowCommand.loopInstruction ? "fallback-loop-step" : "fallback-chat-participant",
					},
				};
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				outputChannel.appendLine(`[${new Date().toISOString()}] LiteLLM fallback chat error: ${errorMsg}`);
				return {
					errorDetails: {
						message: `LiteLLM fallback chat failed: ${errorMsg}`,
					},
				};
			}
		}
	);
	fallbackParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, "assets", "logo.png");
	context.subscriptions.push(fallbackParticipant);
	// Register provider when LM API is available. Some runtimes initialize chat APIs later,
	// so we retry once after startup and when extension state changes.
	let providerRegistered = false;
	const tryRegisterLanguageModelProvider = (source: string): void => {
		if (providerRegistered) {
			return;
		}

		try {
			const lmApi = getLanguageModelApi();
			if (lmApi?.registerLanguageModelChatProvider) {
				context.subscriptions.push(lmApi.registerLanguageModelChatProvider(LITELLM_VENDOR, provider));
				providerRegistered = true;
				outputChannel.appendLine(`[${new Date().toISOString()}] Language model provider registered (${source}).`);
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			outputChannel.appendLine(`[${new Date().toISOString()}] Failed to register language model provider: ${errorMsg}`);
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.retryProviderRegistration", async () => {
			tryRegisterLanguageModelProvider("manual-retry");
			if (providerRegistered) {
				await vscode.window.showInformationMessage("LiteLLM provider registration succeeded.");
			} else {
				await vscode.window.showWarningMessage(
					"LiteLLM provider is still unavailable. Ensure GitHub Copilot Chat is enabled, then try again."
				);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.selectChatModel", async () => {
			const model = await selectLiteLLMChatModel(true, true);
			if (model) {
				await vscode.window.showInformationMessage(`LiteLLM chat model selected: ${model.id}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.openFallbackChat", async () => {
			await selectLiteLLMChatModel(true);
			await vscode.commands.executeCommand("workbench.action.chat.open");
			await copyLitellmMention();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.use103ModelPickerWorkaround", async () => {
			await runModelPickerWorkaround();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.showModels", async () => {
			await showLiteLLMModels();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.setFallbackTaskGoal", async () => {
			const existing = getFallbackWorkflowState();
			const goal = await vscode.window.showInputBox({
				title: "Set Fallback Task Goal",
				prompt: "Define the persistent goal for fallback chat (@litellm).",
				ignoreFocusOut: true,
				value: existing?.goal ?? "",
			});
			if (goal === undefined) {
				return;
			}

			const trimmedGoal = goal.trim();
			if (!trimmedGoal) {
				await vscode.window.showWarningMessage(
					"Task goal cannot be empty. Use Clear Fallback Task State to remove it."
				);
				return;
			}

			await saveFallbackWorkflowState({
				goal: trimmedGoal,
				notes: existing?.notes ?? [],
				loopEnabled: existing?.loopEnabled ?? false,
				pendingApproval: existing?.pendingApproval ?? false,
				checkpoints: existing?.checkpoints ?? [],
				toolCalls: existing?.toolCalls ?? [],
				updatedAt: Date.now(),
			});
			await vscode.window.showInformationMessage("Fallback task goal saved.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.addFallbackTaskNote", async () => {
			const note = await vscode.window.showInputBox({
				title: "Add Fallback Task Note",
				prompt: "Add a persistent note/checkpoint for fallback chat (@litellm).",
				ignoreFocusOut: true,
			});
			if (note === undefined) {
				return;
			}

			const trimmedNote = note.trim();
			if (!trimmedNote) {
				await vscode.window.showWarningMessage("Task note cannot be empty.");
				return;
			}

			const existing =
				getFallbackWorkflowState() ??
				({
					notes: [],
					loopEnabled: false,
					pendingApproval: false,
					checkpoints: [],
					toolCalls: [],
					updatedAt: Date.now(),
				} satisfies FallbackWorkflowState);
			await saveFallbackWorkflowState({
				...existing,
				notes: [...existing.notes, trimmedNote],
				toolCalls: existing.toolCalls,
			});
			await vscode.window.showInformationMessage("Fallback task note added.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.showFallbackTaskState", async () => {
			const formatted = formatFallbackWorkflowState(getFallbackWorkflowState());
			await vscode.window.showInformationMessage(formatted, { modal: true }, "Clear State").then((choice) => {
				if (choice === "Clear State") {
					vscode.commands.executeCommand("litellm.clearFallbackTaskState");
				}
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.clearFallbackTaskState", async () => {
			await clearFallbackWorkflowState();
			await vscode.window.showInformationMessage("Fallback workflow state cleared.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.toggleAutoApplyCodeEdits", async () => {
			const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
			const currentValue = config.get<boolean>("autoApplyCodeEdits", false);
			const newValue = !currentValue;

			try {
				await config.update("autoApplyCodeEdits", newValue, vscode.ConfigurationTarget.Global);
				const status = newValue ? "enabled" : "disabled";
				await vscode.window.showInformationMessage(`Auto-apply code edits ${status} for fallback chat (@litellm).`);
				outputChannel.appendLine(`[${new Date().toISOString()}] Auto-apply code edits ${status} by user.`);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				await vscode.window.showErrorMessage(`Failed to toggle auto-apply code edits: ${errorMsg}`);
				outputChannel.appendLine(`[${new Date().toISOString()}] Failed to toggle auto-apply code edits: ${errorMsg}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"litellm.applyCodeEdit",
			async (editRequest?: { code: string; language: string; blockId: string }) => {
				if (!editRequest || !editRequest.code) {
					await vscode.window.showErrorMessage("No code edit provided.");
					return;
				}

				const activeEditor = vscode.window.activeTextEditor;
				const currentFile = activeEditor?.document.uri.fsPath;

				try {
					// If there's an active editor in a workspace file, ask user about replacement
					if (currentFile && vscode.workspace.workspaceFolders?.length) {
						const choice = await vscode.window.showQuickPick(
							[
								{
									label: "Replace current file",
									description: currentFile,
									value: "replace",
								},
								{
									label: "Open in new untitled editor",
									value: "new",
								},
							],
							{ title: "Apply Code Edit" }
						);

						if (!choice) {
							return;
						}

						if (choice.value === "replace") {
							const appliedUri = await applyCodeEdit(editRequest.code, currentFile);
							await vscode.window.showInformationMessage(
								`Code edit applied: ${appliedUri.fsPath || appliedUri.scheme}`
							);
						} else {
							const appliedUri = await applyCodeEdit(editRequest.code);
							await vscode.window.showInformationMessage(
								`Code edit applied: ${appliedUri.fsPath || appliedUri.scheme}`
							);
						}
					} else {
						// No active editor, create untitled
						await applyCodeEdit(editRequest.code);
						await vscode.window.showInformationMessage(`Suggested edit opened in new editor.`);
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					await vscode.window.showErrorMessage(`Failed to apply code edit: ${errorMsg}`);
					outputChannel.appendLine(`[${new Date().toISOString()}] Code edit error: ${errorMsg}`);
				}
			}
		)
	);

	tryRegisterLanguageModelProvider("activate");
	if (!providerRegistered && copilotChatExtension) {
		Promise.resolve(copilotChatExtension.activate())
			.then(() => {
				tryRegisterLanguageModelProvider("copilot-chat-activate");
			})
			.catch((error) => {
				const errorMsg = error instanceof Error ? error.message : String(error);
				outputChannel.appendLine(
					`[${new Date().toISOString()}] Failed to activate GitHub Copilot Chat extension: ${errorMsg}`
				);
			});
	}
	if (!providerRegistered) {
		outputChannel.appendLine(
			`Language model API not available right now (VS Code ${vscode.version}). Ensure GitHub Copilot Chat is enabled, then reload window. If you are on 1.103.x, upgrade to 1.108+ for best third-party model picker support.`
		);
		if (!copilotChatExtension) {
			outputChannel.appendLine(
				"GitHub Copilot Chat extension is not installed; LiteLLM model provider cannot be registered."
			);
		}
		vscode.window
			.showWarningMessage(
				"LiteLLM: Language model API is unavailable. Enable/install GitHub Copilot Chat and reload VS Code. On 1.103.x, upgrade to 1.108+ if LiteLLM does not appear in Manage Models.",
				"Reload Window",
				"Search Extensions",
				"Retry Registration",
				"Open Fallback Chat",
				"Use 1.103 Workaround"
			)
			.then((choice) => {
				if (choice === "Reload Window") {
					vscode.commands.executeCommand("workbench.action.reloadWindow");
				} else if (choice === "Search Extensions") {
					vscode.commands.executeCommand("workbench.extensions.search", "GitHub Copilot Chat");
				} else if (choice === "Retry Registration") {
					vscode.commands.executeCommand("litellm.retryProviderRegistration");
				} else if (choice === "Open Fallback Chat") {
					vscode.commands.executeCommand("litellm.openFallbackChat");
				} else if (choice === "Use 1.103 Workaround") {
					vscode.commands.executeCommand("litellm.use103ModelPickerWorkaround");
				}
			});

		const delayedRetry = setTimeout(() => {
			tryRegisterLanguageModelProvider("delayed-retry");
		}, 3000);
		context.subscriptions.push({
			dispose: () => clearTimeout(delayedRetry),
		});

		const retryInterval = setInterval(() => {
			tryRegisterLanguageModelProvider("periodic-retry");
			if (providerRegistered) {
				clearInterval(retryInterval);
			}
		}, 5000);
		context.subscriptions.push({
			dispose: () => clearInterval(retryInterval),
		});

		const stopRetryTimer = setTimeout(() => {
			clearInterval(retryInterval);
		}, 120000);
		context.subscriptions.push({
			dispose: () => clearTimeout(stopRetryTimer),
		});

		context.subscriptions.push(
			vscode.extensions.onDidChange(() => {
				tryRegisterLanguageModelProvider("extensions-changed");
			})
		);
	}

	// Connection status tracking
	interface ConnectionStatus {
		state: "not-configured" | "loading" | "connected" | "error";
		modelCount?: number;
		error?: string;
		lastChecked?: number; // Store as timestamp (milliseconds since epoch)
	}

	let connectionStatus: ConnectionStatus = { state: "not-configured" };

	// Create status bar indicator
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = "litellm.showDiagnostics";
	context.subscriptions.push(statusBarItem);

	// Function to update status bar based on connection state
	async function updateStatusBar(status?: ConnectionStatus) {
		if (status) {
			connectionStatus = status;
			// Persist state for next reload
			await context.globalState.update("litellm.lastConnectionStatus", status);
		}

		const baseUrl = await context.secrets.get("litellm.baseUrl");

		switch (connectionStatus.state) {
			case "not-configured":
				statusBarItem.text = "$(warning) LiteLLM";
				statusBarItem.tooltip = "Not configured - click to set up";
				statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
				break;
			case "loading":
				statusBarItem.text = "$(loading~spin) LiteLLM";
				statusBarItem.tooltip = "Fetching models...";
				statusBarItem.backgroundColor = undefined;
				break;
			case "connected": {
				const count = connectionStatus.modelCount ?? 0;
				statusBarItem.text = `$(check) LiteLLM (${count})`;
				statusBarItem.tooltip = `Connected to ${baseUrl}\n${count} model${count === 1 ? "" : "s"} available\nClick for diagnostics`;
				statusBarItem.backgroundColor = undefined;
				break;
			}
			case "error":
				statusBarItem.text = "$(error) LiteLLM";
				statusBarItem.tooltip = `Connection failed\n${connectionStatus.error || "Unknown error"}\nClick for details`;
				statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
				break;
		}
		statusBarItem.show();
	}

	// Restore last known state from previous session
	const lastStatus = context.globalState.get<ConnectionStatus>("litellm.lastConnectionStatus");
	if (lastStatus) {
		connectionStatus = lastStatus;
	}

	// Initial status bar update
	updateStatusBar();

	// Update when secrets change
	context.subscriptions.push(
		context.secrets.onDidChange((e) => {
			if (e.key === "litellm.baseUrl" || e.key === "litellm.apiKey") {
				updateStatusBar({ state: "not-configured" });
				provider.notifyLanguageModelChatInformationChanged();
			}
		})
	);

	// Provide status update callback to provider
	provider.setStatusCallback((modelCount: number, error?: string) => {
		if (error) {
			outputChannel.appendLine(`[${new Date().toISOString()}] Model fetch failed: ${error}`);
			updateStatusBar({ state: "error", error, lastChecked: Date.now() });
		} else if (modelCount === 0) {
			outputChannel.appendLine(`[${new Date().toISOString()}] Warning: Server returned 0 models`);
			updateStatusBar({ state: "error", modelCount: 0, error: "Server returned 0 models", lastChecked: Date.now() });
		} else {
			outputChannel.appendLine(`[${new Date().toISOString()}] Successfully fetched ${modelCount} models`);
			updateStatusBar({ state: "connected", modelCount, lastChecked: Date.now() });
		}
	});

	// Show welcome message on first run for unconfigured users
	const hasShownWelcome = context.globalState.get<boolean>("litellm.hasShownWelcome", false);
	if (!hasShownWelcome) {
		context.secrets.get("litellm.baseUrl").then((baseUrl) => {
			if (!baseUrl) {
				vscode.window
					.showInformationMessage(
						"Welcome to LiteLLM! Connect to 100+ LLMs in VS Code.",
						"Configure Now",
						"Documentation"
					)
					.then((choice) => {
						if (choice === "Configure Now") {
							vscode.commands.executeCommand("litellm.manage");
						} else if (choice === "Documentation") {
							vscode.env.openExternal(vscode.Uri.parse("https://github.com/rx5426/litellm-vscode-chat#quick-start"));
						}
					});
			}
		});
		context.globalState.update("litellm.hasShownWelcome", true);
	}

	// On VS Code 1.103.x, proactively surface the workaround once.
	if (likelyLimitedModelPickerUi) {
		const hasShown103WorkaroundHint = context.globalState.get<boolean>("litellm.hasShown103WorkaroundHint", false);
		if (!hasShown103WorkaroundHint) {
			vscode.window
				.showInformationMessage(
					"LiteLLM: On VS Code 1.103.x, third-party models may not appear in Manage Models. Use the built-in workaround to pick a LiteLLM model and chat via @litellm.",
					"Use 1.103 Workaround",
					"Dismiss"
				)
				.then((choice) => {
					if (choice === "Use 1.103 Workaround") {
						vscode.commands.executeCommand("litellm.use103ModelPickerWorkaround");
					}
				});
			context.globalState.update("litellm.hasShown103WorkaroundHint", true);
		}
	}

	// Management command to configure base URL and API key
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.manage", async () => {
			// First, prompt for base URL
			const existingBaseUrl = await context.secrets.get("litellm.baseUrl");
			const baseUrl = await vscode.window.showInputBox({
				title: "LiteLLM Base URL",
				prompt: existingBaseUrl
					? "Update your LiteLLM base URL"
					: "Enter your LiteLLM base URL (e.g., http://localhost:4000 or https://api.litellm.ai)",
				ignoreFocusOut: true,
				value: existingBaseUrl ?? "",
				placeHolder: "http://localhost:4000",
				validateInput: (value) => {
					if (!value.trim()) {
						return "Base URL is required";
					}
					if (!value.startsWith("http://") && !value.startsWith("https://")) {
						return "URL must start with http:// or https://";
					}
					return null;
				},
			});
			if (baseUrl === undefined) {
				return; // user canceled
			}

			// Then, prompt for API key
			const existingApiKey = await context.secrets.get("litellm.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "LiteLLM API Key",
				prompt: existingApiKey
					? "Update your LiteLLM API key"
					: "Enter your LiteLLM API key (leave empty if not required)",
				ignoreFocusOut: true,
				password: true,
				value: existingApiKey ?? "",
			});
			if (apiKey === undefined) {
				return; // user canceled
			}

			// Save or clear the values
			if (!baseUrl.trim()) {
				await context.secrets.delete("litellm.baseUrl");
			} else {
				await context.secrets.store("litellm.baseUrl", baseUrl.trim());
			}

			if (!apiKey.trim()) {
				await context.secrets.delete("litellm.apiKey");
			} else {
				await context.secrets.store("litellm.apiKey", apiKey.trim());
			}

			// Update status bar to reflect new configuration
			await updateStatusBar({ state: "not-configured" });
			provider.notifyLanguageModelChatInformationChanged();
			outputChannel.appendLine(`[${new Date().toISOString()}] Configuration updated: ${baseUrl.trim()}`);

			// Show success message with test connection option
			vscode.window
				.showInformationMessage("LiteLLM configuration saved!", "Test Connection", "Open Chat", "Dismiss")
				.then((choice) => {
					if (choice === "Test Connection") {
						vscode.commands.executeCommand("litellm.testConnection");
					} else if (choice === "Open Chat") {
						vscode.commands.executeCommand("workbench.action.chat.open");
					}
				});
		})
	);

	// Test connection command
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.testConnection", async () => {
			const baseUrl = await context.secrets.get("litellm.baseUrl");
			if (!baseUrl) {
				vscode.window.showErrorMessage("LiteLLM is not configured. Please run 'Manage LiteLLM Provider' first.");
				return;
			}

			outputChannel.appendLine(`\n[${new Date().toISOString()}] Testing connection to ${baseUrl}...`);
			outputChannel.show(true);

			try {
				// Update status to loading
				await updateStatusBar({ state: "loading" });

				// Trigger model fetch by calling the provider method
				const models = await provider.prepareLanguageModelChatInformation(
					{ silent: false },
					new vscode.CancellationTokenSource().token
				);

				if (models.length === 0) {
					outputChannel.appendLine(`[${new Date().toISOString()}] WARNING: Server returned 0 models`);
					vscode.window
						.showWarningMessage(
							`LiteLLM: Connected to ${baseUrl}, but server returned no models. Check your LiteLLM proxy configuration.`,
							"View Output",
							"Reconfigure"
						)
						.then((choice) => {
							if (choice === "View Output") {
								outputChannel.show();
							} else if (choice === "Reconfigure") {
								vscode.commands.executeCommand("litellm.manage");
							}
						});
				} else {
					outputChannel.appendLine(`[${new Date().toISOString()}] SUCCESS: Found ${models.length} models`);
					vscode.window
						.showInformationMessage(
							`LiteLLM: Connection successful! Found ${models.length} model${models.length === 1 ? "" : "s"}.`,
							"View Models",
							"Open Chat"
						)
						.then((choice) => {
							if (choice === "View Models") {
								outputChannel.show();
							} else if (choice === "Open Chat") {
								vscode.commands.executeCommand("workbench.action.chat.open");
							}
						});
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				outputChannel.appendLine(`[${new Date().toISOString()}] ERROR: ${errorMsg}`);
				vscode.window
					.showErrorMessage(`LiteLLM: Connection failed - ${errorMsg}`, "View Output", "Reconfigure")
					.then((choice) => {
						if (choice === "View Output") {
							outputChannel.show();
						} else if (choice === "Reconfigure") {
							vscode.commands.executeCommand("litellm.manage");
						}
					});
			}
		})
	);

	// Backward-compatible alias for callers using lowercase command id
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.testconnection", () =>
			vscode.commands.executeCommand("litellm.testConnection")
		)
	);

	// Show diagnostics command
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.showDiagnostics", async () => {
			try {
				const baseUrl = await context.secrets.get("litellm.baseUrl");
				const hasApiKey = !!(await context.secrets.get("litellm.apiKey"));
				const lmApi = getLanguageModelApi();
				const hasLanguageModelApi = !!lmApi?.registerLanguageModelChatProvider;
				const selectedChatModel = context.globalState.get<string>(LITELLM_SELECTED_CHAT_MODEL_KEY);

				const statusText =
					connectionStatus.state === "not-configured"
						? "Not configured"
						: connectionStatus.state === "loading"
							? "Loading..."
							: connectionStatus.state === "connected"
								? `Connected (${connectionStatus.modelCount ?? 0} models)`
								: `Error: ${connectionStatus.error || "Unknown error"}`;

				const lastCheckedText = connectionStatus.lastChecked
					? new Date(connectionStatus.lastChecked).toLocaleString()
					: "Never";

				const diagnosticMessage = [
					"LiteLLM Diagnostics",
					"",
					`Runtime:`,
					`  VS Code: ${vscode.version}`,
					`  Language Model API: ${hasLanguageModelApi ? "Available" : "Unavailable"}`,
					"",
					`Configuration:`,
					`  Base URL: ${baseUrl || "Not set"}`,
					`  API Key: ${hasApiKey ? "Configured" : "Not set"}`,
					`  Fallback Chat Model: ${selectedChatModel || "Not selected"}`,
					"",
					`Connection Status: ${statusText}`,
					`Last Checked: ${lastCheckedText}`,
					"",
					likelyLimitedModelPickerUi
						? "Note: On VS Code 1.103.x, third-party providers may not appear in Manage Models. Upgrade to 1.108+ for best support."
						: "Check the LiteLLM output channel for detailed logs.",
				].join("\n");

				const choice = await vscode.window.showInformationMessage(
					diagnosticMessage,
					{ modal: true },
					"View Output",
					"Test Connection",
					"Reconfigure",
					"Open Fallback Chat"
				);

				if (choice === "View Output") {
					outputChannel.show();
				} else if (choice === "Test Connection") {
					vscode.commands.executeCommand("litellm.testConnection");
				} else if (choice === "Reconfigure") {
					vscode.commands.executeCommand("litellm.manage");
				} else if (choice === "Open Fallback Chat") {
					vscode.commands.executeCommand("litellm.openFallbackChat");
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				outputChannel.appendLine(`[${new Date().toISOString()}] Show Diagnostics error: ${errorMsg}`);
				vscode.window.showErrorMessage(`LiteLLM diagnostics error: ${errorMsg}`, "View Output").then((choice) => {
					if (choice === "View Output") {
						outputChannel.show();
					}
				});
			}
		})
	);

	// Backward-compatible alias for callers using lowercase command id
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.showdiagnostics", () =>
			vscode.commands.executeCommand("litellm.showDiagnostics")
		)
	);

	// Backward-compatible alias for callers using lowercase command id
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.retryproviderregistration", () =>
			vscode.commands.executeCommand("litellm.retryProviderRegistration")
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.showmodels", () => vscode.commands.executeCommand("litellm.showModels"))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.selectchatmodel", () =>
			vscode.commands.executeCommand("litellm.selectChatModel")
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.openfallbackchat", () =>
			vscode.commands.executeCommand("litellm.openFallbackChat")
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.use103modelpickerworkaround", () =>
			vscode.commands.executeCommand("litellm.use103ModelPickerWorkaround")
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.setfallbacktaskgoal", () =>
			vscode.commands.executeCommand("litellm.setFallbackTaskGoal")
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.addfallbacktasknote", () =>
			vscode.commands.executeCommand("litellm.addFallbackTaskNote")
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.showfallbacktaskstate", () =>
			vscode.commands.executeCommand("litellm.showFallbackTaskState")
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.clearfallbacktaskstate", () =>
			vscode.commands.executeCommand("litellm.clearFallbackTaskState")
		)
	);
}

export function deactivate() {}
