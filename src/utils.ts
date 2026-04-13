import * as vscode from "vscode";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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

	// VS Code provides references sorted in reverse order by range. Reorder them
	// into prompt order so the numbered sections read naturally for the model.
	const orderedReferences = orderReferencesByPromptPosition(references);
	const resolveReferenceText = options?.resolveReferenceText ?? defaultResolveChatPromptReferenceText;
	const maxReferenceChars = options?.maxReferenceChars ?? DEFAULT_MAX_REFERENCE_CHARS;
	let remainingChars = options?.maxTotalReferenceChars ?? DEFAULT_MAX_TOTAL_REFERENCE_CHARS;
	const sections: string[] = [];
	const referencesWithOrder = orderedReferences.map((reference, index) => ({ reference, order: index + 1 }));
	const rewrittenPrompt = rewritePromptReferenceMentions(prompt, referencesWithOrder);

	for (const { reference, order } of referencesWithOrder) {
		const resolved = await resolveReferenceText(reference);
		const lines = [`Reference ${order}`];

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
		return rewrittenPrompt;
	}

	const trimmedPrompt = rewrittenPrompt.trim();
	const promptPrefix = trimmedPrompt ? `${trimmedPrompt}\n\n` : "";
	return `${promptPrefix}Additional context from chat references:\n\n${sections.join("\n\n")}`;
}

function orderReferencesByPromptPosition(
	references: readonly vscode.ChatPromptReference[]
): readonly vscode.ChatPromptReference[] {
	const indexed = references.map((reference, index) => ({ reference, index }));
	indexed.sort((a, b) => {
		const aStart = getReferenceRangeStart(a.reference);
		const bStart = getReferenceRangeStart(b.reference);

		if (aStart !== undefined && bStart !== undefined) {
			return aStart - bStart;
		}
		if (aStart !== undefined) {
			return -1;
		}
		if (bStart !== undefined) {
			return 1;
		}
		return a.index - b.index;
	});

	return indexed.map((item) => item.reference);
}

function rewritePromptReferenceMentions(
	prompt: string,
	referencesWithOrder: ReadonlyArray<{ reference: vscode.ChatPromptReference; order: number }>
): string {
	if (!prompt || referencesWithOrder.length === 0) {
		return prompt;
	}

	let rewritten = prompt;
	const referencesWithRanges = referencesWithOrder
		.filter((item) => hasValidReferenceRange(item.reference, prompt.length))
		.sort((a, b) => {
			const aStart = getReferenceRangeStart(a.reference) ?? 0;
			const bStart = getReferenceRangeStart(b.reference) ?? 0;
			return bStart - aStart;
		});

	for (const item of referencesWithRanges) {
		const range = item.reference.range as [number, number];
		const replacement = `[Reference ${item.order}]`;
		rewritten = `${rewritten.slice(0, range[0])}${replacement}${rewritten.slice(range[1])}`;
	}

	return rewritten;
}

function getReferenceRangeStart(reference: vscode.ChatPromptReference): number | undefined {
	if (!reference.range || reference.range.length !== 2) {
		return undefined;
	}
	const [start, end] = reference.range;
	if (typeof start !== "number" || typeof end !== "number" || start < 0 || end <= start) {
		return undefined;
	}
	return start;
}

function hasValidReferenceRange(reference: vscode.ChatPromptReference, maxLength: number): boolean {
	if (!reference.range || reference.range.length !== 2) {
		return false;
	}
	const [start, end] = reference.range;
	if (typeof start !== "number" || typeof end !== "number") {
		return false;
	}
	return start >= 0 && end > start && end <= maxLength;
}

