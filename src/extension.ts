import * as vscode from "vscode";
import * as path from "node:path";
import { LiteLLMChatModelProvider } from "./provider";
import {
	buildPromptWithReferences,
	extractStructuredEdits,
	extractCodeBlocks,
	applyCodeEdit,
	applyStructuredEdit,
	resolveFallbackModelOptions,
	executeFallbackTool,
	formatToolResult,
} from "./utils";
import type { FallbackToolResultMeta } from "./utils";

const LITELLM_VENDOR = "litellm";
const LITELLM_CHAT_PARTICIPANT_ID = "rx5426.litellm-chat";
const LITELLM_SELECTED_CHAT_MODEL_KEY = "litellm.selectedChatModel";
const LITELLM_FALLBACK_WORKFLOW_STATE_KEY = "litellm.fallbackWorkflowState";
const LITELLM_PENDING_EDIT_BATCH_STATE_KEY = "litellm.pendingEditBatch";
const LITELLM_FALLBACK_TELEMETRY_KEY = "litellm.fallbackTelemetry";

interface FallbackToolCall {
	id: string;
	name: string; // Fallback tool name (read_file/write_file/execute_command/git_command/run_tests/etc)
	arguments: Record<string, unknown>;
	status: "pending" | "approved" | "rejected" | "executed" | "failed";
	createdAt: number;
	executedAt?: number;
	result?: string;
	error?: string;
	resultMeta?: FallbackToolResultMeta;
}

type FallbackToolMode = "auto" | "required" | "none";

