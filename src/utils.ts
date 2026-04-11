import * as vscode from "vscode";
import type {
	OpenAIChatContentBlock,
	OpenAIChatMessage,
	OpenAIChatRole,
	OpenAIFunctionToolDef,
	OpenAIToolCall,
} from "./types";

// Tool calling sanitization helpers

function isIntegerLikePropertyName(propertyName: string | undefined): boolean {
	if (!propertyName) {
		return false;
	}
	const lowered = propertyName.toLowerCase();
	const integerMarkers = [
		"id",
		"limit",
		"count",
		"index",
		"size",
		"offset",
		"length",
		"results_limit",
		"maxresults",
		"debugsessionid",
		"cellid",
	];
	return integerMarkers.some((m) => lowered.includes(m)) || lowered.endsWith("_id");
}

function sanitizeFunctionName(name: unknown): string {
	if (typeof name !== "string" || !name) {
		return "tool";
	}
	let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (!/^[a-zA-Z]/.test(sanitized)) {
		sanitized = `tool_${sanitized}`;
	}
	sanitized = sanitized.replace(/_+/g, "_");
	return sanitized.slice(0, 64);
}

function pruneUnknownSchemaKeywords(schema: unknown): Record<string, unknown> {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return {};
	}
	const allow = new Set([
		"type",
		"properties",
		"required",
		"additionalProperties",
		"description",
		"enum",
		"default",
		"items",
		"minLength",
		"maxLength",
		"minimum",
		"maximum",
		"pattern",
		"format",
	]);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
		if (allow.has(k)) {
			out[k] = v as unknown;
		}
	}
	return out;
}

function sanitizeSchema(input: unknown, propName?: string): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { type: "object", properties: {} } as Record<string, unknown>;
	}

	let schema = input as Record<string, unknown>;

	for (const composite of ["anyOf", "oneOf", "allOf"]) {
		const branch = (schema as Record<string, unknown>)[composite] as unknown;
		if (Array.isArray(branch) && branch.length > 0) {
			let preferred: Record<string, unknown> | undefined;
			for (const b of branch) {
				if (b && typeof b === "object" && (b as Record<string, unknown>).type === "string") {
					preferred = b as Record<string, unknown>;
					break;
				}
			}
			schema = { ...(preferred ?? (branch[0] as Record<string, unknown>)) };
			break;
		}
	}

	schema = pruneUnknownSchemaKeywords(schema);

	let t = schema.type as string | undefined;
	if (t == null) {
		t = "object";
		schema.type = t;
	}

	if (t === "number" && propName && isIntegerLikePropertyName(propName)) {
		schema.type = "integer";
		t = "integer";
	}

	if (t === "object") {
		const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
		const newProps: Record<string, unknown> = {};
		if (props && typeof props === "object") {
			for (const [k, v] of Object.entries(props)) {
				newProps[k] = sanitizeSchema(v, k);
			}
		}
		schema.properties = newProps;

		const req = schema.required as unknown;
		if (Array.isArray(req)) {
			schema.required = req.filter((r) => typeof r === "string");
		} else if (req !== undefined) {
			schema.required = [];
		}

		const ap = schema.additionalProperties as unknown;
		if (ap !== undefined && typeof ap !== "boolean") {
			delete schema.additionalProperties;
		}
	} else if (t === "array") {
		const items = schema.items as unknown;
		if (Array.isArray(items) && items.length > 0) {
			schema.items = sanitizeSchema(items[0]);
		} else if (items && typeof items === "object") {
			schema.items = sanitizeSchema(items);
		} else {
			schema.items = { type: "string" } as Record<string, unknown>;
		}
	}

	return schema;
}

/**
 * Convert VS Code chat request messages into OpenAI-compatible message objects.
 * @param messages The VS Code chat messages to convert.
 * @returns OpenAI-compatible messages array.
 */