async function defaultResolveChatPromptReferenceText(
	reference: vscode.ChatPromptReference
): Promise<{ label?: string; content?: string } | undefined> {
	const value = reference.value;
	const isImageUri = (uri: vscode.Uri): boolean => /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)$/i.test(uri.path);

	if (typeof value === "string") {
		return { label: reference.id, content: value };
	}

	if (value instanceof vscode.Location) {
		const label = `${formatUriForPrompt(value.uri)}:${value.range.start.line + 1}-${value.range.end.line + 1}`;
		if (isImageUri(value.uri)) {
			return {
				label,
				content:
					reference.modelDescription?.trim() ||
					"Image attachment reference. Binary image content is not inlined as text.",
			};
		}
		try {
			return {
				label,
				content: (await vscode.workspace.openTextDocument(value.uri)).getText(value.range),
			};
		} catch {
			return { label, content: reference.modelDescription };
		}
	}

	if (value instanceof vscode.Uri) {
		const label = formatUriForPrompt(value);
		if (isImageUri(value)) {
			return {
				label,
				content:
					reference.modelDescription?.trim() ||
					"Image attachment reference. Binary image content is not inlined as text.",
			};
		}
		try {
			return { label, content: (await vscode.workspace.openTextDocument(value)).getText() };
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

function normalizeModelKey(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[:/_.\s]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function hasVersionToken(normalizedModelId: string, major: number, minor: number): boolean {
	return (
		normalizedModelId.includes(`${major}-${minor}`) ||
		normalizedModelId.includes(`${major}${minor}`) ||
		normalizedModelId.includes(`v${major}-${minor}`)
	);
}

function buildFallbackModelOptionMatchKeys(modelId: string): string[] {
	const unique = new Set<string>();
	const push = (candidate: string | undefined) => {
		if (!candidate) {
			return;
		}
		const normalized = normalizeModelKey(candidate);
		if (normalized) {
			unique.add(normalized);
		}
	};

	push(modelId);
	const baseModelId = modelId.split(":")[0];
	push(baseModelId);

	const normalizedBase = normalizeModelKey(baseModelId);
	if (!normalizedBase) {
		return Array.from(unique);
	}

	if (normalizedBase.includes("claude") && normalizedBase.includes("haiku") && hasVersionToken(normalizedBase, 4, 5)) {
		push("claude-code-haiku-4-5");
		push("claude-haiku-4-5");
	}

	if (normalizedBase.includes("claude") && normalizedBase.includes("sonnet") && hasVersionToken(normalizedBase, 4, 6)) {
		push("claude-code-sonnet-4-6");
		push("claude-sonnet-4-6");
	}

	if (normalizedBase.includes("claude") && normalizedBase.includes("opus") && hasVersionToken(normalizedBase, 4, 6)) {
		push("claude-code-opus-4-6");
		push("claude-opus-4-6");
	}

	return Array.from(unique);
}

/**
 * Resolve fallback chat model-specific options using robust matching against model aliases.
 *
 * Workaround: fallback chat model IDs often include router/provider suffixes such as
 * `:cheapest`, `:fastest`, or `:provider-name`. This resolver strips those suffixes and
 * also exposes Claude-friendly aliases so one setting key can match multiple LiteLLM IDs.
 */
export function resolveFallbackModelOptions(
	modelId: string,
	configuredOptions: Record<string, Record<string, unknown>>
): { options?: Record<string, unknown>; matchedKey?: string } {
	if (!modelId || !configuredOptions || typeof configuredOptions !== "object") {
		return {};
	}

	const matchKeys = buildFallbackModelOptionMatchKeys(modelId);
	let bestMatch: { key: string; value: Record<string, unknown>; normalizedKeyLength: number } | undefined;

	for (const [key, value] of Object.entries(configuredOptions)) {
		if (!value || typeof value !== "object") {
			continue;
		}
		const normalizedKey = normalizeModelKey(key);
		if (!normalizedKey) {
			continue;
		}

		const isMatch = matchKeys.some((candidate) => candidate === normalizedKey || candidate.startsWith(normalizedKey));
		if (!isMatch) {
			continue;
		}

		if (!bestMatch || normalizedKey.length > bestMatch.normalizedKeyLength) {
			bestMatch = {
				key,
				value: { ...value },
				normalizedKeyLength: normalizedKey.length,
			};
		}
	}

	if (!bestMatch) {
		return {};
	}

	return {
		options: bestMatch.value,
		matchedKey: bestMatch.key,
	};
}

/**
 * A code block suggestion extracted from model output.
 */
export interface CodeBlockSuggestion {
	id: string;
	language: string;
	code: string;
	path?: string; // Optional file path inferred from fence info or inline comments
	description?: string; // Optional description of what the code does
}

export interface StructuredEditSuggestion {
	id: string;
	path: string;
	intent: "create" | "replace";
	content?: string;
	patch?: string;
	language?: string;
	description?: string;
}

function normalizeSuggestedPath(rawPath: string | undefined): string | undefined {
	if (!rawPath) {
		return undefined;
	}

	let candidate = rawPath.trim();
	if (!candidate) {
		return undefined;
	}

	// Strip surrounding punctuation often emitted in markdown prose.
	candidate = candidate.replace(/^[`"'(<[]+/, "").replace(/[)`"'>\].,;:!?]+$/, "");
	candidate = candidate.replace(/\\/g, "/");

	if (!candidate || candidate.startsWith("http://") || candidate.startsWith("https://")) {
		return undefined;
	}

	if (/^[a-zA-Z]:\//.test(candidate) || candidate.startsWith("/")) {
		return candidate;
	}

	if (candidate.startsWith("./")) {
		candidate = candidate.slice(2);
	}

	if (candidate.includes(" ") || candidate.includes("..")) {
		return undefined;
	}

	if (!candidate.includes("/")) {
		return undefined;
	}

	return candidate;
}

function parseFenceInfo(info: string): { language: string; path?: string } {
	const trimmed = info.trim();
	if (!trimmed) {
		return { language: "text" };
	}

	let language = "text";
	let path: string | undefined;

	const explicitPathMatch = trimmed.match(/(?:file(?:name|path)?|path)\s*[:=]\s*["']?([^"'\s]+)["']?/i);
	if (explicitPathMatch) {
		path = normalizeSuggestedPath(explicitPathMatch[1]);
	}

	const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length > 0) {
		const first = tokens[0];
		if (!first.includes("=") && !first.includes(":")) {
			language = first.toLowerCase();
		}

		if (!path) {
			for (const token of tokens.slice(1)) {
				const normalized = normalizeSuggestedPath(token);
				if (normalized && /\.[a-z0-9]+$/i.test(normalized)) {
					path = normalized;
					break;
				}
			}
		}
	}

	return { language, path };
}

function isStructuredEditLanguage(language: string): boolean {
	const normalized = language.trim().toLowerCase();
	return normalized === "litellm-edit" || normalized === "litellm-edits" || normalized === "structured-edit";
}

function tryParseStructuredEditEnvelope(raw: string): StructuredEditSuggestion[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}

	const normalizeEdit = (value: unknown, index: number): StructuredEditSuggestion | undefined => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return undefined;
		}

		const record = value as Record<string, unknown>;
		const path = normalizeSuggestedPath(typeof record.path === "string" ? record.path : undefined);
		if (!path) {
			return undefined;
		}

		const rawIntent = typeof record.intent === "string" ? record.intent.toLowerCase() : undefined;
		const intent: "create" | "replace" = rawIntent === "create" ? "create" : "replace";
		const content = typeof record.content === "string" ? record.content : undefined;
		const patch = typeof record.patch === "string" ? record.patch : undefined;
		if (!content && !patch) {
			return undefined;
		}

		return {
			id: `structured-edit-${index}`,
			path,
			intent,
			content,
			patch,
			language: typeof record.language === "string" ? record.language : undefined,
			description: typeof record.description === "string" ? record.description : undefined,
		};
	};

	if (Array.isArray(parsed)) {
		return parsed.map(normalizeEdit).filter((edit): edit is StructuredEditSuggestion => Boolean(edit));
	}

	if (!parsed || typeof parsed !== "object") {
		return [];
	}

	const record = parsed as Record<string, unknown>;
	if (Array.isArray(record.edits)) {
		return record.edits.map(normalizeEdit).filter((edit): edit is StructuredEditSuggestion => Boolean(edit));
	}

	const single = normalizeEdit(record, 0);
	return single ? [single] : [];
}

function inferPathFromCode(code: string): string | undefined {
	const firstLine = code.split(/\r?\n/, 1)[0]?.trim();
	if (!firstLine) {
		return undefined;
	}

	const commentPathMatch = firstLine.match(
		/^(?:\/\/|#|--|\/\*+\s*|<!--\s*)\s*(?:file|path)?\s*[:=]\s*([^\s*]+)(?:\s*\*\/|\s*-->)?$/i
	);
	if (!commentPathMatch) {
		return undefined;
	}

	return normalizeSuggestedPath(commentPathMatch[1]);
}

function guessUntitledExtension(language?: string): string {
	const normalized = (language ?? "").trim().toLowerCase();
	const extensionByLanguage: Record<string, string> = {
		typescript: ".ts",
		ts: ".ts",
		javascript: ".js",
		js: ".js",
		jsx: ".jsx",
		tsx: ".tsx",
		python: ".py",
		py: ".py",
		json: ".json",
		markdown: ".md",
		md: ".md",
		go: ".go",
		rust: ".rs",
		java: ".java",
		c: ".c",
		cpp: ".cpp",
		csharp: ".cs",
		cs: ".cs",
		shell: ".sh",
		bash: ".sh",
		yaml: ".yml",
		yml: ".yml",
	};

	return extensionByLanguage[normalized] ?? ".txt";
}

/**
 * Extract code blocks from markdown text that may contain code suggestions.
 * @param text Markdown text potentially containing code blocks.
 * @returns Array of extracted code blocks.
 */
export function extractCodeBlocks(text: string): CodeBlockSuggestion[] {
	const blocks: CodeBlockSuggestion[] = [];
	const codeBlockRegex = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;

	let match;
	let blockIndex = 0;
	while ((match = codeBlockRegex.exec(text)) !== null) {
		const { language, path: fencePath } = parseFenceInfo(match[1] ?? "");
		if (isStructuredEditLanguage(language)) {
			continue;
		}
		const code = (match[2] ?? "").trim();

		if (code.length > 0) {
			const inlinePath = inferPathFromCode(code);
			blocks.push({
				id: `code-block-${blockIndex}`,
				language,
				code,
				path: fencePath ?? inlinePath,
			});
			blockIndex++;
		}
	}

	return blocks;
}

/**
 * Extract structured edit suggestions from markdown text.
 *
 * Supported format:
 * ```litellm-edit
 * {"path":"src/file.ts","intent":"replace","language":"ts","content":"..."}
 * ```
 *
 * Or:
 * ```litellm-edit
 * {"edits":[...]}
 * ```
 */
export function extractStructuredEdits(text: string): StructuredEditSuggestion[] {
	const edits: StructuredEditSuggestion[] = [];
	const codeBlockRegex = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;

	let match;
	let editIndex = 0;
	while ((match = codeBlockRegex.exec(text)) !== null) {
		const { language } = parseFenceInfo(match[1] ?? "");
		if (!isStructuredEditLanguage(language)) {
			continue;
		}

		const extracted = tryParseStructuredEditEnvelope((match[2] ?? "").trim());
		for (const edit of extracted) {
			edits.push({
				...edit,
				id: `${edit.id}-${editIndex}`,
			});
			editIndex++;
		}
	}

	return edits;
}

/**
 * Apply a code block to a file in the workspace, replacing the entire content or a specific range.
 * @param code The code to apply.
 * @param filePath Optional file path. If provided, creates/replaces the file. If not, opens an untitled editor.
 * @param range Optional range to replace instead of entire content.
 * @returns The URI of the editor where code was applied.
 */
export async function applyCodeEdit(
	code: string,
	filePath?: string,
	range?: vscode.Range,
	language?: string
): Promise<vscode.Uri> {
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
		const suffix = Date.now().toString(36);
		const ext = guessUntitledExtension(language);
		uri = vscode.Uri.parse(`untitled:litellm-suggested-edit-${suffix}${ext}`);
	}

	const edit = new vscode.WorkspaceEdit();

	if (range) {
		// Replace specific range
		edit.replace(uri, range, code);
	} else {
		// Replace all content
		const fileExists =
			uri.scheme === "untitled"
				? true
				: await vscode.workspace.fs.stat(uri).then(
						() => true,
						() => false
					);

		if (fileExists) {
			const document = await vscode.workspace.openTextDocument(uri);
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

/**
 * Apply a structured edit suggestion while honoring its declared intent.
 */
export async function applyStructuredEdit(edit: StructuredEditSuggestion): Promise<vscode.Uri> {
	if (!edit.content) {
		if (edit.patch) {
			throw new Error("Patch-only structured edits are not applied automatically yet.");
		}
		throw new Error("Structured edit is missing content.");
	}

	const isAbsolute = edit.path.startsWith("/") || /^[a-zA-Z]:/.test(edit.path);
	const uri =
		!isAbsolute && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
			? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, edit.path)
			: vscode.Uri.file(edit.path);

	const exists = await vscode.workspace.fs.stat(uri).then(
		() => true,
		() => false
	);

	if (edit.intent === "create" && exists) {
		throw new Error(`Structured edit expected to create '${edit.path}', but the file already exists.`);
	}

	if (edit.intent === "replace" && !exists) {
		throw new Error(`Structured edit expected to replace '${edit.path}', but the file does not exist.`);
	}

	return applyCodeEdit(edit.content, edit.path, undefined, edit.language);
}

// Tool execution handlers for fallback tool calling

export interface FallbackToolResultMeta {
	tool: string;
	exitCode?: number;
	truncated?: boolean;
	originalLength?: number;
	// read_file / write_file
	lineCount?: number;
	filePath?: string;
	// commands / git
	stderr?: string;
	// run_tests
	passed?: number;
	failed?: number;
	skipped?: number;
}

export interface FallbackToolExecutionResult {
	success: boolean;
	output: string;
	error?: string;
	meta?: FallbackToolResultMeta;
}

/**
 * Format a tool execution result as a human/model-readable block.
 * Includes exit code, separate stderr section, truncation notice, and test counts.
 */
export function formatToolResult(result: FallbackToolExecutionResult): string {
	const { meta } = result;
	const lines: string[] = [];

	if (meta) {
		const exitPart = meta.exitCode !== undefined ? ` (exit code: ${meta.exitCode})` : "";
		if (meta.filePath) {
			const linePart = meta.lineCount !== undefined ? `, ${meta.lineCount} lines` : "";
			lines.push(`[${meta.tool}] ${meta.filePath}${linePart}`);
		} else {
			lines.push(`[${meta.tool}]${exitPart}`);
		}
		if (meta.passed !== undefined || meta.failed !== undefined) {
			const counts = [
				meta.passed !== undefined ? `${meta.passed} passed` : null,
				meta.failed !== undefined ? `${meta.failed} failed` : null,
				meta.skipped !== undefined && meta.skipped > 0 ? `${meta.skipped} skipped` : null,
			]
				.filter(Boolean)
				.join(", ");
			if (counts) {
				lines.push(counts);
			}
		}
	}

	if (result.error) {
		lines.push(`Error: ${result.error}`);
	} else {
		if (meta?.stderr) {
			lines.push("stderr:");
			lines.push(meta.stderr);
			if (result.output) {
				lines.push("stdout:");
			}
		}
		if (result.output) {
			lines.push(result.output);
		}
		if (meta?.truncated) {
			lines.push(`\n[Output truncated: showing ${result.output.length} of ${meta.originalLength} chars]`);
		}
	}

	return lines.join("\n");
}

/** Truncate tool output to a maximum character count. */
function truncateToolOutput(
	text: string,
	maxChars: number,
	kepEnd = false
): { text: string; truncated: boolean; originalLength: number } {
	const originalLength = text.length;
	if (originalLength <= maxChars) {
		return { text, truncated: false, originalLength };
	}
	if (kepEnd) {
		return {
			text: `...[${originalLength - maxChars} chars omitted]...\n${text.slice(-maxChars)}`,
			truncated: true,
			originalLength,
		};
	}
	return {
		text: `${text.slice(0, maxChars)}\n...[${originalLength - maxChars} chars omitted]`,
		truncated: true,
		originalLength,
	};
}

/** Normalize VS Code filesystem errors into clean one-line messages. */
function normalizeVSCodeFsError(error: unknown, filePath: string): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	const msg = error.message;
	if (/ENOENT|FileNotFound|file not found/i.test(msg)) {
		return `File not found: ${filePath}`;
	}
	if (/EACCES|EPERM|NoPermissions|permission denied/i.test(msg)) {
		return `Permission denied: ${filePath}`;
	}
	if (/EISDIR|is a directory/i.test(msg)) {
		return `Path is a directory, not a file: ${filePath}`;
	}
	if (/EEXIST|FileExists|file already exists/i.test(msg)) {
		return `File already exists: ${filePath}`;
	}
	return msg;
}

/** Extract pass/fail/skipped counts from common test runner output formats. */
function extractTestCounts(output: string): { passed?: number; failed?: number; skipped?: number } {
	// Jest: "Tests: 5 passed, 2 failed, 7 total" (various orderings)
	const jestTests = output.match(/Tests:\s+([\d\s\w,]+)/i);
	if (jestTests) {
		const passed = jestTests[1].match(/(\d+)\s+passed/i);
		const failed = jestTests[1].match(/(\d+)\s+failed/i);
		const skipped = jestTests[1].match(/(\d+)\s+skipped/i);
		if (passed || failed) {
			return {
				passed: passed ? parseInt(passed[1]) : undefined,
				failed: failed ? parseInt(failed[1]) : undefined,
				skipped: skipped ? parseInt(skipped[1]) : undefined,
			};
		}
	}
	// Mocha / tap-spec: "5 passing" / "2 failing"
	const mochaPassed = output.match(/(\d+)\s+passing/);
	const mochaFailed = output.match(/(\d+)\s+failing/);
	if (mochaPassed || mochaFailed) {
		return {
			passed: mochaPassed ? parseInt(mochaPassed[1]) : undefined,
			failed: mochaFailed ? parseInt(mochaFailed[1]) : undefined,
		};
	}
	// Generic fallback (e.g. Python unittest): "X passed" / "X failed"
	const genericPassed = output.match(/(\d+)\s+(?:tests?\s+)?passed/i);
	const genericFailed = output.match(/(\d+)\s+(?:tests?\s+)?failed/i);
	if (genericPassed || genericFailed) {
		return {
			passed: genericPassed ? parseInt(genericPassed[1]) : undefined,
			failed: genericFailed ? parseInt(genericFailed[1]) : undefined,
		};
	}
	return {};
}

/**
 * Execute a tool call with the given name and arguments.
 * @param toolName The name of the tool to execute.
 * @param toolArgs The arguments for the tool.
 */
export async function executeFallbackTool(
	toolName: string,
	toolArgs: Record<string, unknown>
): Promise<FallbackToolExecutionResult> {
	try {
		switch (toolName) {
			case "list_dir":
				return await executeFallbackListDir(toolArgs);
			case "read_file":
				return await executeFallbackReadFile(toolArgs);
			case "read_range":
				return await executeFallbackReadRange(toolArgs);
			case "search_files":
				return await executeFallbackSearchFiles(toolArgs);
			case "grep_workspace":
				return await executeFallbackGrepWorkspace(toolArgs);
			case "diagnostics":
				return await executeFallbackDiagnostics(toolArgs);
			case "symbol_lookup":
				return await executeFallbackSymbolLookup(toolArgs);
			case "symbol_references":
				return await executeFallbackSymbolReferences(toolArgs);
			case "apply_patch":
				return await executeFallbackApplyPatch(toolArgs);
			case "write_file":
				return await executeFallbackWriteFile(toolArgs);
			case "execute_command":
				return await executeFallbackExecuteCommand(toolArgs);
			case "git_command":
				return await executeFallbackGitCommand(toolArgs);
			case "run_tests":
				return await executeFallbackRunTests(toolArgs);
			default:
				return { success: false, output: "", error: `Unknown tool: ${toolName}`, meta: { tool: toolName } };
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return { success: false, output: "", error: errorMsg, meta: { tool: toolName } };
	}
}

function resolveWorkspaceUri(filePath: string): vscode.Uri {
	const normalizePath = (value: string): string => value.replace(/\\/g, "/").toLowerCase();
	const mapToWorkspacePath = (inputPath: string): string | undefined => {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		if (!workspaceRoot) {
			return undefined;
		}

		const normalizedInput = normalizePath(inputPath);
		const normalizedRoot = normalizePath(workspaceRoot);
		if (normalizedInput === normalizedRoot) {
			return workspaceRoot;
		}
		if (normalizedInput.startsWith(`${normalizedRoot}/`)) {
			const rawSuffix = inputPath.replace(/\\/g, "/").slice(normalizedRoot.length + 1);
			const suffixParts = rawSuffix.split("/").filter((part) => part.length > 0);
			return suffixParts.length > 0 ? path.join(workspaceRoot, ...suffixParts) : workspaceRoot;
		}

		const rootParts = normalizedRoot.split("/").filter((part) => part.length > 0);
		const rootName = rootParts[rootParts.length - 1];
		if (!rootName) {
			return undefined;
		}

		const marker = `/${rootName}/`;
		const markerIndex = normalizedInput.indexOf(marker);
		if (markerIndex >= 0) {
			const rawSuffix = inputPath.replace(/\\/g, "/").slice(markerIndex + marker.length);
			const suffixParts = rawSuffix.split("/").filter((part) => part.length > 0);
			return suffixParts.length > 0 ? path.join(workspaceRoot, ...suffixParts) : workspaceRoot;
		}

		if (normalizedInput.endsWith(`/${rootName}`)) {
			return workspaceRoot;
		}

		return undefined;
	};

	const isAbsolute = filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath);
	if (!isAbsolute) {
		if (vscode.workspace.workspaceFolders?.length) {
			return vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, filePath);
		}
		return vscode.Uri.file(path.resolve(process.cwd(), filePath));
	}

	const mapped = mapToWorkspacePath(filePath);
	return vscode.Uri.file(mapped ?? filePath);
}

function workspaceRelativePath(uri: vscode.Uri): string {
	return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
}

function flattenDocumentSymbols(
	symbols: readonly vscode.DocumentSymbol[] | readonly vscode.SymbolInformation[]
): Array<{ name: string; kind: string; line: number; character: number; container?: string }> {
	const out: Array<{ name: string; kind: string; line: number; character: number; container?: string }> = [];

	const visitDocumentSymbol = (symbol: vscode.DocumentSymbol, container?: string) => {
		out.push({
			name: symbol.name,
			kind: vscode.SymbolKind[symbol.kind] ?? "Unknown",
			line: symbol.range.start.line + 1,
			character: symbol.range.start.character + 1,
			container,
		});
		for (const child of symbol.children) {
			visitDocumentSymbol(child, symbol.name);
		}
	};

	for (const symbol of symbols) {
		if (symbol instanceof vscode.DocumentSymbol) {
			visitDocumentSymbol(symbol);
		} else {
			out.push({
				name: symbol.name,
				kind: vscode.SymbolKind[symbol.kind] ?? "Unknown",
				line: symbol.location.range.start.line + 1,
				character: symbol.location.range.start.character + 1,
				container: symbol.containerName,
			});
		}
	}

	return out;
}

function escapeRegExp(source: string): string {
	return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function executeFallbackListDir(args: Record<string, unknown>): Promise<FallbackToolExecutionResult> {
	const filePath = (args.path as string | undefined) ?? ".";
	try {
		const uri = resolveWorkspaceUri(filePath);
		const entries = await vscode.workspace.fs.readDirectory(uri);
		const lines = entries
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([name, type]) => `${name}${type === vscode.FileType.Directory ? "/" : ""}`);
		return {
			success: true,
			output: lines.join("\n") || "(empty directory)",
			meta: { tool: "list_dir", filePath },
		};
	} catch (error) {
		return {
			success: false,
			output: "",
			error: normalizeVSCodeFsError(error, filePath),
			meta: { tool: "list_dir", filePath },
		};
	}
}

async function executeFallbackReadRange(args: Record<string, unknown>): Promise<FallbackToolExecutionResult> {
	const filePath = args.path as string | undefined;
	const startLine = Math.max(1, Number(args.startLine ?? args.start_line ?? 1));
	const endLine = Math.max(startLine, Number(args.endLine ?? args.end_line ?? startLine));
	if (!filePath) {
		return { success: false, output: "", error: "Missing 'path' argument", meta: { tool: "read_range" } };
	}

	try {
		const uri = resolveWorkspaceUri(filePath);
		const content = await vscode.workspace.fs.readFile(uri);
		const text = new TextDecoder().decode(content);
		const lines = text.split(/\r?\n/);
		const slice = lines.slice(startLine - 1, endLine);
		const output = slice.map((line, idx) => `${startLine + idx}: ${line}`).join("\n");
		const { text: truncated, truncated: wasTruncated, originalLength } = truncateToolOutput(output, 8000);
		return {
			success: true,
			output: truncated,
			meta: {
				tool: "read_range",
				filePath,
				lineCount: slice.length,
				truncated: wasTruncated,
				originalLength,
			},
		};
	} catch (error) {
		return {
			success: false,
			output: "",
			error: normalizeVSCodeFsError(error, filePath),
			meta: { tool: "read_range", filePath },
		};
	}
}

async function executeFallbackSearchFiles(args: Record<string, unknown>): Promise<FallbackToolExecutionResult> {
	const pattern = (args.pattern as string | undefined) ?? (args.query as string | undefined) ?? "**/*";
	const maxResults = Math.min(500, Math.max(1, Number(args.maxResults ?? args.max_results ?? 100)));

	try {
		const uris = await vscode.workspace.findFiles(pattern, undefined, maxResults);
		return {
			success: true,
			output: uris.map((uri) => workspaceRelativePath(uri)).join("\n") || "(no matches)",
			meta: { tool: "search_files", lineCount: uris.length },
		};
	} catch (error) {
		return {
			success: false,
			output: "",
			error: error instanceof Error ? error.message : String(error),
			meta: { tool: "search_files" },
		};
	}
}

async function executeFallbackGrepWorkspace(args: Record<string, unknown>): Promise<FallbackToolExecutionResult> {
	const query = args.query as string | undefined;
	const includePattern = args.includePattern as string | undefined;
	const isRegexp = args.isRegexp === true;
	const maxResults = Math.min(500, Math.max(1, Number(args.maxResults ?? args.max_results ?? 100)));

	if (!query) {
		return { success: false, output: "", error: "Missing 'query' argument", meta: { tool: "grep_workspace" } };
	}

	const rgPath = process.platform === "win32" ? "rg.exe" : "rg";
	const rgArgs: string[] = ["--line-number", "--no-heading", "--color", "never", "--max-count", String(maxResults)];
	if (!isRegexp) {
		rgArgs.push("--fixed-strings");
	}
	if (includePattern) {
		rgArgs.push("-g", includePattern);
	}
	rgArgs.push(query, ".");

	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!cwd) {
		return { success: false, output: "", error: "No workspace folder is open", meta: { tool: "grep_workspace" } };
	}

	const proc = spawnSync(rgPath, rgArgs, { cwd, encoding: "utf-8", shell: false, maxBuffer: 10 * 1024 * 1024 });
	if (proc.error) {
		return {
			success: false,
			output: "",
			error: `Failed to run rg: ${proc.error.message}`,
			meta: { tool: "grep_workspace", exitCode: -1 },
		};
	}

	const exitCode = proc.status ?? -1;
	const stdout = typeof proc.stdout === "string" ? proc.stdout : "";
	const stderr = typeof proc.stderr === "string" ? proc.stderr : "";
	if (exitCode !== 0 && exitCode !== 1) {
		return {
			success: false,
			output: "",
			error: stderr.trim() || `rg failed with exit code ${exitCode}`,
			meta: { tool: "grep_workspace", exitCode, stderr: stderr.trim() || undefined },
		};
	}

	const { text: truncated, truncated: wasTruncated, originalLength } = truncateToolOutput(stdout, 10000);
	return {
		success: true,
		output: truncated || "(no matches)",
		meta: {
			tool: "grep_workspace",
			exitCode,
			truncated: wasTruncated,
			originalLength,
			stderr: stderr.trim() || undefined,
		},
	};
}