interface FallbackWorkflowState {
	goal?: string;
	notes: string[];
	loopEnabled: boolean;
	pendingApproval: boolean;
	checkpoints: FallbackWorkflowCheckpoint[];
	toolCalls: FallbackToolCall[];
	pendingToolCallId?: string; // The currently-pending tool call awaiting approval
	updatedAt: number;
	// Tool loop state
	toolLoopActive?: boolean; // Whether automated multi-step tool loop is running
	toolLoopGoal?: string; // Goal for the current tool loop session
	toolLoopStepCap?: number; // Max total tool steps before stopping
	toolLoopRetryLimit?: number; // Max consecutive failures before stopping
	toolLoopCheckpointInterval?: number; // Pause for approval every N steps (0 = never)
	toolLoopStepsRun?: number; // Steps completed in the current loop session
	toolLoopConsecutiveFailures?: number; // Consecutive failure counter for retry-limit
	toolModeOverride?: FallbackToolMode; // Optional per-session tool mode override
	requiredToolName?: string; // Tool name used when mode=required
	runtimeTemperature?: number; // Per-session temperature override
	runtimeMaxTokens?: number; // Per-session max_tokens override
	runtimeStopSequences?: string[]; // Per-session stop sequence override
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

interface FallbackPendingEdit {
	id: string;
	path: string;
	intent: "create" | "replace";
	content: string;
	language?: string;
	description?: string;
	status: "pending" | "accepted" | "rejected" | "applied" | "failed";
	error?: string;
}

interface FallbackPendingEditBatch {
	id: string;
	createdAt: number;
	modelId?: string;
	edits: FallbackPendingEdit[];
}

interface FallbackEditPolicy {
	pathRequired: boolean;
	sameFileOnly: boolean;
	workspaceOnly: boolean;
	maxFilesPerResponse?: number;
}

interface FallbackTelemetryCounters {
	toolFailures: number;
	editMisses: number;
	pathInferenceMisses: number;
	approvalRejects: number;
	providerRegistrationIssues: number;
	lastUpdated: number;
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
			// Tool loop fields
			toolLoopActive: (raw as unknown as Record<string, unknown>).toolLoopActive === true ? true : undefined,
			toolLoopGoal:
				typeof (raw as unknown as Record<string, unknown>).toolLoopGoal === "string"
					? ((raw as unknown as Record<string, unknown>).toolLoopGoal as string).trim() || undefined
					: undefined,
			toolLoopStepCap:
				typeof (raw as unknown as Record<string, unknown>).toolLoopStepCap === "number"
					? ((raw as unknown as Record<string, unknown>).toolLoopStepCap as number)
					: undefined,
			toolLoopRetryLimit:
				typeof (raw as unknown as Record<string, unknown>).toolLoopRetryLimit === "number"
					? ((raw as unknown as Record<string, unknown>).toolLoopRetryLimit as number)
					: undefined,
			toolLoopCheckpointInterval:
				typeof (raw as unknown as Record<string, unknown>).toolLoopCheckpointInterval === "number"
					? ((raw as unknown as Record<string, unknown>).toolLoopCheckpointInterval as number)
					: undefined,
			toolLoopStepsRun:
				typeof (raw as unknown as Record<string, unknown>).toolLoopStepsRun === "number"
					? ((raw as unknown as Record<string, unknown>).toolLoopStepsRun as number)
					: undefined,
			toolLoopConsecutiveFailures:
				typeof (raw as unknown as Record<string, unknown>).toolLoopConsecutiveFailures === "number"
					? ((raw as unknown as Record<string, unknown>).toolLoopConsecutiveFailures as number)
					: undefined,
			toolModeOverride:
				typeof (raw as unknown as Record<string, unknown>).toolModeOverride === "string" &&
				["auto", "required", "none"].includes(
					((raw as unknown as Record<string, unknown>).toolModeOverride as string).toLowerCase()
				)
					? (((raw as unknown as Record<string, unknown>).toolModeOverride as string).toLowerCase() as FallbackToolMode)
					: undefined,
			requiredToolName:
				typeof (raw as unknown as Record<string, unknown>).requiredToolName === "string"
					? ((raw as unknown as Record<string, unknown>).requiredToolName as string).trim() || undefined
					: undefined,
			runtimeTemperature:
				typeof (raw as unknown as Record<string, unknown>).runtimeTemperature === "number"
					? ((raw as unknown as Record<string, unknown>).runtimeTemperature as number)
					: undefined,
			runtimeMaxTokens:
				typeof (raw as unknown as Record<string, unknown>).runtimeMaxTokens === "number"
					? ((raw as unknown as Record<string, unknown>).runtimeMaxTokens as number)
					: undefined,
			runtimeStopSequences: Array.isArray((raw as unknown as Record<string, unknown>).runtimeStopSequences)
				? ((raw as unknown as Record<string, unknown>).runtimeStopSequences as unknown[])
						.filter((value) => typeof value === "string" && value.trim().length > 0)
						.map((value) => (value as string).trim())
				: undefined,
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
			// Tool loop fields
			toolLoopActive: state.toolLoopActive === true ? true : undefined,
			toolLoopGoal: state.toolLoopGoal?.trim() || undefined,
			toolLoopStepCap: typeof state.toolLoopStepCap === "number" ? state.toolLoopStepCap : undefined,
			toolLoopRetryLimit: typeof state.toolLoopRetryLimit === "number" ? state.toolLoopRetryLimit : undefined,
			toolLoopCheckpointInterval:
				typeof state.toolLoopCheckpointInterval === "number" ? state.toolLoopCheckpointInterval : undefined,
			toolLoopStepsRun: typeof state.toolLoopStepsRun === "number" ? state.toolLoopStepsRun : undefined,
			toolLoopConsecutiveFailures:
				typeof state.toolLoopConsecutiveFailures === "number" ? state.toolLoopConsecutiveFailures : undefined,
			toolModeOverride:
				state.toolModeOverride === "auto" || state.toolModeOverride === "required" || state.toolModeOverride === "none"
					? state.toolModeOverride
					: undefined,
			requiredToolName: state.requiredToolName?.trim() || undefined,
			runtimeTemperature: typeof state.runtimeTemperature === "number" ? state.runtimeTemperature : undefined,
			runtimeMaxTokens: typeof state.runtimeMaxTokens === "number" ? state.runtimeMaxTokens : undefined,
			runtimeStopSequences:
				Array.isArray(state.runtimeStopSequences) && state.runtimeStopSequences.length > 0
					? state.runtimeStopSequences.map((value) => value.trim()).filter((value) => value.length > 0)
					: undefined,
		};
		await context.globalState.update(LITELLM_FALLBACK_WORKFLOW_STATE_KEY, normalized);
	};

	const clearFallbackWorkflowState = async (): Promise<void> => {
		await context.globalState.update(LITELLM_FALLBACK_WORKFLOW_STATE_KEY, undefined);
	};

	const getPendingEditBatch = (): FallbackPendingEditBatch | undefined =>
		context.globalState.get<FallbackPendingEditBatch>(LITELLM_PENDING_EDIT_BATCH_STATE_KEY);

	const getFallbackTelemetry = (): FallbackTelemetryCounters => {
		const raw = context.globalState.get<Partial<FallbackTelemetryCounters>>(LITELLM_FALLBACK_TELEMETRY_KEY) ?? {};
		return {
			toolFailures: typeof raw.toolFailures === "number" ? raw.toolFailures : 0,
			editMisses: typeof raw.editMisses === "number" ? raw.editMisses : 0,
			pathInferenceMisses: typeof raw.pathInferenceMisses === "number" ? raw.pathInferenceMisses : 0,
			approvalRejects: typeof raw.approvalRejects === "number" ? raw.approvalRejects : 0,
			providerRegistrationIssues:
				typeof raw.providerRegistrationIssues === "number" ? raw.providerRegistrationIssues : 0,
			lastUpdated: typeof raw.lastUpdated === "number" ? raw.lastUpdated : 0,
		};
	};

	const bumpFallbackTelemetry = async (
		key: keyof Omit<FallbackTelemetryCounters, "lastUpdated">,
		delta = 1
	): Promise<void> => {
		const current = getFallbackTelemetry();
		const next: FallbackTelemetryCounters = {
			...current,
			[key]: (current[key] as number) + delta,
			lastUpdated: Date.now(),
		} as FallbackTelemetryCounters;
		await context.globalState.update(LITELLM_FALLBACK_TELEMETRY_KEY, next);
	};

	const savePendingEditBatch = async (batch: FallbackPendingEditBatch | undefined): Promise<void> => {
		await context.globalState.update(LITELLM_PENDING_EDIT_BATCH_STATE_KEY, batch);
	};

	const clearPendingEditBatch = async (): Promise<void> => {
		await savePendingEditBatch(undefined);
	};

	const getFallbackSafetyLimits = () => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const maxPromptChars = Math.max(4000, config.get<number>("fallbackSafety.maxPromptChars", 24000));
		const maxHistoryTurns = Math.max(1, config.get<number>("fallbackSafety.maxHistoryTurns", 8));
		const maxResponseBufferChars = Math.max(12000, config.get<number>("fallbackSafety.maxResponseBufferChars", 120000));
		const maxStreamPartChars = Math.max(1000, config.get<number>("fallbackSafety.maxStreamPartChars", 12000));
		const maxToolResultChars = Math.max(500, config.get<number>("fallbackToolCalling.maxOutputChars", 4000));
		const maxLoopStepCapHard = Math.max(5, config.get<number>("fallbackSafety.maxLoopStepCapHard", 50));
		return {
			maxPromptChars,
			maxHistoryTurns,
			maxResponseBufferChars,
			maxStreamPartChars,
			maxToolResultChars,
			maxLoopStepCapHard,
		};
	};

	const clipTextWithNotice = (
		text: string,
		maxChars: number,
		notice = "[truncated]"
	): { text: string; truncated: boolean; originalLength: number } => {
		if (text.length <= maxChars) {
			return { text, truncated: false, originalLength: text.length };
		}
		const suffix = `\n... ${notice}`;
		const keep = Math.max(0, maxChars - suffix.length);
		return {
			text: `${text.slice(0, keep)}${suffix}`,
			truncated: true,
			originalLength: text.length,
		};
	};

	const createPendingEditBatchId = (): string => `edit-batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

	const getFallbackEditPolicy = (): FallbackEditPolicy => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const configuredMax = config.get<number | null>("fallbackEditPolicy.maxFilesPerResponse", null);
		const maxFilesPerResponse = typeof configuredMax === "number" && configuredMax > 0 ? configuredMax : undefined;
		return {
			pathRequired: config.get<boolean>("fallbackEditPolicy.pathRequired", false),
			sameFileOnly: config.get<boolean>("fallbackEditPolicy.sameFileOnly", false),
			workspaceOnly: config.get<boolean>("fallbackEditPolicy.workspaceOnly", false),
			maxFilesPerResponse,
		};
	};

	const normalizeCandidatePath = (rawPath: string): string => rawPath.replace(/\\/g, "/").toLowerCase();

	const resolveEditUri = (filePath: string): vscode.Uri | undefined => {
		if (!filePath) {
			return undefined;
		}
		const isAbsolute = filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath);
		if (!isAbsolute) {
			if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
				return vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, filePath);
			}
			return vscode.Uri.file(path.resolve(process.cwd(), filePath));
		}
		return vscode.Uri.file(filePath);
	};

	const isUriInsideWorkspace = (uri: vscode.Uri): boolean => {
		const candidate = normalizeCandidatePath(uri.fsPath);
		return (vscode.workspace.workspaceFolders ?? []).some((folder) => {
			const root = normalizeCandidatePath(folder.uri.fsPath);
			return candidate === root || candidate.startsWith(`${root}/`);
		});
	};

	const evaluateEditPolicy = (
		policy: FallbackEditPolicy,
		edit: { path?: string },
		context: { activeEditorFilePath?: string; allowUntitledTarget?: boolean }
	): string | undefined => {
		const candidatePath = edit.path?.trim();
		if (policy.pathRequired && !candidatePath) {
			return "Policy blocked edit: target path is required.";
		}

		if (!candidatePath) {
			return context.allowUntitledTarget ? undefined : "Policy blocked edit: no eligible file target was resolved.";
		}

		const candidateUri = resolveEditUri(candidatePath);
		if (!candidateUri) {
			return "Policy blocked edit: target path could not be resolved.";
		}

		if (policy.workspaceOnly && !isUriInsideWorkspace(candidateUri)) {
			return `Policy blocked edit: '${candidatePath}' is outside the workspace.`;
		}

		if (policy.sameFileOnly) {
			if (!context.activeEditorFilePath) {
				return "Policy blocked edit: same-file-only mode requires an active file editor.";
			}
			if (normalizeCandidatePath(candidateUri.fsPath) !== normalizeCandidatePath(context.activeEditorFilePath)) {
				return `Policy blocked edit: '${candidatePath}' does not match the active file.`;
			}
		}

		return undefined;
	};

	const enforceBatchSizePolicy = (policy: FallbackEditPolicy, edits: Array<{ path: string }>): string | undefined => {
		if (!policy.maxFilesPerResponse) {
			return undefined;
		}
		const uniquePaths = new Set(edits.map((edit) => normalizeCandidatePath(edit.path)));
		if (uniquePaths.size > policy.maxFilesPerResponse) {
			return `Policy blocked edit batch: ${uniquePaths.size} files exceeds maxFilesPerResponse=${policy.maxFilesPerResponse}.`;
		}
		return undefined;
	};

	/** Extracts plausible file path references from prose text (e.g., `src/utils.ts`). */
	const extractMentionedPaths = (text: string): string[] => {
		const FILE_RE =
			/((?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|cpp|c|h|json|yaml|yml|toml|md|txt|sh|html|css|scss|vue|svelte|rb|php|swift|kt|dart)))/g;
		const paths: string[] = [];
		for (const match of text.matchAll(FILE_RE)) {
			const p = match[2];
			if (!p) {
				continue;
			}
			// Skip paths that are part of a URL (e.g. https://host/src/utils.ts)
			const idx = match.index ?? 0;
			if (idx >= 3 && text.slice(idx - 3, idx) === "://") {
				continue;
			}
			paths.push(p);
		}
		return [...new Set(paths)];
	};

	/**
	 * Collects candidate file paths from chat context: attached reference URIs plus filenames
	 * mentioned in the current prompt and recent history turns.
	 * Returns resolved absolute fsPath strings so all comparisons are apples-to-apples.
	 */
	const collectEditContextPaths = (
		references: readonly vscode.ChatPromptReference[],
		prompt: string,
		history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]
	): string[] => {
		const paths: string[] = [];
		// 1. Attached reference file URIs (already absolute)
		for (const ref of references) {
			if (ref.value instanceof vscode.Uri && ref.value.scheme === "file") {
				paths.push(ref.value.fsPath);
			} else if (ref.value instanceof vscode.Location && ref.value.uri.scheme === "file") {
				paths.push(ref.value.uri.fsPath);
			}
		}
		// 2. Paths mentioned in the current prompt
		for (const mentioned of extractMentionedPaths(prompt)) {
			const uri = resolveEditUri(mentioned);
			if (uri) {
				paths.push(uri.fsPath);
			}
		}
		// 3. Paths mentioned in the last few history turns (avoid stale context)
		for (const turn of [...history].slice(-6)) {
			if (turn instanceof vscode.ChatRequestTurn) {
				for (const mentioned of extractMentionedPaths(turn.prompt)) {
					const uri = resolveEditUri(mentioned);
					if (uri) {
						paths.push(uri.fsPath);
					}
				}
			}
		}
		// Deduplicate preserving order
		const seen = new Set<string>();
		return paths.filter((p) => {
			const key = normalizeCandidatePath(p);
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
	};

	const tokenizeContextQuery = (text: string): string[] => {
		const stopWords = new Set([
			"the",
			"and",
			"for",
			"with",
			"that",
			"this",
			"from",
			"have",
			"will",
			"your",
			"into",
			"about",
			"please",
			"update",
			"implement",
			"fallback",
			"chat",
		]);
		const tokens = text
			.toLowerCase()
			.split(/[^a-z0-9_./-]+/)
			.map((token) => token.trim())
			.filter((token) => token.length >= 3 && token.length <= 40 && !stopWords.has(token));
		return [...new Set(tokens)].slice(0, 24);
	};

	const extractSymbolCandidates = (text: string): string[] => {
		const stopWords = new Set(["the", "and", "for", "with", "that", "this", "from", "have", "will", "into", "about"]);
		const matches = text.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) ?? [];
		const candidates = matches
			.filter((token) => !stopWords.has(token.toLowerCase()))
			.filter((token) => /[A-Z_]/.test(token) || /[a-z][A-Z]/.test(token) || token.includes("_"));
		return [...new Set(candidates)].slice(0, 24);
	};

	interface FlatSymbol {
		name: string;
		line: number;
		character: number;
		kind: string;
	}

	const flattenSymbols = (
		symbols: readonly vscode.DocumentSymbol[] | readonly vscode.SymbolInformation[]
	): FlatSymbol[] => {
		const out: FlatSymbol[] = [];
		const visit = (symbol: vscode.DocumentSymbol) => {
			out.push({
				name: symbol.name,
				line: symbol.selectionRange.start.line + 1,
				character: symbol.selectionRange.start.character + 1,
				kind: vscode.SymbolKind[symbol.kind] ?? "Unknown",
			});
			for (const child of symbol.children) {
				visit(child);
			}
		};

		for (const symbol of symbols) {
			if (symbol instanceof vscode.DocumentSymbol) {
				visit(symbol);
			} else {
				out.push({
					name: symbol.name,
					line: symbol.location.range.start.line + 1,
					character: symbol.location.range.start.character + 1,
					kind: vscode.SymbolKind[symbol.kind] ?? "Unknown",
				});
			}
		}

		return out;
	};

	const collectRelatedImportSpecs = (lines: string[]): string[] => {
		const specs: string[] = [];
		for (const line of lines) {
			const fromMatch = line.match(/\bfrom\s+["']([^"']+)["']/);
			if (fromMatch?.[1]) {
				specs.push(fromMatch[1]);
			}
			const requireMatch = line.match(/\brequire\(["']([^"']+)["']\)/);
			if (requireMatch?.[1]) {
				specs.push(requireMatch[1]);
			}
		}
		return [...new Set(specs)].slice(0, 16);
	};

	const tryResolveRelatedPath = async (baseFilePath: string, spec: string): Promise<string | undefined> => {
		if (!spec.startsWith(".")) {
			return undefined;
		}
		const baseDir = path.dirname(baseFilePath);
		const candidates = [
			path.resolve(baseDir, spec),
			path.resolve(baseDir, `${spec}.ts`),
			path.resolve(baseDir, `${spec}.tsx`),
			path.resolve(baseDir, `${spec}.js`),
			path.resolve(baseDir, `${spec}.jsx`),
			path.resolve(baseDir, spec, "index.ts"),
			path.resolve(baseDir, spec, "index.tsx"),
			path.resolve(baseDir, spec, "index.js"),
		];
		for (const candidate of candidates) {
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
				return makeWorkspaceRelative(candidate);
			} catch {
				// Try next candidate.
			}
		}
		return undefined;
	};

	const collectRecentHistoryText = (history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]): string => {
		const chunks: string[] = [];
		for (const turn of [...history].slice(-6)) {
			if (turn instanceof vscode.ChatRequestTurn) {
				chunks.push(turn.prompt);
			} else if (turn instanceof vscode.ChatResponseTurn) {
				const responseText = turn.response
					.map((part) => (part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : ""))
					.filter(Boolean)
					.join("\n");
				if (responseText) {
					chunks.push(responseText);
				}
			}
		}
		return chunks.join("\n");
	};

	const buildRankedWorkspaceContext = async (
		prompt: string,
		references: readonly vscode.ChatPromptReference[],
		history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[],
		activeEditorFilePath?: string
	): Promise<string | undefined> => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		if (!config.get<boolean>("fallbackContextRetrieval.enabled", true)) {
			return undefined;
		}

		const maxFiles = Math.max(1, config.get<number>("fallbackContextRetrieval.maxFiles", 4));
		const maxSnippetLines = Math.max(3, config.get<number>("fallbackContextRetrieval.maxSnippetLines", 8));
		const maxChars = Math.max(500, config.get<number>("fallbackContextRetrieval.maxChars", 2600));
		const maxSymbols = Math.max(0, config.get<number>("fallbackContextRetrieval.maxSymbols", 6));
		const maxReferencesPerSymbol = Math.max(
			0,
			config.get<number>("fallbackContextRetrieval.maxReferencesPerSymbol", 3)
		);
		const includeFileRelationships = config.get<boolean>("fallbackContextRetrieval.includeFileRelationships", true);
		const searchGlob = config.get<string>(
			"fallbackContextRetrieval.searchGlob",
			"**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,yml,yaml}"
		);
		const maxSearchFiles = Math.max(50, config.get<number>("fallbackContextRetrieval.maxSearchFiles", 250));

		const queryText = `${prompt}\n${collectRecentHistoryText(history)}`;
		const queryTokens = tokenizeContextQuery(queryText);
		const symbolCandidates = extractSymbolCandidates(queryText);
		const contextPaths = collectEditContextPaths(references, prompt, history);
		const scored = new Map<string, { score: number; path: string }>();

		const addScore = (absolutePath: string, score: number) => {
			if (!absolutePath || score <= 0) {
				return;
			}
			const key = normalizeCandidatePath(absolutePath);
			const existing = scored.get(key);
			if (existing) {
				scored.set(key, { ...existing, score: existing.score + score });
				return;
			}
			scored.set(key, { score, path: absolutePath });
		};

		if (activeEditorFilePath) {
			addScore(activeEditorFilePath, 14);
		}
		for (const path of contextPaths) {
			addScore(path, 12);
		}

		if (queryTokens.length > 0) {
			try {
				const candidates = await vscode.workspace.findFiles(searchGlob, undefined, maxSearchFiles);
				for (const uri of candidates) {
					if (uri.scheme !== "file") {
						continue;
					}
					const normalizedPath = normalizeCandidatePath(uri.fsPath);
					const basename = normalizedPath.split("/").pop() ?? "";
					let fileScore = 0;
					for (const token of queryTokens) {
						if (normalizedPath.includes(token)) {
							fileScore += 1;
						}
						if (basename.includes(token)) {
							fileScore += 2;
						}
					}
					if (fileScore > 0) {
						addScore(uri.fsPath, fileScore);
					}
				}
			} catch {
				// Best-effort context retrieval; ignore search failures.
			}
		}

		if (scored.size === 0) {
			return undefined;
		}

		const topPaths = [...scored.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, maxFiles)
			.map((entry) => entry.path);

		const snippetsSections: string[] = [];
		const symbolSections: string[] = [];
		const relationshipSections: string[] = [];
		let symbolBudget = maxSymbols;
		for (const normalizedPath of topPaths) {
			try {
				const uri = vscode.Uri.file(normalizedPath);
				const document = await vscode.workspace.openTextDocument(uri);
				const allLines = document.getText().split(/\r?\n/);
				if (allLines.length === 0) {
					continue;
				}

				const loweredTokens = queryTokens.slice(0, 12);
				let focusLine = allLines.findIndex((line) => {
					const lowered = line.toLowerCase();
					return loweredTokens.some((token) => lowered.includes(token));
				});
				if (focusLine < 0) {
					focusLine = allLines.findIndex((line) => line.trim().length > 0);
				}
				if (focusLine < 0) {
					focusLine = 0;
				}

				const start = Math.max(0, focusLine - 2);
				const end = Math.min(allLines.length, start + maxSnippetLines);
				const snippet = allLines
					.slice(start, end)
					.map((line, index) => `${start + index + 1}: ${line}`)
					.join("\n");
				const relative = makeWorkspaceRelative(uri.fsPath);
				snippetsSections.push(`- ${relative}\n${snippet}`);

				if (includeFileRelationships) {
					const specs = collectRelatedImportSpecs(allLines.slice(0, Math.min(allLines.length, 220)));
					if (specs.length > 0) {
						const resolved: string[] = [];
						for (const spec of specs.slice(0, 6)) {
							const resolvedPath = await tryResolveRelatedPath(uri.fsPath, spec);
							resolved.push(resolvedPath ? `${spec} -> ${resolvedPath}` : spec);
						}
						relationshipSections.push(`- ${relative}: ${resolved.join(", ")}`);
					}
				}

				if (symbolBudget > 0 && symbolCandidates.length > 0) {
					const docSymbols =
						(await vscode.commands.executeCommand<
							readonly vscode.DocumentSymbol[] | readonly vscode.SymbolInformation[]
						>("vscode.executeDocumentSymbolProvider", uri)) ?? [];
					const flat = flattenSymbols(docSymbols);
					const lowerCandidates = symbolCandidates.map((value) => value.toLowerCase());
					const rankedSymbols = flat
						.filter((symbol) => lowerCandidates.some((candidate) => symbol.name.toLowerCase().includes(candidate)))
						.slice(0, symbolBudget);

					for (const symbol of rankedSymbols) {
						symbolBudget--;
						const defStart = Math.max(0, symbol.line - 2);
						const defEnd = Math.min(allLines.length, defStart + 3);
						const nearDef = allLines
							.slice(defStart, defEnd)
							.map((line, index) => `${defStart + index + 1}: ${line}`)
							.join("\n");

						const refLines: string[] = [];
						if (maxReferencesPerSymbol > 0) {
							const refs =
								(await vscode.commands.executeCommand<vscode.Location[]>(
									"vscode.executeReferenceProvider",
									uri,
									new vscode.Position(Math.max(0, symbol.line - 1), Math.max(0, symbol.character - 1))
								)) ?? [];
							for (const ref of refs.slice(0, maxReferencesPerSymbol)) {
								refLines.push(
									`${makeWorkspaceRelative(ref.uri.fsPath)}:${ref.range.start.line + 1}:${ref.range.start.character + 1}`
								);
							}
						}

						symbolSections.push(
							`- ${relative} :: ${symbol.name} (${symbol.kind})\nDefinition:\n${nearDef}${
								refLines.length > 0 ? `\nReferences: ${refLines.join(", ")}` : ""
							}`
						);
						if (symbolBudget <= 0) {
							break;
						}
					}
				}
			} catch {
				// Skip unreadable files.
			}
		}

		if (snippetsSections.length === 0 && symbolSections.length === 0 && relationshipSections.length === 0) {
			return undefined;
		}

		const chunks: string[] = [];
		chunks.push(`Nearby code snippets:\n${snippetsSections.length > 0 ? snippetsSections.join("\n\n") : "(none)"}`);
		if (symbolSections.length > 0) {
			chunks.push(`Symbol context (definitions and references):\n${symbolSections.join("\n\n")}`);
		}
		if (relationshipSections.length > 0) {
			chunks.push(`File relationships:\n${relationshipSections.join("\n")}`);
		}

		const rendered = chunks.join("\n\n");
		if (rendered.length <= maxChars) {
			return rendered;
		}
		return `${rendered.slice(0, maxChars - 18)}\n... [context truncated]`;
	};

	/**
	 * Synchronous best-effort path resolution for use during streaming (code blocks).
	 * Checks context paths via suffix/basename match, then resolves directly, then active editor.
	 */
	const resolveEditTargetPathSync = (
		candidatePath: string | undefined,
		contextPaths: string[],
		activeEditorFilePath: string | undefined
	): { resolvedPath: string; source: "explicit" | "context" | "active-editor" } | undefined => {
		if (candidatePath) {
			const normalizedCandidate = normalizeCandidatePath(candidatePath);
			for (const ctxPath of contextPaths) {
				const normalizedCtx = normalizeCandidatePath(ctxPath);
				if (normalizedCtx.endsWith("/" + normalizedCandidate) || normalizedCtx === normalizedCandidate) {
					return { resolvedPath: ctxPath, source: "context" };
				}
			}
			const directUri = resolveEditUri(candidatePath);
			if (directUri) {
				return { resolvedPath: directUri.fsPath, source: "explicit" };
			}
		}
		// No candidate — use the single context path if there is exactly one (e.g. one reference attached)
		if (!candidatePath && contextPaths.length === 1) {
			return { resolvedPath: contextPaths[0], source: "context" };
		}
		if (activeEditorFilePath) {
			return { resolvedPath: activeEditorFilePath, source: "active-editor" };
		}
		return undefined;
	};

	/**
	 * Async full path resolution for structured edits (post-stream).
	 * For "create" intent, only resolves the given path directly.
	 * For "replace", checks context paths, then workspace findFiles, then direct, then active editor.
	 */
	const resolveEditTargetPath = async (
		candidatePath: string | undefined,
		intent: "create" | "replace",
		contextPaths: string[],
		activeEditorFilePath: string | undefined
	): Promise<{ resolvedPath: string; source: "explicit" | "context" | "workspace" | "active-editor" } | undefined> => {
		const isAbsolute = candidatePath ? candidatePath.startsWith("/") || /^[a-zA-Z]:/.test(candidatePath) : false;
		// Already absolute — use as-is
		if (candidatePath && isAbsolute) {
			return { resolvedPath: candidatePath, source: "explicit" };
		}
		// For "create", skip context/workspace search — the model is naming a new file
		if (intent === "create") {
			if (candidatePath) {
				const uri = resolveEditUri(candidatePath);
				if (uri) {
					return { resolvedPath: uri.fsPath, source: "explicit" };
				}
			}
			return undefined;
		}
		// "replace" intent: find the best matching existing file
		if (candidatePath) {
			const normalizedCandidate = normalizeCandidatePath(candidatePath);
			// 1. Context path suffix/exact match
			for (const ctxPath of contextPaths) {
				const normalizedCtx = normalizeCandidatePath(ctxPath);
				if (normalizedCtx.endsWith("/" + normalizedCandidate) || normalizedCtx === normalizedCandidate) {
					return { resolvedPath: ctxPath, source: "context" };
				}
			}
			// 2. Workspace file search
			try {
				const workspaceMatches = await vscode.workspace.findFiles(`**/${candidatePath}`, undefined, 5);
				if (workspaceMatches.length === 1) {
					return { resolvedPath: workspaceMatches[0].fsPath, source: "workspace" };
				}
				if (workspaceMatches.length > 1) {
					// Prefer a match that appears in contextPaths (referenced/mentioned by user)
					const normalizedContextPaths = contextPaths.map(normalizeCandidatePath);
					for (const match of workspaceMatches) {
						if (normalizedContextPaths.includes(normalizeCandidatePath(match.fsPath))) {
							return { resolvedPath: match.fsPath, source: "workspace" };
						}
					}
					// Ambiguous — fall through to direct resolve
				}
			} catch {
				// findFiles failure is non-fatal
			}
			// 3. Direct resolve
			const directUri = resolveEditUri(candidatePath);
			if (directUri) {
				return { resolvedPath: directUri.fsPath, source: "explicit" };
			}
		}
		// No candidate path — use single context path if exactly one is available
		if (!candidatePath && contextPaths.length === 1) {
			return { resolvedPath: contextPaths[0], source: "context" };
		}
		if (activeEditorFilePath) {
			return { resolvedPath: activeEditorFilePath, source: "active-editor" };
		}
		return undefined;
	};

	/** Converts an absolute fsPath to a workspace-relative display string. */
	const makeWorkspaceRelative = (absolutePath: string): string =>
		vscode.workspace.asRelativePath(absolutePath, false).replace(/\\/g, "/");

	const formatPendingEditBatch = (batch: FallbackPendingEditBatch): string => {
		const counts = batch.edits.reduce(
			(acc, edit) => {
				acc[edit.status] = (acc[edit.status] ?? 0) + 1;
				return acc;
			},
			{} as Record<FallbackPendingEdit["status"], number>
		);
		const actionable = (counts.pending ?? 0) + (counts.accepted ?? 0);
		const lines: string[] = [
			`Staged edits: ${batch.edits.length} file${batch.edits.length === 1 ? "" : "s"}`,
			`State summary: pending=${counts.pending ?? 0}, accepted=${counts.accepted ?? 0}, rejected=${counts.rejected ?? 0}, failed=${counts.failed ?? 0}, applied=${counts.applied ?? 0}`,
		];
		for (const edit of batch.edits) {
			lines.push(`- [${edit.status}] ${edit.intent.toUpperCase()} ${edit.path}`);
			if (edit.description) {
				lines.push(`  ${edit.description}`);
			}
			if (edit.error) {
				lines.push(`  Error: ${edit.error}`);
			}
		}
		lines.push("");
		lines.push("Recommended next steps:");
		if (actionable > 0) {
			lines.push("- Preview high-risk files first, then accept or reject each file");
			lines.push("- Run /edit-status to re-check counts before applying");
			lines.push("- Use Apply Staged Edits when accepted/pending files look correct");
		} else {
			lines.push("- No actionable files remain in this batch");
			lines.push("- Discard this batch or continue with a new request");
		}
		return lines.join("\n");
	};

	const summarizePendingEditBatch = (batch?: FallbackPendingEditBatch): string => {
		if (!batch) {
			return "No staged edits.";
		}
		const counts = batch.edits.reduce(
			(acc, edit) => {
				acc[edit.status] = (acc[edit.status] ?? 0) + 1;
				return acc;
			},
			{} as Record<FallbackPendingEdit["status"], number>
		);
		const actionable = (counts.pending ?? 0) + (counts.accepted ?? 0);
		return `Staged edits: ${batch.edits.length} total, ${actionable} actionable (pending+accepted), rejected=${counts.rejected ?? 0}, failed=${counts.failed ?? 0}, applied=${counts.applied ?? 0}`;
	};

	const buildNextStepSuggestions = (state?: FallbackWorkflowState, batch?: FallbackPendingEditBatch): string[] => {
		const suggestions: string[] = [];
		if (state?.pendingToolCallId) {
			suggestions.push("Approve or reject the pending tool call: /tool-approve or /tool-reject");
		}
		if (batch) {
			const actionable = batch.edits.filter((edit) => edit.status === "pending" || edit.status === "accepted").length;
			if (actionable > 0) {
				suggestions.push("Review staged edits: use preview/accept/reject buttons, then Apply Staged Edits");
				suggestions.push("Check staged edit state anytime with /edit-status");
			}
		}
		if (state?.toolLoopActive) {
			suggestions.push("Continue autonomous execution with /tool-loop resume or stop with /tool-loop stop");
		}
		if (suggestions.length === 0) {
			suggestions.push("Continue with the next concrete implementation step or ask for a focused change");
		}
		return suggestions;
	};

	const updatePendingEditStatus = async (
		editId: string,
		status: FallbackPendingEdit["status"],
		error?: string
	): Promise<FallbackPendingEditBatch | undefined> => {
		const batch = getPendingEditBatch();
		if (!batch) {
			return undefined;
		}
		const edits = batch.edits.map((edit) =>
			edit.id === editId
				? {
						...edit,
						status,
						error,
					}
				: edit
		);
		const updated = { ...batch, edits };
		await savePendingEditBatch(updated);
		return updated;
	};

	const applyPendingEditBatch = async (): Promise<{
		applied: number;
		failed: number;
		batch?: FallbackPendingEditBatch;
	}> => {
		const batch = getPendingEditBatch();
		if (!batch) {
			return { applied: 0, failed: 0 };
		}

		let applied = 0;
		let failed = 0;
		const policy = getFallbackEditPolicy();
		const activeEditorFilePath =
			vscode.window.activeTextEditor?.document.uri.scheme === "file"
				? vscode.window.activeTextEditor.document.uri.fsPath
				: undefined;
		const edits: FallbackPendingEdit[] = [];
		for (const edit of batch.edits) {
			if (edit.status === "rejected" || edit.status === "applied") {
				edits.push(edit);
				continue;
			}

			try {
				const policyViolation = evaluateEditPolicy(policy, { path: edit.path }, { activeEditorFilePath });
				if (policyViolation) {
					throw new Error(policyViolation);
				}
				await applyStructuredEdit({
					id: edit.id,
					path: edit.path,
					intent: edit.intent,
					content: edit.content,
					language: edit.language,
					description: edit.description,
				});
				edits.push({ ...edit, status: "applied", error: undefined });
				applied++;
			} catch (error) {
				failed++;
				void bumpFallbackTelemetry("editMisses");
				edits.push({
					...edit,
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const updated = { ...batch, edits };
		await savePendingEditBatch(updated);
		return { applied, failed, batch: updated };
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

	const normalizeReferenceContext = (referencePrompt: string): string | undefined => {
		const trimmed = referencePrompt.trim();
		if (!trimmed) {
			return undefined;
		}
		const heading = "Additional context from chat references:";
		if (trimmed.startsWith(heading)) {
			const withoutHeading = trimmed.slice(heading.length).trim();
			return withoutHeading || undefined;
		}
		return trimmed;
	};

	const isLikelyImageUri = (uri: vscode.Uri): boolean => /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)$/i.test(uri.path);

	const classifyAttachments = (
		references: readonly vscode.ChatPromptReference[]
	): {
		imageLabels: string[];
		nonImageCount: number;
		totalCount: number;
	} => {
		const imageLabels: string[] = [];
		let nonImageCount = 0;
		for (const reference of references) {
			const value = reference.value;
			const labelFromUri = (uri: vscode.Uri): string => makeWorkspaceRelative(uri.fsPath || uri.path);
			if (value instanceof vscode.Uri) {
				if (isLikelyImageUri(value)) {
					imageLabels.push(reference.modelDescription?.trim() || labelFromUri(value));
				} else {
					nonImageCount++;
				}
				continue;
			}
			if (value instanceof vscode.Location) {
				if (isLikelyImageUri(value.uri)) {
					imageLabels.push(reference.modelDescription?.trim() || labelFromUri(value.uri));
				} else {
					nonImageCount++;
				}
				continue;
			}
			if (
				typeof reference.modelDescription === "string" &&
				/\b(image|screenshot|png|jpe?g|gif|webp|svg)\b/i.test(reference.modelDescription)
			) {
				imageLabels.push(reference.modelDescription.trim());
				continue;
			}
			nonImageCount++;
		}
		return {
			imageLabels,
			nonImageCount,
			totalCount: imageLabels.length + nonImageCount,
		};
	};

	const buildAttachmentContextSection = (attachments: {
		imageLabels: string[];
		nonImageCount: number;
		totalCount: number;
	}): string | undefined => {
		if (attachments.totalCount === 0) {
			return undefined;
		}
		const lines: string[] = ["Attachment summary:"];
		if (attachments.imageLabels.length > 0) {
			lines.push(`- Images: ${attachments.imageLabels.length}`);
			for (const label of attachments.imageLabels.slice(0, 8)) {
				lines.push(`  - ${label}`);
			}
		}
		if (attachments.nonImageCount > 0) {
			lines.push(`- Non-image attachments: ${attachments.nonImageCount}`);
		}
		lines.push("- For image attachments, reason over the description/filename when binary pixels are not available.");
		return lines.join("\n");
	};

	const buildAttachmentCapabilityMessage = (
		attachments: { imageLabels: string[] },
		selectedModel: vscode.LanguageModelChatInformation
	): string | undefined => {
		if (attachments.imageLabels.length === 0) {
			return undefined;
		}
		const modelSupportsVision = selectedModel.capabilities?.imageInput === true;
		if (modelSupportsVision) {
			return `Vision input appears supported by ${selectedModel.id}; image attachments will be considered using available reference descriptions.`;
		}
		return `Selected model ${selectedModel.id} does not advertise image input. Fallback will use image descriptions/filenames only; switch models via /model pick for vision-capable behavior.`;
	};

	const buildWorkflowStateSection = (state?: FallbackWorkflowState): string => {
		if (
			!state ||
			(!state.goal &&
				state.notes.length === 0 &&
				!state.toolLoopActive &&
				typeof state.runtimeTemperature !== "number" &&
				typeof state.runtimeMaxTokens !== "number" &&
				(!state.runtimeStopSequences || state.runtimeStopSequences.length === 0))
		) {
			return "(none)";
		}

		const lines: string[] = [];
		if (state.goal) {
			lines.push(`Goal: ${state.goal}`);
		}
		if (state.notes.length > 0) {
			lines.push("Notes:");
			for (const note of state.notes) {
				lines.push(`- ${note}`);
			}
		}
		if (state.toolLoopActive) {
			const stepCap = state.toolLoopStepCap ?? "auto";
			const stepsRun = state.toolLoopStepsRun ?? 0;
			lines.push(`Tool loop: active (${stepsRun}/${stepCap} steps)`);
			if (state.toolLoopGoal) {
				lines.push(`Tool loop goal: ${state.toolLoopGoal}`);
			}
		}
		if (state.loopEnabled) {
			lines.push(`Approval gate: ${state.pendingApproval ? "waiting" : "ready"}`);
		}
		if (typeof state.runtimeTemperature === "number") {
			lines.push(`Temperature override: ${state.runtimeTemperature}`);
		}
		if (typeof state.runtimeMaxTokens === "number") {
			lines.push(`Token budget override (max_tokens): ${state.runtimeMaxTokens}`);
		}
		if (state.runtimeStopSequences && state.runtimeStopSequences.length > 0) {
			lines.push(`Stop sequences override: ${state.runtimeStopSequences.join(" | ")}`);
		}
		return lines.length > 0 ? lines.join("\n") : "(none)";
	};

	const applyRuntimeModelOptionOverrides = (
		baseOptions: Record<string, unknown>,
		state?: FallbackWorkflowState
	): Record<string, unknown> => {
		const merged: Record<string, unknown> = { ...baseOptions };
		if (typeof state?.runtimeTemperature === "number") {
			merged.temperature = state.runtimeTemperature;
		}
		if (typeof state?.runtimeMaxTokens === "number") {
			merged.max_tokens = state.runtimeMaxTokens;
		}
		if (state?.runtimeStopSequences && state.runtimeStopSequences.length > 0) {
			merged.stop = state.runtimeStopSequences;
		}
		return merged;
	};

	const buildToolResultsSection = (state?: FallbackWorkflowState): string => {
		const recentTools = (state?.toolCalls ?? [])
			.filter((tc) => tc.status === "executed" || tc.status === "failed")
			.slice(-3);
		if (recentTools.length === 0) {
			return "(none)";
		}

		const lines: string[] = [];
		for (const tc of recentTools) {
			const icon = tc.status === "executed" ? "SUCCESS" : "FAILED";
			const exitPart = tc.resultMeta?.exitCode !== undefined ? ` (exit code: ${tc.resultMeta.exitCode})` : "";
			const rawPreview = (tc.result ?? tc.error ?? "").replace(/\s+/g, " ").trim();
			const preview = rawPreview.length > 300 ? `${rawPreview.slice(0, 300)}...` : rawPreview;
			lines.push(`- ${icon}: ${tc.name}${exitPart}${preview ? ` -> ${preview}` : ""}`);
		}
		return lines.join("\n");
	};

	const buildEditIntentSection = (autoApplyEdits: boolean, editPolicy: FallbackEditPolicy): string => {
		const policyLines = [
			`Auto apply code fences: ${autoApplyEdits ? "enabled" : "disabled"}`,
			`Policy pathRequired=${editPolicy.pathRequired}`,
			`Policy sameFileOnly=${editPolicy.sameFileOnly}`,
			`Policy workspaceOnly=${editPolicy.workspaceOnly}`,
			`Policy maxFilesPerResponse=${editPolicy.maxFilesPerResponse ?? "none"}`,
		];
		return `${policyLines.join("\n")}\n\n${buildStructuredEditInstruction()}`;
	};

	const buildFallbackPromptPackage = (params: {
		taskPrompt: string;
		referenceContext?: string;
		rankedWorkspaceContext?: string;
		activeEditorFilePath?: string;
		attachmentContext?: string;
		attachmentCapabilityMessage?: string;
		workflowState?: FallbackWorkflowState;
		autoApplyEdits: boolean;
		editPolicy: FallbackEditPolicy;
	}): string => {
		const referencesLines: string[] = [];
		if (params.activeEditorFilePath) {
			referencesLines.push(`Active file context: ${makeWorkspaceRelative(params.activeEditorFilePath)}`);
		}
		if (params.referenceContext) {
			referencesLines.push(params.referenceContext);
		}
		referencesLines.push(`Relevant workspace context (ranked):\n${params.rankedWorkspaceContext?.trim() || "(none)"}`);
		if (params.attachmentContext) {
			referencesLines.push(params.attachmentContext);
		}
		if (params.attachmentCapabilityMessage) {
			referencesLines.push(`Capability note:\n${params.attachmentCapabilityMessage}`);
		}

		const sections = [
			`## Task\n${params.taskPrompt.trim() || "(empty)"}`,
			`## References\n${referencesLines.length > 0 ? referencesLines.join("\n\n") : "(none)"}`,
			`## Workflow State\n${buildWorkflowStateSection(params.workflowState)}`,
			`## Tool Results\n${buildToolResultsSection(params.workflowState)}`,
			`## Edit Intent\n${buildEditIntentSection(params.autoApplyEdits, params.editPolicy)}`,
		];

		const contextAnchors = [
			"Relevant workspace context (ranked):",
			"Nearby code snippets:",
			"Symbol context (definitions and references):",
			"File relationships:",
		].join("\n");

		return `${contextAnchors}\n\n${sections.join("\n\n")}`;
	};

	const normalizeFallbackToolMode = (value: unknown): FallbackToolMode | undefined => {
		if (typeof value !== "string") {
			return undefined;
		}
		const normalized = value.trim().toLowerCase();
		if (normalized === "auto") {
			return "auto";
		}
		if (normalized === "required") {
			return "required";
		}
		if (normalized === "none" || normalized === "off" || normalized === "no-tools" || normalized === "disabled") {
			return "none";
		}
		return undefined;
	};

	const resolveFallbackToolControl = (
		allTools: vscode.LanguageModelChatTool[]
	): {
		mode: FallbackToolMode;
		requiredToolName?: string;
		toolMode?: vscode.LanguageModelChatToolMode;
		tools: vscode.LanguageModelChatTool[];
	} => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const state = getFallbackWorkflowState();

		const configuredMode = normalizeFallbackToolMode(config.get<string>("fallbackToolCalling.mode", "auto"));
		const mode = state?.toolModeOverride ?? configuredMode ?? "auto";
		const configuredRequiredTool = config.get<string>("fallbackToolCalling.requiredTool", "execute_command").trim();
		const requestedRequiredTool = (state?.requiredToolName ?? configuredRequiredTool).trim();

		if (mode === "none") {
			return { mode, tools: [] };
		}

		if (mode === "required") {
			const selected =
				allTools.find((tool) => tool.name === requestedRequiredTool) ??
				allTools.find((tool) => tool.name === "execute_command") ??
				allTools[0];
			if (!selected) {
				return { mode: "none", tools: [] };
			}
			return {
				mode,
				requiredToolName: selected.name,
				toolMode: vscode.LanguageModelChatToolMode.Required,
				tools: [selected],
			};
		}

		return {
			mode: "auto",
			toolMode: vscode.LanguageModelChatToolMode.Auto,
			tools: allTools,
		};
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
			const safety = getFallbackSafetyLimits();
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
					const clippedOutput = clipTextWithNotice(
						result.output,
						safety.maxToolResultChars,
						"[tool output truncated by safety limit]"
					).text;
					await updateToolCall(pending.id, {
						status: "executed",
						executedAt,
						result: clippedOutput,
						resultMeta: result.meta,
					});

					const formatted = clipTextWithNotice(
						formatToolResult({ ...result, output: clippedOutput }),
						safety.maxToolResultChars,
						"[formatted tool output truncated by safety limit]"
					).text;
					stream.markdown(`\n✓ **Tool executed**: \`${pending.name}\`\n\`\`\`\n${formatted}\n\`\`\``);

					// Persist a workflow note so the model sees the outcome on the next turn
					const state = getFallbackWorkflowState();
					if (state) {
						const exitNote = result.meta?.exitCode !== undefined ? ` (exit code: ${result.meta.exitCode})` : "";
						const countNote =
							result.meta?.passed !== undefined || result.meta?.failed !== undefined
								? ` – ${[
										result.meta.passed !== undefined ? `${result.meta.passed} passed` : null,
										result.meta.failed !== undefined ? `${result.meta.failed} failed` : null,
									]
										.filter(Boolean)
										.join(", ")}`
								: "";
						await saveFallbackWorkflowState({
							...state,
							pendingToolCallId: undefined,
							notes: [...state.notes, `Tool ${pending.name} succeeded${exitNote}${countNote}`],
						});
					}
				} else {
					void bumpFallbackTelemetry("toolFailures");
					await updateToolCall(pending.id, {
						status: "failed",
						executedAt,
						error: result.error,
						resultMeta: result.meta,
					});

					const exitNote = result.meta?.exitCode !== undefined ? ` (exit code: ${result.meta.exitCode})` : "";
					stream.markdown(`\n✗ **Tool failed**: \`${pending.name}\`${exitNote}\n\nError: \`${result.error}\``);

					// Persist failure note for the model
					const state = getFallbackWorkflowState();
					if (state) {
						await saveFallbackWorkflowState({
							...state,
							pendingToolCallId: undefined,
							notes: [...state.notes, `Tool ${pending.name} failed${exitNote}: ${result.error}`],
						});
					}
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				void bumpFallbackTelemetry("toolFailures");
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
			void bumpFallbackTelemetry("approvalRejects");

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
			const total = state.toolCalls.length;
			const executed = groupedByStatus.executed?.length ?? 0;
			const failed = groupedByStatus.failed?.length ?? 0;
			const pending = groupedByStatus.pending?.length ?? 0;
			lines.push(`Summary: total=${total}, executed=${executed}, failed=${failed}, pending=${pending}`);

			for (const status of ["pending", "approved", "executed", "rejected", "failed"] as const) {
				const calls = groupedByStatus[status] || [];
				if (calls.length > 0) {
					lines.push(`\n**${status}** (${calls.length}):`);
					for (const tc of calls) {
						const exitPart = tc.resultMeta?.exitCode !== undefined ? ` exit:${tc.resultMeta.exitCode}` : "";
						const truncPart = tc.resultMeta?.truncated ? " [truncated]" : "";
						const preview = (tc.error ?? tc.result ?? "(no output yet)").slice(0, 100);
						lines.push(`- ${tc.name}${exitPart}${truncPart}: ${preview}`);
					}
				}
			}

			const recentHistory = [...state.toolCalls]
				.sort((a, b) => (b.executedAt ?? b.createdAt) - (a.executedAt ?? a.createdAt))
				.slice(0, 6);
			if (recentHistory.length > 0) {
				lines.push("\nRecent tool history:");
				for (const tc of recentHistory) {
					const at = new Date(tc.executedAt ?? tc.createdAt).toLocaleTimeString();
					const summary = (tc.error ?? tc.result ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
					lines.push(`- ${at} [${tc.status}] ${tc.name}${summary ? ` -> ${summary}` : ""}`);
				}
			}

			const suggestions = buildNextStepSuggestions(state, getPendingEditBatch());
			lines.push("\nSuggested next actions:");
			for (const suggestion of suggestions.slice(0, 3)) {
				lines.push(`- ${suggestion}`);
			}

			stream.markdown(lines.join("\n"));
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed === "/edit-status") {
			const batch = getPendingEditBatch();
			if (!batch) {
				stream.markdown(
					"No staged edits.\n\nSuggested next actions:\n- Continue with implementation\n- Ask the model for a focused patch\n- Use /tool-status to inspect tool history"
				);
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			const lines: string[] = [
				summarizePendingEditBatch(batch),
				"",
				formatPendingEditBatch(batch),
				"",
				"Suggested next actions:",
			];
			for (const suggestion of buildNextStepSuggestions(getFallbackWorkflowState(), batch).slice(0, 4)) {
				lines.push(`- ${suggestion}`);
			}
			stream.markdown(lines.join("\n"));
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed === "/help-state") {
			stream.markdown(
				"Fallback workflow commands:\n- `/goal <text>` set persistent goal\n- `/note <text>` add persistent note\n- `/show-state` show current goal/notes\n- `/clear-state` clear goal/notes\n- `/loop-start <goal>` start guarded autonomous loop\n- `/loop-step <instruction>` run one loop step\n- `/loop-approve` approve latest checkpoint\n- `/loop-rollback [checkpoint-id|last]` rollback loop state\n- `/loop-status` show loop status\n\nRequest-time controls:\n- `/model status|list|pick|<model-id>` choose fallback model for this session\n- `/temperature status|<0..2>|default` set runtime temperature override\n- `/tokens status|<number>|default` set runtime max_tokens override\n- `/stop status|clear|<seq1>|<seq2>|...` set runtime stop sequences override\n- `/tool-mode status|auto|required [tool-name]|none` set runtime tool mode\n\nTool call commands:\n- `/tool-approve` approve pending tool call\n- `/tool-reject` reject pending tool call\n- `/tool-checkpoint` create checkpoint for executed tools\n- `/tool-status` show tool call statuses\n\nTool loop commands:\n- `/tool-loop start [--steps N] [--retries K] [--checkpoint M] <goal>` start automated tool loop\n- `/tool-loop stop` stop the active tool loop\n- `/tool-loop resume` resume a paused tool loop\n- `/tool-loop status` show tool loop progress"
			);
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed.startsWith("/model")) {
			const rawArgs = trimmed.slice("/model".length).trim();
			const subCommand = rawArgs.toLowerCase();
			if (!rawArgs || subCommand === "status") {
				const selected = context.globalState.get<string>(LITELLM_SELECTED_CHAT_MODEL_KEY);
				stream.markdown(`Fallback model: ${selected ? `\`${selected}\`` : "(not selected)"}`);
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}

			if (subCommand === "pick") {
				const picked = await selectLiteLLMChatModel(true, true);
				if (!picked) {
					stream.markdown("Model selection canceled.");
					return { handled: true, metadataMode: "fallback-workflow-command" };
				}
				stream.markdown(`Fallback model set to \`${picked.id}\`.`);
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}

			if (subCommand === "list") {
				const models = await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);
				if (models.length === 0) {
					stream.markdown("No LiteLLM models available.");
					return { handled: true, metadataMode: "fallback-workflow-command" };
				}
				const selected = context.globalState.get<string>(LITELLM_SELECTED_CHAT_MODEL_KEY);
				const lines = models.slice(0, 30).map((model) => `- ${model.id}${model.id === selected ? " [selected]" : ""}`);
				stream.markdown(`Available fallback models:\n${lines.join("\n")}`);
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}

			const models = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			const match = models.find((model) => model.id.toLowerCase() === rawArgs.toLowerCase());
			if (!match) {
				stream.markdown(`Unknown model: \`${rawArgs}\`. Use \`/model list\` to inspect available model ids.`);
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			await context.globalState.update(LITELLM_SELECTED_CHAT_MODEL_KEY, match.id);
			stream.markdown(`Fallback model set to \`${match.id}\`.`);
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed.startsWith("/temperature")) {
			const rawArgs = trimmed.slice("/temperature".length).trim();
			const existing = getFallbackWorkflowState() ?? emptyState;
			if (!rawArgs || rawArgs.toLowerCase() === "status") {
				stream.markdown(
					`Temperature override: ${typeof existing.runtimeTemperature === "number" ? `\`${existing.runtimeTemperature}\`` : "(default from model/settings)"}`
				);
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			if (["default", "clear", "reset", "off"].includes(rawArgs.toLowerCase())) {
				await saveFallbackWorkflowState({ ...existing, runtimeTemperature: undefined });
				stream.markdown("Cleared runtime temperature override.");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			const parsed = Number(rawArgs);
			if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
				stream.markdown("Usage: `/temperature status|<0..2>|default`");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			await saveFallbackWorkflowState({ ...existing, runtimeTemperature: parsed });
			stream.markdown(`Set runtime temperature override to \`${parsed}\`.`);
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed.startsWith("/tokens")) {
			const rawArgs = trimmed.slice("/tokens".length).trim();
			const existing = getFallbackWorkflowState() ?? emptyState;
			if (!rawArgs || rawArgs.toLowerCase() === "status") {
				stream.markdown(
					`Token budget override (max_tokens): ${typeof existing.runtimeMaxTokens === "number" ? `\`${existing.runtimeMaxTokens}\`` : "(default from model/settings)"}`
				);
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			if (["default", "clear", "reset", "off"].includes(rawArgs.toLowerCase())) {
				await saveFallbackWorkflowState({ ...existing, runtimeMaxTokens: undefined });
				stream.markdown("Cleared runtime token budget override.");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			const parsed = Number.parseInt(rawArgs, 10);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				stream.markdown("Usage: `/tokens status|<number>|default`");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			await saveFallbackWorkflowState({ ...existing, runtimeMaxTokens: parsed });
			stream.markdown(`Set runtime token budget override (max_tokens) to \`${parsed}\`.`);
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed.startsWith("/stop")) {
			const rawArgs = trimmed.slice("/stop".length).trim();
			const existing = getFallbackWorkflowState() ?? emptyState;
			if (!rawArgs || rawArgs.toLowerCase() === "status") {
				const current = existing.runtimeStopSequences;
				stream.markdown(
					`Stop sequences override: ${current && current.length > 0 ? `\`${current.join(" | ")}\`` : "(default from model/settings)"}`
				);
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			if (["clear", "default", "reset", "off"].includes(rawArgs.toLowerCase())) {
				await saveFallbackWorkflowState({ ...existing, runtimeStopSequences: undefined });
				stream.markdown("Cleared runtime stop sequence override.");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			const sequences = rawArgs
				.split("|")
				.map((value) => value.trim())
				.map((value) => value.replace(/^['"]|['"]$/g, ""))
				.filter((value) => value.length > 0)
				.slice(0, 8);
			if (sequences.length === 0) {
				stream.markdown("Usage: `/stop status|clear|<seq1>|<seq2>|...`");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}
			await saveFallbackWorkflowState({ ...existing, runtimeStopSequences: sequences });
			stream.markdown(`Set runtime stop sequences override: \`${sequences.join(" | ")}\`.`);
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed.startsWith("/tool-mode")) {
			const rawArgs = trimmed.slice("/tool-mode".length).trim();
			const [subCommandRaw, ...rest] = rawArgs.split(/\s+/).filter((token) => token.length > 0);
			const subCommand = (subCommandRaw ?? "status").toLowerCase();
			const existing = getFallbackWorkflowState() ?? emptyState;

			if (subCommand === "status") {
				const mode =
					existing.toolModeOverride ??
					normalizeFallbackToolMode(
						vscode.workspace.getConfiguration("litellm-vscode-chat").get<string>("fallbackToolCalling.mode", "auto")
					) ??
					"auto";
				const requiredTool =
					existing.requiredToolName?.trim() ||
					vscode.workspace
						.getConfiguration("litellm-vscode-chat")
						.get<string>("fallbackToolCalling.requiredTool", "execute_command")
						.trim();
				stream.markdown(`Fallback tool mode: **${mode}**${mode === "required" ? ` (tool: \`${requiredTool}\`)` : ""}`);
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}

			if (subCommand === "auto") {
				await saveFallbackWorkflowState({
					...existing,
					toolModeOverride: "auto",
					requiredToolName: existing.requiredToolName,
				});
				stream.markdown("Fallback tool mode set to **auto**.");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}

			if (subCommand === "none" || subCommand === "off" || subCommand === "no-tools") {
				await saveFallbackWorkflowState({
					...existing,
					toolModeOverride: "none",
				});
				stream.markdown("Fallback tool mode set to **none** (tools disabled).");
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}

			if (subCommand === "required") {
				const requiredToolName = rest.join(" ").trim();
				await saveFallbackWorkflowState({
					...existing,
					toolModeOverride: "required",
					requiredToolName: requiredToolName || existing.requiredToolName || "execute_command",
				});
				stream.markdown(
					`Fallback tool mode set to **required**${requiredToolName ? ` with tool \`${requiredToolName}\`` : ""}.`
				);
				return { handled: true, metadataMode: "fallback-workflow-command" };
			}

			stream.markdown(
				"Usage: `/tool-mode status` | `/tool-mode auto` | `/tool-mode required [tool-name]` | `/tool-mode none`"
			);
			return { handled: true, metadataMode: "fallback-workflow-command" };
		}

		if (trimmed.startsWith("/tool-loop")) {
			const subCommand = trimmed.slice("/tool-loop".length).trim();
			const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
			const safety = getFallbackSafetyLimits();

			if (subCommand.startsWith("start")) {
				const defaultStepCap = config.get<number>("toolLoop.defaultStepCap", 10);
				const defaultRetryLimit = config.get<number>("toolLoop.defaultRetryLimit", 3);
				const defaultCheckpointInterval = config.get<number>("toolLoop.defaultCheckpointInterval", 5);

				let remaining = subCommand.slice("start".length).trim();
				let stepCap = Math.min(defaultStepCap, safety.maxLoopStepCapHard);
				let retryLimit = defaultRetryLimit;
				let checkpointInterval = defaultCheckpointInterval;

				const stepsMatch = remaining.match(/--steps\s+(\d+)/);
				if (stepsMatch) {
					stepCap = Math.min(Math.max(1, parseInt(stepsMatch[1], 10)), safety.maxLoopStepCapHard);
					remaining = remaining.replace(stepsMatch[0], "").trim();
				}
				const retriesMatch = remaining.match(/--retries\s+(\d+)/);
				if (retriesMatch) {
					retryLimit = Math.max(1, parseInt(retriesMatch[1], 10));
					remaining = remaining.replace(retriesMatch[0], "").trim();
				}
				const checkpointMatch = remaining.match(/--checkpoint\s+(\d+)/);
				if (checkpointMatch) {
					checkpointInterval = Math.max(0, parseInt(checkpointMatch[1], 10));
					remaining = remaining.replace(checkpointMatch[0], "").trim();
				}

				const goal = remaining;
				if (!goal) {
					stream.markdown("Provide a goal: `/tool-loop start [--steps N] [--retries K] [--checkpoint M] <goal text>`");
					return { handled: true, metadataMode: "fallback-loop-command" };
				}

				const existing = getFallbackWorkflowState() ?? emptyState;
				await saveFallbackWorkflowState({
					...existing,
					toolLoopActive: true,
					toolLoopGoal: goal,
					toolLoopStepCap: stepCap,
					toolLoopRetryLimit: retryLimit,
					toolLoopCheckpointInterval: checkpointInterval,
					toolLoopStepsRun: 0,
					toolLoopConsecutiveFailures: 0,
				});

				stream.markdown(
					`✓ **Tool loop started.**\n\n- **Goal:** ${goal}\n- **Step cap:** ${stepCap}${stepCap >= safety.maxLoopStepCapHard ? ` (hard-capped at ${safety.maxLoopStepCapHard})` : ""}\n- **Retry limit:** ${retryLimit} consecutive failures\n- **Checkpoint interval:** ${checkpointInterval === 0 ? "off" : `every ${checkpointInterval} steps`}\n\nSend a message to begin, or describe the first task to work on.`
				);
				return { handled: true, metadataMode: "fallback-loop-command" };
			}

			if (subCommand === "stop") {
				const state = getFallbackWorkflowState();
				const stepsRun = state?.toolLoopStepsRun ?? 0;
				const consecutiveFailures = state?.toolLoopConsecutiveFailures ?? 0;

				if (state) {
					await saveFallbackWorkflowState({
						...state,
						toolLoopActive: false,
						pendingApproval: false,
						pendingToolCallId: undefined,
						notes: [...state.notes, `Tool loop stopped manually after ${stepsRun} steps`],
					});
				}

				const exitSummary = { stepsRun, consecutiveFailures, reason: "stopped" as const };
				stream.markdown(`⏹ **Tool loop stopped.**\n\n\`\`\`json\n${JSON.stringify(exitSummary, null, 2)}\n\`\`\``);
				return { handled: true, metadataMode: "fallback-loop-command" };
			}

			if (subCommand === "status") {
				const state = getFallbackWorkflowState();
				if (!state?.toolLoopGoal && !state?.toolLoopActive) {
					stream.markdown("No tool loop is active. Start one with `/tool-loop start <goal>`.");
					return { handled: true, metadataMode: "fallback-loop-command" };
				}
				const stepsRun = state.toolLoopStepsRun ?? 0;
				const stepCap = Math.min(
					state.toolLoopStepCap ?? config.get<number>("toolLoop.defaultStepCap", 10),
					safety.maxLoopStepCapHard
				);
				const retryLimit = state.toolLoopRetryLimit ?? config.get<number>("toolLoop.defaultRetryLimit", 3);
				const checkpointInterval =
					state.toolLoopCheckpointInterval ?? config.get<number>("toolLoop.defaultCheckpointInterval", 5);
				const consecutiveFailures = state.toolLoopConsecutiveFailures ?? 0;

				stream.markdown(
					`**Tool loop status:**\n- Active: ${state.toolLoopActive ? "✓ yes" : "⏸ paused/stopped"}\n- Goal: ${state.toolLoopGoal ?? "(none)"}\n- Steps: ${stepsRun}/${stepCap}\n- Consecutive failures: ${consecutiveFailures}/${retryLimit}\n- Checkpoint interval: ${checkpointInterval === 0 ? "off" : `every ${checkpointInterval} steps`}\n- Pending approval: ${state.pendingApproval ? "yes" : "no"}`
				);
				return { handled: true, metadataMode: "fallback-loop-command" };
			}

			if (subCommand === "resume") {
				const state = getFallbackWorkflowState();
				if (!state?.toolLoopGoal) {
					stream.markdown("No tool loop goal set. Use `/tool-loop start <goal>` to begin a new loop.");
					return { handled: true, metadataMode: "fallback-loop-command" };
				}

				const stepsRun = state.toolLoopStepsRun ?? 0;
				const stepCap = Math.min(
					state.toolLoopStepCap ?? config.get<number>("toolLoop.defaultStepCap", 10),
					safety.maxLoopStepCapHard
				);
				if (stepsRun >= stepCap) {
					stream.markdown(
						`Tool loop already reached step cap (${stepsRun}/${stepCap}). Start a new loop with \`/tool-loop start <goal>\`.`
					);
					return { handled: true, metadataMode: "fallback-loop-command" };
				}

				await saveFallbackWorkflowState({
					...state,
					toolLoopActive: true,
					pendingApproval: false,
				});

				return {
					handled: false,
					promptOverride: `Resume tool loop toward goal: ${state.toolLoopGoal}\nCompleted steps so far: ${stepsRun}/${stepCap}\nContinue with the next concrete step.`,
				};
			}

			// Unknown subcommand
			stream.markdown(
				"Usage: `/tool-loop start [--steps N] [--retries K] [--checkpoint M] <goal>` | `/tool-loop stop` | `/tool-loop resume` | `/tool-loop status`"
			);
			return { handled: true, metadataMode: "fallback-loop-command" };
		}

		return { handled: false };
	};

	const buildCodeBlockFingerprint = (block: { language: string; code: string }): string => {
		const normalizedLanguage = block.language.trim().toLowerCase();
		const normalizedCode = block.code.replace(/\r\n/g, "\n").trim();
		return `${normalizedLanguage}::${normalizedCode}`;
	};

	const buildStructuredEditInstruction = (): string =>
		[
			"If you are proposing file changes, prefer structured edits over raw code fences.",
			"Use one or more fenced blocks with the exact fence label litellm-edit.",
			'Each block must contain JSON with either a single edit object or an {"edits":[...]} envelope.',
			"Each edit must include path, intent (create|replace), and content with the full resulting file text.",
			"Optional fields: language, description. Do not wrap content in nested markdown fences.",
			"If no file changes are needed, answer normally without emitting litellm-edit blocks.",
		].join("\n");

	const buildFallbackTools = (): vscode.LanguageModelChatTool[] => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		if (!config.get<boolean>("fallbackToolCalling.enabled", true)) {
			return [];
		}

		return [
			{
				name: "list_dir",
				description: "List entries in a workspace directory.",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string", description: "Directory path (relative to workspace or absolute)." },
					},
					additionalProperties: false,
				},
			},
			{
				name: "search_files",
				description: "Find file paths in the workspace using a glob pattern.",
				inputSchema: {
					type: "object",
					properties: {
						pattern: { type: "string", description: "Glob pattern like src/**/*.ts" },
						maxResults: { type: "number", description: "Maximum matches to return." },
					},
					required: ["pattern"],
					additionalProperties: false,
				},
			},
			{
				name: "grep_workspace",
				description: "Search file contents in the workspace (ripgrep-style).",
				inputSchema: {
					type: "object",
					properties: {
						query: { type: "string", description: "Search query or regex pattern." },
						isRegexp: { type: "boolean", description: "Whether query is regex." },
						includePattern: { type: "string", description: "Optional glob include filter." },
						maxResults: { type: "number", description: "Maximum matches to return." },
					},
					required: ["query"],
					additionalProperties: false,
				},
			},
			{
				name: "read_file",
				description: "Read an entire file.",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string", description: "File path (relative to workspace or absolute)." },
					},
					required: ["path"],
					additionalProperties: false,
				},
			},
			{
				name: "read_range",
				description: "Read a line range from a file.",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string", description: "File path." },
						startLine: { type: "number", description: "1-based start line." },
						endLine: { type: "number", description: "1-based end line (inclusive)." },
					},
					required: ["path", "startLine", "endLine"],
					additionalProperties: false,
				},
			},
			{
				name: "write_file",
				description: "Write full file content.",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string", description: "File path." },
						content: { type: "string", description: "Full file content." },
					},
					required: ["path", "content"],
					additionalProperties: false,
				},
			},
			{
				name: "apply_patch",
				description: "Apply a unified diff patch (git-apply style) in the workspace.",
				inputSchema: {
					type: "object",
					properties: {
						patch: { type: "string", description: "Unified diff patch text." },
						cwd: { type: "string", description: "Optional working directory." },
					},
					required: ["patch"],
					additionalProperties: false,
				},
			},
			{
				name: "execute_command",
				description: "Run a shell command in the workspace.",
				inputSchema: {
					type: "object",
					properties: {
						command: { type: "string", description: "Shell command." },
						cwd: { type: "string", description: "Optional working directory." },
					},
					required: ["command"],
					additionalProperties: false,
				},
			},
			{
				name: "diagnostics",
				description: "Get diagnostics/problems for a file or the whole workspace.",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string", description: "Optional file path filter." },
						severity: {
							type: "string",
							enum: ["error", "warning", "information", "hint"],
							description: "Optional severity filter.",
						},
					},
					additionalProperties: false,
				},
			},
			{
				name: "symbol_lookup",
				description: "List symbols in a file, optionally filtered by symbol name.",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string", description: "File path." },
						symbol: { type: "string", description: "Optional symbol name substring to filter." },
					},
					required: ["path"],
					additionalProperties: false,
				},
			},
			{
				name: "symbol_references",
				description: "Find references for a symbol in a file.",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string", description: "File path." },
						symbol: { type: "string", description: "Symbol text to locate in file." },
						line: { type: "number", description: "1-based line of symbol occurrence." },
						character: { type: "number", description: "1-based character at symbol occurrence." },
					},
					required: ["path"],
					additionalProperties: false,
				},
			},
			{
				name: "git_command",
				description: "Run a constrained git operation (status/log/diff/branch/checkout/commit/push/pull).",
				inputSchema: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["status", "log", "diff", "branch", "checkout", "commit", "push", "pull"],
						},
						repo_path: { type: "string" },
						branch: { type: "string" },
						message: { type: "string" },
					},
					required: ["action"],
					additionalProperties: false,
				},
			},
			{
				name: "run_tests",
				description: "Run tests with auto/jest/mocha/vitest framework selection.",
				inputSchema: {
					type: "object",
					properties: {
						test_path: { type: "string" },
						framework: { type: "string", enum: ["auto", "jest", "mocha", "vitest"] },
						cwd: { type: "string" },
					},
					required: ["test_path"],
					additionalProperties: false,
				},
			},
		];
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
				const safety = getFallbackSafetyLimits();

				stream.progress("Resolving fallback model and runtime controls...");
				const selectedModel = await selectLiteLLMChatModel(true);
				if (!selectedModel) {
					return {
						errorDetails: {
							message:
								"No LiteLLM model is available. Run 'LiteLLM: Test Connection' or 'LiteLLM: Select Chat Model' first.",
						},
					};
				}
				const attachments = classifyAttachments(request.references);
				const attachmentContext = buildAttachmentContextSection(attachments);
				const attachmentCapabilityMessage = buildAttachmentCapabilityMessage(attachments, selectedModel);
				if (attachments.imageLabels.length > 0) {
					stream.progress(
						`Detected ${attachments.imageLabels.length} image attachment${attachments.imageLabels.length === 1 ? "" : "s"}; packaging image-aware context.`
					);
					if (attachmentCapabilityMessage) {
						stream.markdown(`\n**Attachment capability:** ${attachmentCapabilityMessage}`);
					}
				}

				const activeEditorFilePath =
					vscode.window.activeTextEditor?.document.uri.scheme === "file"
						? vscode.window.activeTextEditor.document.uri.fsPath
						: undefined;
				stream.progress("Packaging task context (references, workflow state, tool history)...");
				const rankedWorkspaceContext = await buildRankedWorkspaceContext(
					effectivePrompt,
					request.references,
					chatContext.history,
					activeEditorFilePath
				);
				const editPolicy = getFallbackEditPolicy();
				const autoApplyEdits = vscode.workspace
					.getConfiguration("litellm-vscode-chat")
					.get<boolean>("autoApplyCodeEdits", false);
				const workflowState = getFallbackWorkflowState();

				const messages: vscode.LanguageModelChatRequestMessage[] = [];
				for (const turn of [...chatContext.history].slice(-safety.maxHistoryTurns)) {
					if (turn instanceof vscode.ChatRequestTurn) {
						const historyPrompt = await buildPromptWithReferences(turn.prompt, turn.references, {
							maxReferenceChars: Math.max(300, Math.floor(safety.maxPromptChars * 0.03)),
							maxTotalReferenceChars: Math.max(1000, Math.floor(safety.maxPromptChars * 0.07)),
						});
						messages.push(vscode.LanguageModelChatMessage.User(historyPrompt));
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
				const promptWithReferences = await buildPromptWithReferences("", request.references, {
					maxReferenceChars: Math.max(600, Math.floor(safety.maxPromptChars * 0.04)),
					maxTotalReferenceChars: Math.max(1800, Math.floor(safety.maxPromptChars * 0.1)),
				});
				const packagedPromptRaw = buildFallbackPromptPackage({
					taskPrompt: effectivePrompt,
					referenceContext: normalizeReferenceContext(promptWithReferences),
					rankedWorkspaceContext,
					activeEditorFilePath,
					attachmentContext,
					attachmentCapabilityMessage,
					workflowState,
					autoApplyEdits,
					editPolicy,
				});
				const packagedPrompt = clipTextWithNotice(
					packagedPromptRaw,
					safety.maxPromptChars,
					"[prompt truncated by safety limit]"
				).text;
				messages.push(vscode.LanguageModelChatMessage.User(packagedPrompt));

				const fallbackModelOptionsConfig = vscode.workspace
					.getConfiguration("litellm-vscode-chat")
					.get<Record<string, Record<string, unknown>>>("fallbackModelOptions", {});
				const resolvedFallbackOptions = resolveFallbackModelOptions(selectedModel.id, fallbackModelOptionsConfig);
				const allFallbackTools = buildFallbackTools();
				const fallbackToolControl = resolveFallbackToolControl(allFallbackTools);
				const effectiveModelOptions = applyRuntimeModelOptionOverrides(
					resolvedFallbackOptions.options ?? {},
					workflowState
				);
				const fallbackRequestOptions: vscode.ProvideLanguageModelChatResponseOptions = {
					toolMode: fallbackToolControl.toolMode ?? vscode.LanguageModelChatToolMode.Auto,
					tools: fallbackToolControl.tools,
					modelOptions: effectiveModelOptions,
				};
				if (resolvedFallbackOptions.matchedKey) {
					outputChannel.appendLine(
						`[${new Date().toISOString()}] Fallback model options matched '${resolvedFallbackOptions.matchedKey}' for ${selectedModel.id}`
					);
				}

				// Check if automatic code edits are enabled
				// Collect candidate file paths from references + prompt + history for better edit targeting
				const contextPaths = collectEditContextPaths(request.references, effectivePrompt, chatContext.history);

				// Track applied edits for notification
				let appliedEditsCount = 0;
				let streamedTextBuffer = "";
				const emittedCodeBlocks = new Set<string>();
				const responseEditTargets = new Set<string>();
				let usedActiveEditorFallbackPath = false;
				let pendingToolCall: FallbackToolCall | undefined;

				stream.progress("Sending request to selected fallback model...");
				await provider.provideLanguageModelChatResponse(
					selectedModel,
					messages,
					fallbackRequestOptions,
					{
						report: (part) => {
							if (part instanceof vscode.LanguageModelTextPart) {
								const text = clipTextWithNotice(
									part.value,
									safety.maxStreamPartChars,
									"[response chunk truncated by safety limit]"
								).text;
								stream.markdown(text);
								streamedTextBuffer += text;
								if (streamedTextBuffer.length > safety.maxResponseBufferChars) {
									streamedTextBuffer = streamedTextBuffer.slice(-safety.maxResponseBufferChars);
								}

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
										// Resolve the target path using context (references, prompt mentions, active editor).
										const blockResolution = resolveEditTargetPathSync(
											block.path,
											contextPaths,
											!usedActiveEditorFallbackPath ? activeEditorFilePath : undefined
										);
										if (blockResolution?.source === "context" && block.path) {
											outputChannel.appendLine(
												`[${new Date().toISOString()}] Resolved code block path '${block.path}' → '${blockResolution.resolvedPath}' via context`
											);
										}
										const targetPath = blockResolution?.resolvedPath;
										const policyViolation = evaluateEditPolicy(
											editPolicy,
											{ path: targetPath },
											{ activeEditorFilePath, allowUntitledTarget: !targetPath }
										);
										const targetKey = targetPath
											? normalizeCandidatePath(resolveEditUri(targetPath)?.fsPath ?? targetPath)
											: `untitled:${block.id}`;
										const exceedsMaxFiles =
											!responseEditTargets.has(targetKey) &&
											typeof editPolicy.maxFilesPerResponse === "number" &&
											responseEditTargets.size >= editPolicy.maxFilesPerResponse;
										if (policyViolation) {
											void bumpFallbackTelemetry("editMisses");
											stream.progress(`✗ Skipped ${block.language} edit: ${policyViolation}`);
											outputChannel.appendLine(
												`[${new Date().toISOString()}] Auto-apply policy blocked code edit: ${policyViolation}`
											);
											continue;
										}
										if (exceedsMaxFiles) {
											void bumpFallbackTelemetry("editMisses");
											const message = `Policy blocked edit: maxFilesPerResponse=${editPolicy.maxFilesPerResponse} reached.`;
											stream.progress(`✗ Skipped ${block.language} edit: ${message}`);
											outputChannel.appendLine(
												`[${new Date().toISOString()}] Auto-apply policy blocked code edit: ${message}`
											);
											continue;
										}
										if (blockResolution?.source === "active-editor") {
											usedActiveEditorFallbackPath = true;
										}
										if (
											block.path &&
											blockResolution?.source === "explicit" &&
											!block.path.startsWith("/") &&
											!/^[a-zA-Z]:/.test(block.path)
										) {
											void bumpFallbackTelemetry("pathInferenceMisses");
										}
										responseEditTargets.add(targetKey);

										applyCodeEdit(block.code, targetPath, undefined, block.language)
											.then((_uri) => {
												appliedEditsCount++;
												const displayPath = targetPath ? makeWorkspaceRelative(targetPath) : undefined;
												stream.progress(
													`✓ Applied ${block.language} code${displayPath ? ` to ${displayPath}` : " to new editor"} (${appliedEditsCount}/${blocks.length})`
												);
											})
											.catch((error) => {
												const errorMsg = error instanceof Error ? error.message : String(error);
												void bumpFallbackTelemetry("editMisses");
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
											arguments: [{ code: block.code, language: block.language, blockId: block.id, path: block.path }],
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

								// Display tool call — in loop mode we auto-execute, in manual mode we wait for approval
								const toolLoopIsActive = getFallbackWorkflowState()?.toolLoopActive === true;
								stream.markdown(
									`\n🔧 **Tool call${toolLoopIsActive ? " (auto-executing)" : " requested"}**: \`${part.name}\`\n\`\`\`json\n${JSON.stringify(part.input ?? {}, null, 2)}\n\`\`\``
								);
								if (!toolLoopIsActive) {
									stream.markdown(
										"Use `/tool-approve` to execute this tool or `/tool-reject` to skip it. Waiting for your decision..."
									);
								}
							}
						},
					},
					token
				);

				const rawStructuredEdits = extractStructuredEdits(streamedTextBuffer).filter((edit) => Boolean(edit.content));
				if (rawStructuredEdits.length > 0) {
					// Resolve edit target paths via context / workspace before policy evaluation
					const structuredEdits = await Promise.all(
						rawStructuredEdits.map(async (edit) => {
							const resolution = await resolveEditTargetPath(
								edit.path,
								edit.intent,
								contextPaths,
								activeEditorFilePath
							);
							if (!resolution) {
								if (edit.path) {
									void bumpFallbackTelemetry("pathInferenceMisses");
								}
								return edit;
							}
							if (
								edit.path &&
								resolution.source === "explicit" &&
								!edit.path.startsWith("/") &&
								!/^[a-zA-Z]:/.test(edit.path)
							) {
								void bumpFallbackTelemetry("pathInferenceMisses");
							}
							const newPath = makeWorkspaceRelative(resolution.resolvedPath);
							const currentResolved = resolveEditUri(edit.path)?.fsPath ?? edit.path;
							if (normalizeCandidatePath(resolution.resolvedPath) !== normalizeCandidatePath(currentResolved)) {
								outputChannel.appendLine(
									`[${new Date().toISOString()}] Resolved structured edit path '${edit.path}' → '${newPath}' via ${resolution.source}`
								);
								return { ...edit, path: newPath };
							}
							return edit;
						})
					);
					const batchSizeViolation = enforceBatchSizePolicy(editPolicy, structuredEdits);
					if (batchSizeViolation) {
						void bumpFallbackTelemetry("editMisses", structuredEdits.length);
					}
					const batch: FallbackPendingEditBatch = {
						id: createPendingEditBatchId(),
						createdAt: Date.now(),
						modelId: selectedModel.id,
						edits: structuredEdits.map((edit) => {
							const policyError =
								batchSizeViolation ?? evaluateEditPolicy(editPolicy, { path: edit.path }, { activeEditorFilePath });
							if (policyError) {
								void bumpFallbackTelemetry("editMisses");
							}
							return {
								id: edit.id,
								path: edit.path,
								intent: edit.intent,
								content: edit.content ?? "",
								language: edit.language,
								description: edit.description,
								status: policyError ? "rejected" : "pending",
								error: policyError,
							};
						}),
					};
					await savePendingEditBatch(batch);
					stream.progress(
						`Staged ${batch.edits.length} structured edit${batch.edits.length === 1 ? "" : "s"}. Use /edit-status for details and next actions.`
					);
					stream.markdown(formatPendingEditBatch(batch));
					stream.markdown(
						"\n**Next step suggestions:**\n- Preview and accept/reject high-risk files first\n- Run `/edit-status` to review current batch state\n- Click **Apply Staged Edits** when ready"
					);
					stream.button({ title: "Apply Staged Edits", command: "litellm.applyStagedEdits", arguments: [] });
					stream.button({ title: "Discard Staged Edits", command: "litellm.discardStagedEdits", arguments: [] });
					for (const edit of batch.edits) {
						stream.button({
							title: `Preview ${edit.path}`,
							command: "litellm.previewPendingEdit",
							arguments: [edit.id],
						});
						stream.button({
							title: `Accept ${edit.path}`,
							command: "litellm.acceptPendingEdit",
							arguments: [edit.id],
						});
						stream.button({
							title: `Reject ${edit.path}`,
							command: "litellm.rejectPendingEdit",
							arguments: [edit.id],
						});
					}
				}

				// If there was a tool call, add it to the workflow state and wait for approval
				if (pendingToolCall) {
					const loopState = getFallbackWorkflowState();

					if (loopState?.toolLoopActive) {
						const safety = getFallbackSafetyLimits();
						// === TOOL LOOP MODE: Auto-execute tools, looping until cap / retry-limit / checkpoint / done ===
						const loopConfig = vscode.workspace.getConfiguration("litellm-vscode-chat");
						const stepCap = Math.min(
							loopState.toolLoopStepCap ?? loopConfig.get<number>("toolLoop.defaultStepCap", 10),
							safety.maxLoopStepCapHard
						);
						const retryLimit = loopState.toolLoopRetryLimit ?? loopConfig.get<number>("toolLoop.defaultRetryLimit", 3);
						const checkpointInterval =
							loopState.toolLoopCheckpointInterval ?? loopConfig.get<number>("toolLoop.defaultCheckpointInterval", 5);

						let stepsRun = loopState.toolLoopStepsRun ?? 0;
						let consecutiveFailures = loopState.toolLoopConsecutiveFailures ?? 0;
						let loopExitReason: "cap" | "retry-limit" | "checkpoint" | "done" | undefined;
						let currentToolCall: FallbackToolCall | undefined = pendingToolCall;

						while (currentToolCall && !loopExitReason) {
							stepsRun++;
							stream.progress(`[Tool Loop ${stepsRun}/${stepCap}] Executing \`${currentToolCall.name}\`...`);
							await addToolCall({ ...currentToolCall, status: "pending" });

							let toolResultText: string;
							const executedAt = Date.now();
							const tcId = currentToolCall.id;
							const tcName = currentToolCall.name;
							const tcArgs = currentToolCall.arguments;

							try {
								const result = await executeFallbackTool(tcName, tcArgs);
								if (result.success) {
									const clippedOutput = clipTextWithNotice(
										result.output,
										safety.maxToolResultChars,
										"[tool output truncated by safety limit]"
									).text;
									await updateToolCall(tcId, {
										status: "executed",
										executedAt,
										result: clippedOutput,
										resultMeta: result.meta,
									});
									consecutiveFailures = 0;
									toolResultText = clipTextWithNotice(
										formatToolResult({ ...result, output: clippedOutput }),
										safety.maxToolResultChars,
										"[formatted tool output truncated by safety limit]"
									).text;
									stream.markdown(
										`\n✓ **[Loop ${stepsRun}/${stepCap}]** \`${tcName}\`\n\`\`\`\n${toolResultText}\n\`\`\``
									);
								} else {
									void bumpFallbackTelemetry("toolFailures");
									await updateToolCall(tcId, {
										status: "failed",
										executedAt,
										error: result.error,
										resultMeta: result.meta,
									});
									consecutiveFailures++;
									toolResultText = `Error: ${result.error ?? "(unknown)"}`;
									const exitNote = result.meta?.exitCode !== undefined ? ` (exit code: ${result.meta.exitCode})` : "";
									stream.markdown(`\n✗ **[Loop ${stepsRun}/${stepCap}]** \`${tcName}\`${exitNote}: ${result.error}`);
								}
							} catch (toolError) {
								const errMsg = toolError instanceof Error ? toolError.message : String(toolError);
								void bumpFallbackTelemetry("toolFailures");
								await updateToolCall(tcId, {
									status: "failed",
									executedAt: Date.now(),
									error: errMsg,
								});
								consecutiveFailures++;
								toolResultText = `Error: ${errMsg}`;
								stream.markdown(`\n✗ **[Loop ${stepsRun}/${stepCap}]** \`${tcName}\` unexpected error: ${errMsg}`);
							}

							// Persist step state
							const stateAfterStep = getFallbackWorkflowState();
							if (stateAfterStep) {
								const stepNote = `Loop step ${stepsRun}: ${tcName} ${consecutiveFailures > 0 ? "failed" : "succeeded"}`;
								await saveFallbackWorkflowState({
									...stateAfterStep,
									toolLoopStepsRun: stepsRun,
									toolLoopConsecutiveFailures: consecutiveFailures,
									pendingToolCallId: undefined,
									notes: [...stateAfterStep.notes, stepNote],
								});
							}

							// Evaluate stop conditions
							if (consecutiveFailures >= retryLimit) {
								loopExitReason = "retry-limit";
							} else if (stepsRun >= stepCap) {
								loopExitReason = "cap";
							} else if (checkpointInterval > 0 && stepsRun % checkpointInterval === 0) {
								loopExitReason = "checkpoint";
							}

							if (loopExitReason) {
								break;
							}

							// Continue: inject tool result and call the model again
							messages.push(
								vscode.LanguageModelChatMessage.Assistant(
									`Executed tool \`${tcName}\` with arguments: ${JSON.stringify(tcArgs)}`
								)
							);
							messages.push(vscode.LanguageModelChatMessage.User(`Tool result for \`${tcName}\`:\n${toolResultText}`));

							// Reset for next turn
							pendingToolCall = undefined;
							streamedTextBuffer = "";
							currentToolCall = undefined;

							stream.progress(`[Tool Loop ${stepsRun + 1}/${stepCap}] Thinking...`);
							await provider.provideLanguageModelChatResponse(
								selectedModel,
								messages,
								fallbackRequestOptions,
								{
									report: (part) => {
										if (part instanceof vscode.LanguageModelTextPart) {
											const safeChunk = clipTextWithNotice(
												part.value,
												safety.maxStreamPartChars,
												"[response chunk truncated by safety limit]"
											).text;
											stream.markdown(safeChunk);
											streamedTextBuffer += safeChunk;
											if (streamedTextBuffer.length > safety.maxResponseBufferChars) {
												streamedTextBuffer = streamedTextBuffer.slice(-safety.maxResponseBufferChars);
											}
										} else if (part instanceof vscode.LanguageModelToolCallPart) {
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
											stream.markdown(
												`\n🔧 **Tool call (auto-executing)**: \`${part.name}\`\n\`\`\`json\n${JSON.stringify(part.input ?? {}, null, 2)}\n\`\`\``
											);
										}
									},
								},
								token
							);

							currentToolCall = pendingToolCall;
							if (!currentToolCall) {
								loopExitReason = "done";
							}
						}

						// Loop ended — update state and emit exit summary
						const finalState = getFallbackWorkflowState();
						const isPaused = loopExitReason === "checkpoint";
						if (finalState) {
							await saveFallbackWorkflowState({
								...finalState,
								toolLoopActive: isPaused ? true : false,
								pendingApproval: isPaused,
								pendingToolCallId: undefined,
								notes: [...finalState.notes, `Tool loop ended (${loopExitReason ?? "done"}): ${stepsRun} steps`],
							});
						}

						const exitEmoji =
							loopExitReason === "done"
								? "✅"
								: loopExitReason === "checkpoint"
									? "⏸"
									: loopExitReason === "retry-limit"
										? "🔴"
										: "⏹";
						const exitSummary = {
							stepsRun,
							consecutiveFailures,
							reason: loopExitReason ?? "done",
						};
						stream.markdown(
							`\n${exitEmoji} **Tool loop ended** — reason: \`${exitSummary.reason}\`\n\n\`\`\`json\n${JSON.stringify(exitSummary, null, 2)}\n\`\`\``
						);
						if (isPaused) {
							stream.markdown(
								`\nCheckpoint at step ${stepsRun}. Run \`/tool-loop resume\` to continue or \`/tool-loop stop\` to end.`
							);
						}
					} else {
						// === MANUAL MODE: Save tool call and wait for user approval ===
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

						stream.markdown(
							"\n**Next step:** Type `/tool-approve` to execute the tool request, or `/tool-reject` to skip it."
						);
					}
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

				const finalState = getFallbackWorkflowState();
				const finalBatch = getPendingEditBatch();
				const nextSteps = buildNextStepSuggestions(finalState, finalBatch);
				stream.progress(`Request complete. ${summarizePendingEditBatch(finalBatch)}`);
				stream.markdown(
					`\n**Suggested next actions:**\n${nextSteps
						.slice(0, 3)
						.map((item) => `- ${item}`)
						.join("\n")}`
				);

				return {
					metadata: {
						modelId: selectedModel.id,
						mode: workflowCommand.loopInstruction ? "fallback-loop-step" : "fallback-chat-participant",
					},
				};
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				void bumpFallbackTelemetry("toolFailures");
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
			} else {
				void bumpFallbackTelemetry("providerRegistrationIssues");
				outputChannel.appendLine(
					`[${new Date().toISOString()}] Language model provider unavailable during registration attempt (${source}).`
				);
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			void bumpFallbackTelemetry("providerRegistrationIssues");
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
		vscode.commands.registerCommand("litellm.previewPendingEdit", async (editId?: string) => {
			const batch = getPendingEditBatch();
			const edit = batch?.edits.find((item) => item.id === editId);
			if (!edit) {
				await vscode.window.showWarningMessage("No staged edit found for preview.");
				return;
			}
			await applyCodeEdit(edit.content, undefined, undefined, edit.language);
			await vscode.window.showInformationMessage(`Preview opened for ${edit.path}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.acceptPendingEdit", async (editId?: string) => {
			const batch = await updatePendingEditStatus(String(editId ?? ""), "accepted");
			if (!batch) {
				await vscode.window.showWarningMessage("No staged edit found to accept.");
				return;
			}
			const edit = batch.edits.find((item) => item.id === editId);
			await vscode.window.showInformationMessage(`Accepted staged edit: ${edit?.path ?? editId}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.rejectPendingEdit", async (editId?: string) => {
			const batch = await updatePendingEditStatus(String(editId ?? ""), "rejected");
			if (!batch) {
				await vscode.window.showWarningMessage("No staged edit found to reject.");
				return;
			}
			await bumpFallbackTelemetry("approvalRejects");
			const edit = batch.edits.find((item) => item.id === editId);
			await vscode.window.showInformationMessage(`Rejected staged edit: ${edit?.path ?? editId}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.applyStagedEdits", async () => {
			const batch = getPendingEditBatch();
			if (!batch) {
				await vscode.window.showWarningMessage("No staged edits to apply.");
				return;
			}
			const result = await applyPendingEditBatch();
			if (!result.batch) {
				await vscode.window.showWarningMessage("No staged edits to apply.");
				return;
			}
			const remaining = result.batch.edits.filter((edit) => edit.status === "pending" || edit.status === "accepted");
			if (remaining.length === 0) {
				await clearPendingEditBatch();
			}
			await vscode.window.showInformationMessage(
				`Applied ${result.applied} staged edit${result.applied === 1 ? "" : "s"}${
					result.failed > 0 ? `, ${result.failed} failed` : ""
				}.`
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.discardStagedEdits", async () => {
			if (!getPendingEditBatch()) {
				await vscode.window.showWarningMessage("No staged edits to discard.");
				return;
			}
			await clearPendingEditBatch();
			await vscode.window.showInformationMessage("Discarded staged edits.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.showStagedEdits", async () => {
			const batch = getPendingEditBatch();
			if (!batch) {
				await vscode.window.showInformationMessage("No staged edits.");
				return;
			}
			await vscode.window.showInformationMessage(formatPendingEditBatch(batch), { modal: true });
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"litellm.applyCodeEdit",
			async (editRequest?: {
				code: string;
				language: string;
				blockId: string;
				path?: string;
				intent?: "create" | "replace";
			}) => {
				if (!editRequest || !editRequest.code) {
					await vscode.window.showErrorMessage("No code edit provided.");
					return;
				}

				const activeEditor = vscode.window.activeTextEditor;
				const currentFile = activeEditor?.document.uri.fsPath;
				const editPolicy = getFallbackEditPolicy();

				try {
					// If there's an active editor in a workspace file, ask user about replacement
					if (currentFile && vscode.workspace.workspaceFolders?.length) {
						const quickPickItems: { label: string; description?: string; value: string }[] = [
							{
								label: "Replace current file",
								description: currentFile,
								value: "replace",
							},
							{
								label: "Open in new untitled editor",
								value: "new",
							},
						];
						if (editRequest.path) {
							quickPickItems.splice(1, 0, {
								label: "Apply to suggested file path",
								description: editRequest.path,
								value: "suggested",
							});
						}

						const choice = await vscode.window.showQuickPick(quickPickItems, { title: "Apply Code Edit" });

						if (!choice) {
							return;
						}

						if (choice.value === "replace") {
							const policyViolation = evaluateEditPolicy(
								editPolicy,
								{ path: currentFile },
								{ activeEditorFilePath: currentFile }
							);
							if (policyViolation) {
								await vscode.window.showWarningMessage(policyViolation);
								return;
							}
							const appliedUri = await applyCodeEdit(editRequest.code, currentFile, undefined, editRequest.language);
							await vscode.window.showInformationMessage(
								`Code edit applied: ${appliedUri.fsPath || appliedUri.scheme}`
							);
						} else if (choice.value === "suggested" && editRequest.path) {
							const policyViolation = evaluateEditPolicy(
								editPolicy,
								{ path: editRequest.path },
								{ activeEditorFilePath: currentFile }
							);
							if (policyViolation) {
								await vscode.window.showWarningMessage(policyViolation);
								return;
							}
							const appliedUri = editRequest.intent
								? await applyStructuredEdit({
										id: editRequest.blockId,
										path: editRequest.path,
										intent: editRequest.intent,
										content: editRequest.code,
										language: editRequest.language,
									})
								: await applyCodeEdit(editRequest.code, editRequest.path, undefined, editRequest.language);
							await vscode.window.showInformationMessage(
								`Code edit applied: ${appliedUri.fsPath || appliedUri.scheme}`
							);
						} else {
							const policyViolation = evaluateEditPolicy(
								editPolicy,
								{ path: undefined },
								{ activeEditorFilePath: currentFile, allowUntitledTarget: true }
							);
							if (policyViolation) {
								await vscode.window.showWarningMessage(policyViolation);
								return;
							}
							const appliedUri = await applyCodeEdit(editRequest.code, undefined, undefined, editRequest.language);
							await vscode.window.showInformationMessage(
								`Code edit applied: ${appliedUri.fsPath || appliedUri.scheme}`
							);
						}
					} else {
						// No active editor, create untitled
						const policyViolation = evaluateEditPolicy(editPolicy, { path: undefined }, { allowUntitledTarget: true });
						if (policyViolation) {
							await vscode.window.showWarningMessage(policyViolation);
							return;
						}
						await applyCodeEdit(editRequest.code, undefined, undefined, editRequest.language);
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
				const fallbackTelemetry = getFallbackTelemetry();

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
					`Fallback Telemetry Counters:`,
					`  Tool Failures: ${fallbackTelemetry.toolFailures}`,
					`  Edit Misses: ${fallbackTelemetry.editMisses}`,
					`  Path Inference Misses: ${fallbackTelemetry.pathInferenceMisses}`,
					`  Approval Rejects: ${fallbackTelemetry.approvalRejects}`,
					`  Provider Registration Issues: ${fallbackTelemetry.providerRegistrationIssues}`,
					`  Counters Updated: ${
						fallbackTelemetry.lastUpdated ? new Date(fallbackTelemetry.lastUpdated).toLocaleString() : "Never"
					}`,
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