// Optionally mark the system prompt with cache_control for prompt caching.
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options?: { cacheSystemPrompt?: boolean }
): OpenAIChatMessage[] {
	const out: OpenAIChatMessage[] = [];
	for (const m of messages) {
		const role = mapRole(m);
		const textParts: string[] = [];
		const toolCalls: OpenAIToolCall[] = [];
		const toolResults: { callId: string; content: string }[] = [];

		for (const part of m.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				const id = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				let args;
				try {
					args = JSON.stringify(part.input ?? {});
				} catch {
					args = "{}";
				}
				toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
			} else if (isToolResultPart(part)) {
				const callId = (part as { callId?: string }).callId ?? "";
				const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
				toolResults.push({ callId, content });
			}
		}

		let emittedAssistantToolCall = false;
		if (toolCalls.length > 0) {
			out.push({ role: "assistant", content: textParts.join("") || undefined, tool_calls: toolCalls });
			emittedAssistantToolCall = true;
		}

		for (const tr of toolResults) {
			out.push({ role: "tool", tool_call_id: tr.callId, content: tr.content || "" });
		}

		const text = textParts.join("");
		if (text && (role === "system" || role === "user" || (role === "assistant" && !emittedAssistantToolCall))) {
			if (role === "system" && options?.cacheSystemPrompt) {
				const content: OpenAIChatContentBlock[] = [
					{
						type: "text",
						text,
						cache_control: { type: "ephemeral" },
					},
				];
				out.push({ role, content });
			} else {
				out.push({ role, content: text });
			}
		}
	}
	return out;
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * @param options Request options containing tools and toolMode.
 */
export function convertTools(options: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
	const tools = options.tools ?? [];
	if (!tools || tools.length === 0) {
		return {};
	}

	const toolDefs: OpenAIFunctionToolDef[] = tools
		.filter((t): t is vscode.LanguageModelChatTool => t && typeof t === "object")
		.map((t: vscode.LanguageModelChatTool) => {
			const name = sanitizeFunctionName(t.name);
			const description = typeof t.description === "string" ? t.description : "";
			const params = sanitizeSchema(t.inputSchema ?? { type: "object", properties: {} });
			return {
				type: "function" as const,
				function: {
					name,
					description,
					parameters: params,
				},
			} satisfies OpenAIFunctionToolDef;
		});

	let tool_choice: "auto" | { type: "function"; function: { name: string } } = "auto";
	if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
		if (tools.length !== 1) {
			console.error("[LiteLLM Model Provider] ToolMode.Required but multiple tools:", tools.length);
			throw new Error("LanguageModelChatToolMode.Required is not supported with more than one tool");
		}
		tool_choice = { type: "function", function: { name: sanitizeFunctionName(tools[0].name) } };
	}

	return { tools: toolDefs, tool_choice };
}

/**
 * Validate tool names to ensure they contain only word chars, hyphens, or underscores.
 * @param tools Tools to validate.
 */
export function validateTools(tools: readonly vscode.LanguageModelChatTool[]): void {
	for (const tool of tools) {
		if (!tool.name.match(/^[\w-]+$/)) {
			console.error("[LiteLLM Model Provider] Invalid tool name detected:", tool.name);
			throw new Error(
				`Invalid tool name "${tool.name}": only alphanumeric characters, hyphens, and underscores are allowed.`
			);
		}
	}
}

/**
 * Validate the request message sequence for correct tool call/result pairing.
 * @param messages The full request message list.
 */