async function executeFallbackDiagnostics(args: Record<string, unknown>): Promise<FallbackToolExecutionResult> {
	const filePath = args.path as string | undefined;
	const severityFilter = typeof args.severity === "string" ? args.severity.toLowerCase() : undefined;
	const uri = filePath ? resolveWorkspaceUri(filePath) : undefined;
	const entries = uri ? [[uri, vscode.languages.getDiagnostics(uri)] as const] : vscode.languages.getDiagnostics();

	const lines: string[] = [];
	for (const [entryUri, diagnostics] of entries) {
		for (const d of diagnostics) {
			const severityName = vscode.DiagnosticSeverity[d.severity]?.toLowerCase() ?? "unknown";
			if (severityFilter && severityFilter !== severityName) {
				continue;
			}
			lines.push(
				`${workspaceRelativePath(entryUri)}:${d.range.start.line + 1}:${d.range.start.character + 1} [${severityName}] ${d.message}`
			);
		}
	}

	const output = lines.join("\n") || "(no diagnostics)";
	const { text: truncated, truncated: wasTruncated, originalLength } = truncateToolOutput(output, 12000);
	return {
		success: true,
		output: truncated,
		meta: { tool: "diagnostics", lineCount: lines.length, truncated: wasTruncated, originalLength, filePath },
	};
}

async function executeFallbackSymbolLookup(args: Record<string, unknown>): Promise<FallbackToolExecutionResult> {
	const filePath = args.path as string | undefined;
	const symbolQuery = typeof args.symbol === "string" ? args.symbol.toLowerCase() : undefined;
	if (!filePath) {
		return { success: false, output: "", error: "Missing 'path' argument", meta: { tool: "symbol_lookup" } };
	}

	try {
		const uri = resolveWorkspaceUri(filePath);
		const symbols =
			(await vscode.commands.executeCommand<readonly vscode.DocumentSymbol[] | readonly vscode.SymbolInformation[]>(
				"vscode.executeDocumentSymbolProvider",
				uri
			)) ?? [];
		const flat = flattenDocumentSymbols(symbols).filter((symbol) =>
			symbolQuery ? symbol.name.toLowerCase().includes(symbolQuery) : true
		);
		const lines = flat.map(
			(symbol) =>
				`${symbol.name} (${symbol.kind}) @ ${symbol.line}:${symbol.character}${symbol.container ? ` in ${symbol.container}` : ""}`
		);
		return {
			success: true,
			output: lines.join("\n") || "(no symbols)",
			meta: { tool: "symbol_lookup", filePath, lineCount: lines.length },
		};
	} catch (error) {
		return {
			success: false,
			output: "",
			error: error instanceof Error ? error.message : String(error),
			meta: { tool: "symbol_lookup", filePath },
		};
	}
}