export function validateRequest(messages: readonly vscode.LanguageModelChatRequestMessage[]): void {
	const lastMessage = messages[messages.length - 1];
	if (!lastMessage) {
		console.error("[LiteLLM Model Provider] No messages in request");
		throw new Error("Invalid request: no messages.");
	}

	messages.forEach((message, i) => {
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const toolCallIds = new Set(
				message.content
					.filter((part) => part instanceof vscode.LanguageModelToolCallPart)
					.map((part) => (part as unknown as vscode.LanguageModelToolCallPart).callId)
			);
			if (toolCallIds.size === 0) {
				return;
			}

			let nextMessageIdx = i + 1;
			const errMsg =
				"Invalid request: Tool call part must be followed by a User message with a LanguageModelToolResultPart with a matching callId.";
			while (toolCallIds.size > 0) {
				const nextMessage = messages[nextMessageIdx++];
				if (!nextMessage || nextMessage.role !== vscode.LanguageModelChatMessageRole.User) {
					console.error(
						"[LiteLLM Model Provider] Validation failed: missing tool result for call IDs:",
						Array.from(toolCallIds)
					);
					throw new Error(errMsg);
				}

				nextMessage.content.forEach((part) => {
					if (!isToolResultPart(part)) {
						const ctorName =
							(Object.getPrototypeOf(part as object) as { constructor?: { name?: string } } | undefined)?.constructor
								?.name ?? typeof part;
						console.error("[LiteLLM Model Provider] Validation failed: expected tool result part, got:", ctorName);
						throw new Error(errMsg);
					}
					const callId = (part as { callId: string }).callId;
					toolCallIds.delete(callId);
				});
			}
		}
	});
}

/**
 * Type guard for LanguageModelToolResultPart-like values.
 * @param value Unknown value to test.
 */
export function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

/**
 * Map VS Code message role to OpenAI message role string.
 * @param message The message whose role is mapped.
 */
function mapRole(message: vscode.LanguageModelChatRequestMessage): Exclude<OpenAIChatRole, "tool"> {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

/**
 * Concatenate tool result content into a single text string.
 * @param pr Tool result-like object with content array.
 */
function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		} else {
			try {
				text += JSON.stringify(c);
			} catch {
				/* ignore */
			}
		}
	}
	return text;
}

/**
 * Try to parse a JSON object from a string.
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		if (!text || !/[{]/.test(text)) {
			return { ok: false };
		}
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}

const DEFAULT_MAX_REFERENCE_CHARS = 12000;
const DEFAULT_MAX_TOTAL_REFERENCE_CHARS = 48000;

type ResolveChatPromptReferenceText = (
	reference: vscode.ChatPromptReference
) => Promise<{ label?: string; content?: string } | undefined>;

/**
 * Build prompt text that includes selected code and attached-file references from the chat request.
 * @param prompt User-authored prompt text.
 * @param references References attached to the chat request.
 * @param options Optional hooks for testing and truncation.
 */
export async function buildPromptWithReferences(
	prompt: string,
	references: readonly vscode.ChatPromptReference[],
	options?: {
		resolveReferenceText?: ResolveChatPromptReferenceText;
		maxReferenceChars?: number;
		maxTotalReferenceChars?: number;
	}
): Promise<string> {
	if (references.length === 0) {
		return prompt;
	}

	const resolveReferenceText = options?.resolveReferenceText ?? defaultResolveChatPromptReferenceText;
	const maxReferenceChars = options?.maxReferenceChars ?? DEFAULT_MAX_REFERENCE_CHARS;
	let remainingChars = options?.maxTotalReferenceChars ?? DEFAULT_MAX_TOTAL_REFERENCE_CHARS;
	const sections: string[] = [];

	for (const [index, reference] of references.entries()) {
		const resolved = await resolveReferenceText(reference);
		const lines = [`Reference ${index + 1}`];

		if (reference.modelDescription) {
			lines.push(`Description: ${reference.modelDescription}`);
		}

		if (resolved?.label) {
			lines.push(`Source: ${resolved.label}`);
		}

		const rawContent = resolved?.content?.trim();
		if (rawContent) {
			if (remainingChars <= 0) {
				lines.push("Content omitted because the attached context limit was reached.");
			} else {
				const perReferenceLimit = Math.min(maxReferenceChars, remainingChars);
				const truncatedContent = truncateText(rawContent, perReferenceLimit);
				remainingChars -= truncatedContent.length;
				lines.push("Content:");
				lines.push(truncatedContent);
			}
		}

		sections.push(lines.join("\n"));
	}

	if (sections.length === 0) {
		return prompt;
	}

	const trimmedPrompt = prompt.trim();
	const promptPrefix = trimmedPrompt ? `${trimmedPrompt}\n\n` : "";
	return `${promptPrefix}Additional context from chat references:\n\n${sections.join("\n\n")}`;
}