async function executeFallbackSymbolReferences(args: Record<string, unknown>): Promise<FallbackToolExecutionResult> {
	const filePath = args.path as string | undefined;
	const symbol = args.symbol as string | undefined;
	if (!filePath) {
		return { success: false, output: "", error: "Missing 'path' argument", meta: { tool: "symbol_references" } };
	}

	try {
		const uri = resolveWorkspaceUri(filePath);
		const doc = await vscode.workspace.openTextDocument(uri);

		let position: vscode.Position;
		if (typeof args.line === "number") {
			const line = Math.max(1, Number(args.line)) - 1;
			const character = Math.max(1, Number(args.character ?? 1)) - 1;
			position = new vscode.Position(line, character);
		} else if (symbol) {
			const text = doc.getText();
			const regex = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
			const match = regex.exec(text);
			if (!match || match.index === undefined) {
				return {
					success: false,
					output: "",
					error: `Symbol not found in file: ${symbol}`,
					meta: { tool: "symbol_references", filePath },
				};
			}
			position = doc.positionAt(match.index);
		} else {
			return {
				success: false,
				output: "",
				error: "Provide either line/character or symbol",
				meta: { tool: "symbol_references", filePath },
			};
		}

		const refs =
			(await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", uri, position)) ?? [];
		const lines = refs.map(
			(ref) => `${workspaceRelativePath(ref.uri)}:${ref.range.start.line + 1}:${ref.range.start.character + 1}`
		);
		return {
			success: true,
			output: lines.join("\n") || "(no references)",
			meta: { tool: "symbol_references", filePath, lineCount: lines.length },
		};
	} catch (error) {
		return {
			success: false,
			output: "",
			error: error instanceof Error ? error.message : String(error),
			meta: { tool: "symbol_references", filePath },
		};
	}
}

async function executeFallbackApplyPatch(args: Record<string, unknown>): Promise<FallbackToolExecutionResult> {
	const patch = args.patch as string | undefined;
	const cwd = (args.cwd as string | undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!patch) {
		return { success: false, output: "", error: "Missing 'patch' argument", meta: { tool: "apply_patch" } };
	}
	if (!cwd) {
		return { success: false, output: "", error: "No workspace folder is open", meta: { tool: "apply_patch" } };
	}

	const proc = spawnSync("git", ["apply", "--whitespace=nowarn", "--recount", "-"], {
		cwd,
		input: patch,
		encoding: "utf-8",
		shell: false,
		maxBuffer: 10 * 1024 * 1024,
	});

	if (proc.error) {
		return {
			success: false,
			output: "",
			error: `Failed to run git apply: ${proc.error.message}`,
			meta: { tool: "apply_patch", exitCode: -1 },
		};
	}

	const exitCode = proc.status ?? -1;
	const stdout = typeof proc.stdout === "string" ? proc.stdout.trim() : "";
	const stderr = typeof proc.stderr === "string" ? proc.stderr.trim() : "";
	return {
		success: exitCode === 0,
		output: stdout || (exitCode === 0 ? "Patch applied successfully." : ""),
		error: exitCode === 0 ? undefined : stderr || `git apply failed (exit code: ${exitCode})`,
		meta: { tool: "apply_patch", exitCode, stderr: stderr || undefined },
	};
}

async function executeFallbackReadFile(args: Record<string, unknown>): Promise<FallbackToolExecutionResult> {
	const filePath = args.path as string | undefined;
	if (!filePath) {
		return { success: false, output: "", error: "Missing 'path' argument", meta: { tool: "read_file" } };
	}

	try {
		const isAbsolute = filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath);
		const uri =
			!isAbsolute && vscode.workspace.workspaceFolders?.length
				? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, filePath)
				: vscode.Uri.file(filePath);
		const content = await vscode.workspace.fs.readFile(uri);
		const text = new TextDecoder().decode(content);
		const lineCount = text.split(/\r?\n/).length;
		const { text: truncated, truncated: wasTruncated, originalLength } = truncateToolOutput(text, 8000);
		return {
			success: true,
			output: truncated,
			meta: { tool: "read_file", filePath, lineCount, truncated: wasTruncated, originalLength },
		};
	} catch (error) {
		return {
			success: false,
			output: "",
			error: normalizeVSCodeFsError(error, filePath),
			meta: { tool: "read_file", filePath },
		};
	}
}

async function executeFallbackWriteFile(args: Record<string, unknown>): Promise<FallbackToolExecutionResult> {
	const filePath = args.path as string | undefined;
	const content = args.content as string | undefined;
	if (!filePath || content === undefined) {
		return { success: false, output: "", error: "Missing 'path' or 'content' argument", meta: { tool: "write_file" } };
	}

	try {
		const isAbsolute = filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath);
		const uri =
			!isAbsolute && vscode.workspace.workspaceFolders?.length
				? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, filePath)
				: vscode.Uri.file(filePath);
		const encoded = new TextEncoder().encode(content);
		await vscode.workspace.fs.writeFile(uri, encoded);
		return {
			success: true,
			output: `Wrote ${content.length} chars to ${filePath}`,
			meta: { tool: "write_file", filePath },
		};
	} catch (error) {
		return {
			success: false,
			output: "",
			error: normalizeVSCodeFsError(error, filePath),
			meta: { tool: "write_file", filePath },
		};
	}
}

async function executeFallbackExecuteCommand(args: Record<string, unknown>): Promise<FallbackToolExecutionResult> {
	const command = args.command as string | undefined;
	const cwd = (args.cwd as string | undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!command) {
		return { success: false, output: "", error: "Missing 'command' argument", meta: { tool: "execute_command" } };
	}

	const proc = spawnSync(command, { shell: true, cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
	const exitCode = proc.status ?? -1;
	const rawStdout = typeof proc.stdout === "string" ? proc.stdout : "";
	const rawStderr = typeof proc.stderr === "string" ? proc.stderr : "";

	if (proc.error) {
		return {
			success: false,
			output: "",
			error: `Failed to spawn command: ${proc.error.message}`,
			meta: { tool: "execute_command", exitCode: -1 },
		};
	}

	const { text: stdout, truncated: stdoutTruncated, originalLength } = truncateToolOutput(rawStdout, 8000);
	const { text: stderr } = truncateToolOutput(rawStderr, 1500, true);
	const success = exitCode === 0;

	return {
		success,
		output: stdout,
		error: success ? undefined : stderr.trim() || `Command failed (exit code: ${exitCode})`,
		meta: {
			tool: "execute_command",
			exitCode,
			truncated: stdoutTruncated,
			originalLength,
			stderr: stderr.trim() || undefined,
		},
	};
}

async function executeFallbackGitCommand(args: Record<string, unknown>): Promise<FallbackToolExecutionResult> {
	const action = args.action as string | undefined;
	const repoPath = (args.repo_path as string | undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

	if (!action || !repoPath) {
		return {
			success: false,
			output: "",
			error: "Missing 'action' or 'repo_path' argument",
			meta: { tool: "git_command" },
		};
	}

	let gitCommand: string;
	switch (action) {
		case "status":
			gitCommand = "git status";
			break;
		case "log":
			gitCommand = "git log --oneline -10";
			break;
		case "diff":
			gitCommand = "git diff";
			break;
		case "branch":
			gitCommand = "git branch -a";
			break;
		case "checkout": {
			const branch = args.branch as string | undefined;
			if (!branch) {
				return {
					success: false,
					output: "",
					error: "Missing 'branch' for checkout action",
					meta: { tool: "git_command" },
				};
			}
			// Sanitize branch name to prevent shell injection
			gitCommand = `git checkout ${branch.replace(/[^a-zA-Z0-9_.\-/]/g, "")}`;
			break;
		}
		case "commit": {
			const message = args.message as string | undefined;
			if (!message) {
				return {
					success: false,
					output: "",
					error: "Missing 'message' for commit action",
					meta: { tool: "git_command" },
				};
			}
			gitCommand = `git commit -m "${message.replace(/"/g, '\\"')}"`;
			break;
		}
		case "push":
			gitCommand = "git push";
			break;
		case "pull":
			gitCommand = "git pull";
			break;
		default:
			return { success: false, output: "", error: `Unknown git action: ${action}`, meta: { tool: "git_command" } };
	}

	const proc = spawnSync(gitCommand, { shell: true, cwd: repoPath, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
	const exitCode = proc.status ?? -1;
	const rawStdout = typeof proc.stdout === "string" ? proc.stdout : "";
	const rawStderr = typeof proc.stderr === "string" ? proc.stderr : "";

	if (proc.error) {
		return {
			success: false,
			output: "",
			error: `Failed to run git: ${proc.error.message}`,
			meta: { tool: "git_command", exitCode: -1 },
		};
	}

	// git uses stderr for informational messages too, so combine both streams
	const combinedRaw = rawStdout + (rawStdout && rawStderr ? "\n" + rawStderr : rawStderr);
	const { text: output, truncated, originalLength } = truncateToolOutput(combinedRaw, 5000);
	const { text: stderrTrunc } = truncateToolOutput(rawStderr, 1000, true);
	const success = exitCode === 0;

	return {
		success,
		output,
		error: success ? undefined : stderrTrunc.trim() || `git ${action} failed (exit code: ${exitCode})`,
		meta: { tool: "git_command", exitCode, truncated, originalLength, stderr: stderrTrunc.trim() || undefined },
	};
}

async function executeFallbackRunTests(args: Record<string, unknown>): Promise<FallbackToolExecutionResult> {
	const testPath = args.test_path as string | undefined;
	const framework = (args.framework as string | undefined) ?? "auto";
	const cwd = (args.cwd as string | undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

	if (!testPath || !cwd) {
		return {
			success: false,
			output: "",
			error: "Missing 'test_path' or workspace folder",
			meta: { tool: "run_tests" },
		};
	}

	let testCommand: string;
	if (framework === "auto") {
		const packageJsonPath = path.join(cwd, "package.json");
		let packageJson: Record<string, unknown> = {};
		if (fs.existsSync(packageJsonPath)) {
			try {
				packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
			} catch {
				/* ignore parse errors */
			}
		}
		testCommand = packageJson.vitest ? `npx vitest run ${testPath}` : `npm test -- ${testPath}`;
	} else if (framework === "jest") {
		testCommand = `npm test -- ${testPath}`;
	} else if (framework === "mocha") {
		testCommand = `npx mocha ${testPath}`;
	} else if (framework === "vitest") {
		testCommand = `npx vitest run ${testPath}`;
	} else {
		return { success: false, output: "", error: `Unknown test framework: ${framework}`, meta: { tool: "run_tests" } };
	}

	const proc = spawnSync(testCommand, { shell: true, cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
	const exitCode = proc.status ?? -1;
	const rawStdout = typeof proc.stdout === "string" ? proc.stdout : "";
	const rawStderr = typeof proc.stderr === "string" ? proc.stderr : "";
	const combined = rawStdout + (rawStdout && rawStderr ? "\n" + rawStderr : rawStderr);

	if (proc.error) {
		return {
			success: false,
			output: "",
			error: `Failed to run tests: ${proc.error.message}`,
			meta: { tool: "run_tests", exitCode: -1 },
		};
	}

	// Keep the tail of test output — summary lines appear at the end
	const { text: output, truncated, originalLength } = truncateToolOutput(combined, 8000, true);
	const counts = extractTestCounts(combined);
	const success = exitCode === 0;

	return {
		success,
		output,
		error: success ? undefined : `Tests failed (exit code: ${exitCode})`,
		meta: { tool: "run_tests", exitCode, truncated, originalLength, ...counts },
	};
}