async function defaultResolveChatPromptReferenceText(
	reference: vscode.ChatPromptReference
): Promise<{ label?: string; content?: string } | undefined> {
	const value = reference.value;

	if (typeof value === "string") {
		return { label: reference.id, content: value };
	}

	if (value instanceof vscode.Location) {
		const label = `${formatUriForPrompt(value.uri)}:${value.range.start.line + 1}-${value.range.end.line + 1}`;
		try {
			const document = await vscode.workspace.openTextDocument(value.uri);
			return { label, content: document.getText(value.range) };
		} catch {
			return { label, content: reference.modelDescription };
		}
	}

	if (value instanceof vscode.Uri) {
		const label = formatUriForPrompt(value);
		try {
			const document = await vscode.workspace.openTextDocument(value);
			return { label, content: document.getText() };
		} catch {
			return { label, content: reference.modelDescription };
		}
	}

	if (reference.modelDescription) {
		return { label: reference.id, content: reference.modelDescription };
	}

	try {
		return { label: reference.id, content: JSON.stringify(value, null, 2) };
	} catch {
		return { label: reference.id, content: String(value) };
	}
}

function formatUriForPrompt(uri: vscode.Uri): string {
	return uri.scheme === "file" && uri.fsPath ? uri.fsPath : uri.toString();
}

function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}

	const suffix = "\n... [truncated]";
	return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

/**
 * A code block suggestion extracted from model output.
 */
export interface CodeBlockSuggestion {
	id: string;
	language: string;
	code: string;
	path?: string; // Optional file path if identifiable from context
	description?: string; // Optional description of what the code does
}

/**
 * Extract code blocks from markdown text that may contain code suggestions.
 * @param text Markdown text potentially containing code blocks.
 * @returns Array of extracted code blocks.
 */
export function extractCodeBlocks(text: string): CodeBlockSuggestion[] {
	const blocks: CodeBlockSuggestion[] = [];
	const codeBlockRegex = /```([a-z0-9-]*)(\n|\r\n)([\s\S]*?)```/g;

	let match;
	let blockIndex = 0;
	while ((match = codeBlockRegex.exec(text)) !== null) {
		const language = match[1] || "text";
		const code = match[3].trim();

		if (code.length > 0) {
			blocks.push({
				id: `code-block-${blockIndex}`,
				language,
				code,
			});
			blockIndex++;
		}
	}

	return blocks;
}

/**
 * Apply a code block to a file in the workspace, replacing the entire content or a specific range.
 * @param code The code to apply.
 * @param filePath Optional file path. If provided, creates/replaces the file. If not, opens an untitled editor.
 * @param range Optional range to replace instead of entire content.
 * @returns The URI of the editor where code was applied.
 */
export async function applyCodeEdit(code: string, filePath?: string, range?: vscode.Range): Promise<vscode.Uri> {
	let uri: vscode.Uri;

	if (filePath) {
		// Check if path is absolute or workspace-relative
		const isAbsolute = filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath);
		if (!isAbsolute && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
			const workspaceFolder = vscode.workspace.workspaceFolders[0];
			uri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
		} else {
			uri = vscode.Uri.file(filePath);
		}
	} else {
		// Create untitled document
		uri = vscode.Uri.parse(`untitled:Suggested Edit.txt`);
	}

	const edit = new vscode.WorkspaceEdit();

	if (range) {
		// Replace specific range
		edit.replace(uri, range, code);
	} else {
		// Replace all content
		let document: vscode.TextDocument | null = null;
		try {
			document = await vscode.workspace.openTextDocument(uri);
		} catch {
			document = null;
		}
		if (document) {
			const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
			edit.replace(uri, fullRange, code);
		} else {
			// For new files, insert at position 0
			edit.insert(uri, new vscode.Position(0, 0), code);
		}
	}

	await vscode.workspace.applyEdit(edit);
	const editor = await vscode.window.showTextDocument(uri, { preview: false });
	editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

	return uri;
}
