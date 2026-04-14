/**
 * Enhanced response streaming architecture for fallback chat.
 *
 * This module provides a sophisticated streaming abstraction that mirrors
 * vscode-copilot-chat's response pipeline, enabling:
 * - Response part abstraction (different content types)
 * - Decorator pattern for middleware processing
 * - Streaming pause/resume flow control
 * - Progressive rendering improvements
 *
 * Architecture:
 * User Input → Request Pipeline → Streaming HTTP Response
 *   ↓
 * Token Aggregation (text, tool calls, thinking)
 *   ↓
 * Response Part Emission (decorated parts)
 *   ↓
 * Code Block Processing (extract + decorate)
 *   ↓
 * Tool Invocation Handler (streaming partial args)
 *   ↓
 * Chat UI Display
 */

import * as vscode from "vscode";

// ============================================================================
// Response Part Types - Mirrors VS Code's Chat Response Parts
// ============================================================================

/**
 * Base type for all response parts that can be streamed to the chat UI.
 */
export type ChatResponsePart =
	| ChatResponseMarkdownPart
	| ChatResponseThinkingPart
	| ChatResponseCodeBlockPart
	| ChatResponseToolInvocationPart
	| ChatResponseToolResultPart
	| ChatResponseReferencePart
	| ChatResponseStatusPart
	| ChatResponseErrorPart
	| ChatResponseFileTreePart;

/**
 * Markdown text content (the most common response part).
 */
export interface ChatResponseMarkdownPart {
	type: "markdown";
	content: string;
	vulnerabilities?: ChatVulnerability[];
}

/**
 * Thinking/reasoning content (visible to user for transparency).
 */
export interface ChatResponseThinkingPart {
	type: "thinking";
	content: string;
	delta?: string; // Incremental thinking update
	thinkingId?: string; // For batching consecutive thinking updates
}

/**
 * Extracted code block with language and file context.
 */
export interface ChatResponseCodeBlockPart {
	type: "codeblock";
	code: string;
	language?: string;
	filename?: string; // Inferred from path if available
	filePath?: vscode.Uri; // Full file path for edit actions
	isEdit?: boolean; // Whether this block represents an edit
	markdownBeforeBlock?: string; // Context text before code in markdown
}

/**
 * Tool invocation announcement and streaming state.
 */
export interface ChatResponseToolInvocationPart {
	type: "tool-invocation";
	toolCallId: string;
	toolName: string;
	partialArguments?: Record<string, unknown>; // Streamed partial arguments
	isStreaming?: boolean;
	invocationMessage?: string; // Custom message to display
	toolCall?: ToolCallData;
}

/**
 * Tool execution result/output.
 */
export interface ChatResponseToolResultPart {
	type: "tool-result";
	toolCallId: string;
	toolName: string;
	success: boolean;
	output?: string;
	error?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Reference to a file, location, or external resource with status.
 */
export interface ChatResponseReferencePart {
	type: "reference";
	value: string | vscode.Uri | vscode.Location;
	title?: string;
	icon?: vscode.ThemeIcon | vscode.Uri;
	status?: {
		description: string;
		kind: "success" | "error" | "warning" | "empty";
	};
}

/**
 * Status update message (e.g., "Analyzing...", "Executing command...").
 */
export interface ChatResponseStatusPart {
	type: "status";
	message: string;
	kind: "info" | "success" | "warning" | "error";
}

/**
 * Error message with optional recovery action.
 */
export interface ChatResponseErrorPart {
	type: "error";
	message: string;
	code?: string;
	recoveryAction?: { title: string; command: string };
}

/**
 * File tree visualization for multi-file edits.
 * Mirrors vscode-copilot-chat's file tree rendering.
 */
export interface ChatResponseFileTreePart {
	type: "filetree";
	rootUri: vscode.Uri;
	entries: FileTreeEntry[];
	description?: string;
}

export interface FileTreeEntry {
	uri: vscode.Uri;
	type: "file" | "directory";
	children?: FileTreeEntry[];
	status?: "added" | "modified" | "deleted" | "conflict";
	description?: string;
}

/**
 * Security/vulnerability annotation on code.
 */
export interface ChatVulnerability {
	range: { start: number; end: number };
	severity: "low" | "medium" | "high" | "critical";
	rule: string;
	description: string;
	fix?: string;
}

/**
 * Internal tool call representation for tracking.
 */
export interface ToolCallData {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	argumentsRaw?: string; // Raw streamed JSON before parsing
	status: "pending" | "approved" | "executing" | "completed" | "failed";
	result?: ToolResultData;
	error?: string;
}

export interface ToolResultData {
	success: boolean;
	stdout?: string;
	stderr?: string;
	output?: string;
	exitCode?: number;
	metadata?: Record<string, unknown>;
}

// ============================================================================
// ChatResponseStream - Core Streaming Abstraction
// ============================================================================

/**
 * Abstract streaming interface for emitting response parts.
 *
 * Mirrors VS Code's ChatResponseStream API but tailored for LiteLLM.
 * Supports decorator pattern via factory methods (spy, filter, map).
 */
export interface ChatResponseStream {
	/**
	 * Emit markdown content (primary response text).
	 */
	markdown(content: string): void;

	/**
	 * Emit thinking/reasoning content (visible to user).
	 */
	thinking(content: string | { content: string; delta?: string }): void;

	/**
	 * Emit code block with optional file context.
	 */
	codeblock(code: string, options?: CodeBlockOptions): void;

	/**
	 * Signal that a tool invocation is starting (before execution).
	 * @param toolCallId Unique ID for this tool call
	 * @param toolName Name of the tool being invoked
	 * @param partialArguments Optional streamed partial arguments
	 */
	beginToolInvocation(toolCallId: string, toolName: string, partialArguments?: Record<string, unknown>): void;

	/**
	 * Update streaming partial arguments for an in-flight tool invocation.
	 */
	updateToolInvocation(toolCallId: string, partialArguments: Record<string, unknown>): void;

	/**
	 * Emit tool execution result.
	 */
	toolResult(toolCallId: string, toolName: string, success: boolean, output?: string, error?: string): void;

	/**
	 * Emit a reference (file, location, variable).
	 */
	reference(value: string | vscode.Uri | vscode.Location, title?: string): void;

	/**
	 * Emit a status update message.
	 */
	status(message: string, kind?: "info" | "success" | "warning" | "error"): void;

	/**
	 * Emit an error message.
	 */
	error(message: string, code?: string): void;

	/**
	 * Emit a file tree (for visualizing multi-file edits).
	 */
	filetree(rootUri: vscode.Uri, entries: FileTreeEntry[]): void;

	/**
	 * Raw part emission for advanced use cases.
	 */
	push(part: ChatResponsePart): void;
}

export interface CodeBlockOptions {
	language?: string;
	filename?: string;
	filePath?: vscode.Uri;
	isEdit?: boolean;
	vulnerabilities?: ChatVulnerability[];
}

// ============================================================================
// SimpleChatResponseStream - Basic Implementation
// ============================================================================

/**
 * Basic implementation of ChatResponseStream that accumulates parts.
 */
export class SimpleChatResponseStream implements ChatResponseStream {
	private parts: ChatResponsePart[] = [];
	private paused = false;
	private pendingParts: ChatResponsePart[] = [];

	markdown(content: string): void {
		this.push({ type: "markdown", content });
	}

	thinking(content: string | { content: string; delta?: string }): void {
		const normalized = typeof content === "string" ? { content } : content;
		this.push({ type: "thinking", ...normalized });
	}

	codeblock(code: string, options?: CodeBlockOptions): void {
		this.push({
			type: "codeblock",
			code,
			language: options?.language,
			filename: options?.filename,
			filePath: options?.filePath,
			isEdit: options?.isEdit,
		});
	}

	beginToolInvocation(toolCallId: string, toolName: string, partialArguments?: Record<string, unknown>): void {
		this.push({
			type: "tool-invocation",
			toolCallId,
			toolName,
			partialArguments,
			isStreaming: !!partialArguments,
		});
	}

	updateToolInvocation(toolCallId: string, partialArguments: Record<string, unknown>): void {
		// For simple stream, we emit an update part (in practice, UI would merge these)
		// More sophisticated implementers might track and update existing parts
		this.push({
			type: "tool-invocation",
			toolCallId,
			toolName: "", // Will be matched by toolCallId
			partialArguments,
			isStreaming: true,
		});
	}

	toolResult(toolCallId: string, toolName: string, success: boolean, output?: string, error?: string): void {
		this.push({
			type: "tool-result",
			toolCallId,
			toolName,
			success,
			output,
			error,
		});
	}

	reference(value: string | vscode.Uri | vscode.Location, title?: string): void {
		this.push({
			type: "reference",
			value,
			title,
		});
	}

	status(message: string, kind: "info" | "success" | "warning" | "error" = "info"): void {
		this.push({
			type: "status",
			message,
			kind,
		});
	}

	error(message: string, code?: string): void {
		this.push({
			type: "error",
			message,
			code,
		});
	}

	filetree(rootUri: vscode.Uri, entries: FileTreeEntry[]): void {
		this.push({
			type: "filetree",
			rootUri,
			entries,
		});
	}

	push(part: ChatResponsePart): void {
		if (this.paused) {
			this.pendingParts.push(part);
		} else {
			this.parts.push(part);
		}
	}

	/**
	 * Get all accumulated parts (without draining).
	 */
	getParts(): ChatResponsePart[] {
		return [...this.parts];
	}

	/**
	 * Pause streaming (parts queue internally).
	 */
	pause(): void {
		this.paused = true;
	}

	/**
	 * Resume streaming (flush queued parts and continue).
	 */
	resume(): ChatResponsePart[] {
		this.paused = false;
		const queued = [...this.pendingParts];
		this.pendingParts = [];
		this.parts.push(...queued);
		return queued;
	}

	/**
	 * Check if stream is currently paused.
	 */
	isPaused(): boolean {
		return this.paused;
	}
}

// ============================================================================
// Decorator Pattern - Stream Middleware
// ============================================================================

/**
 * Decorator builder for response stream processing.
 *
 * Enables middleware pattern similar to vscode-copilot-chat:
 * - Spy: observe parts without modification
 * - Filter: skip certain parts
 * - Map: transform parts
 */
export class ChatResponseStreamDecorator implements ChatResponseStream {
	constructor(
		private inner: ChatResponseStream,
		private decorator: (part: ChatResponsePart) => ChatResponsePart | null
	) {}

	markdown(content: string): void {
		const part: ChatResponseMarkdownPart = { type: "markdown", content };
		const decorated = this.decorator(part);
		if (decorated) {
			this.inner.push(decorated);
		}
	}

	thinking(content: string | { content: string; delta?: string }): void {
		const normalized = typeof content === "string" ? { content } : content;
		const part: ChatResponseThinkingPart = { type: "thinking", ...normalized };
		const decorated = this.decorator(part);
		if (decorated) {
			this.inner.push(decorated);
		}
	}

	codeblock(code: string, options?: CodeBlockOptions): void {
		const part: ChatResponseCodeBlockPart = {
			type: "codeblock",
			code,
			language: options?.language,
			filename: options?.filename,
			filePath: options?.filePath,
			isEdit: options?.isEdit,
		};
		const decorated = this.decorator(part);
		if (decorated) {
			this.inner.push(decorated);
		}
	}

	beginToolInvocation(toolCallId: string, toolName: string, partialArguments?: Record<string, unknown>): void {
		const part: ChatResponseToolInvocationPart = {
			type: "tool-invocation",
			toolCallId,
			toolName,
			partialArguments,
			isStreaming: !!partialArguments,
		};
		const decorated = this.decorator(part);
		if (decorated) {
			this.inner.push(decorated);
		}
	}

	updateToolInvocation(toolCallId: string, partialArguments: Record<string, unknown>): void {
		const part: ChatResponseToolInvocationPart = {
			type: "tool-invocation",
			toolCallId,
			toolName: "",
			partialArguments,
			isStreaming: true,
		};
		const decorated = this.decorator(part);
		if (decorated) {
			this.inner.push(decorated);
		}
	}

	toolResult(toolCallId: string, toolName: string, success: boolean, output?: string, error?: string): void {
		const part: ChatResponseToolResultPart = {
			type: "tool-result",
			toolCallId,
			toolName,
			success,
			output,
			error,
		};
		const decorated = this.decorator(part);
		if (decorated) {
			this.inner.push(decorated);
		}
	}

	reference(value: string | vscode.Uri | vscode.Location, title?: string): void {
		const part: ChatResponseReferencePart = {
			type: "reference",
			value,
			title,
		};
		const decorated = this.decorator(part);
		if (decorated) {
			this.inner.push(decorated);
		}
	}

	status(message: string, kind: "info" | "success" | "warning" | "error" = "info"): void {
		const part: ChatResponseStatusPart = {
			type: "status",
			message,
			kind,
		};
		const decorated = this.decorator(part);
		if (decorated) {
			this.inner.push(decorated);
		}
	}

	error(message: string, code?: string): void {
		const part: ChatResponseErrorPart = {
			type: "error",
			message,
			code,
		};
		const decorated = this.decorator(part);
		if (decorated) {
			this.inner.push(decorated);
		}
	}

	filetree(rootUri: vscode.Uri, entries: FileTreeEntry[]): void {
		const part: ChatResponseFileTreePart = {
			type: "filetree",
			rootUri,
			entries,
		};
		const decorated = this.decorator(part);
		if (decorated) {
			this.inner.push(decorated);
		}
	}

	push(part: ChatResponsePart): void {
		const decorated = this.decorator(part);
		if (decorated) {
			this.inner.push(decorated);
		}
	}
}

/**
 * Factory for creating decorator streams.
 */
export class ChatResponseStreamFactory {
	/**
	 * Create a spy decorator (observe without modification).
	 */
	static spy(stream: ChatResponseStream, observer: (part: ChatResponsePart) => void): ChatResponseStream {
		return new ChatResponseStreamDecorator(stream, (part) => {
			observer(part);
			return part;
		});
	}

	/**
	 * Create a filter decorator (skip certain parts).
	 */
	static filter(stream: ChatResponseStream, predicate: (part: ChatResponsePart) => boolean): ChatResponseStream {
		return new ChatResponseStreamDecorator(stream, (part) => {
			return predicate(part) ? part : null;
		});
	}

	/**
	 * Create a map decorator (transform parts).
	 */
	static map(
		stream: ChatResponseStream,
		transformer: (part: ChatResponsePart) => ChatResponsePart
	): ChatResponseStream {
		return new ChatResponseStreamDecorator(stream, transformer);
	}
}

// ============================================================================
// Streaming Response Builder - For Managing Complex Response Flows
// ============================================================================

/**
 * Builder for managing complex streaming response sequences.
 *
 * Handles:
 * - Batching related parts together
 * - Ensuring proper ordering (thinking → markdown → tools → references)
 * - Flow control and pause/resume
 */
export class StreamingResponseBuilder {
	private stream: SimpleChatResponseStream;
	private toolCallMap: Map<string, ToolCallData> = new Map<string, ToolCallData>();

	constructor() {
		this.stream = new SimpleChatResponseStream();
	}

	/**
	 * Add markdown content to response.
	 */
	addMarkdown(content: string): this {
		this.stream.markdown(content);
		return this;
	}

	/**
	 * Add thinking content to response.
	 */
	addThinking(content: string | { content: string; delta?: string }): this {
		this.stream.thinking(content);
		return this;
	}

	/**
	 * Add code block to response.
	 */
	addCodeBlock(code: string, options?: CodeBlockOptions): this {
		this.stream.codeblock(code, options);
		return this;
	}

	/**
	 * Begin tracking a tool invocation.
	 */
	beginToolInvocation(toolCallId: string, toolName: string, partialArguments?: Record<string, unknown>): this {
		this.toolCallMap.set(toolCallId, {
			id: toolCallId,
			name: toolName,
			arguments: partialArguments || {},
			status: "pending",
		});
		this.stream.beginToolInvocation(toolCallId, toolName, partialArguments);
		return this;
	}

	/**
	 * Update streaming tool arguments.
	 */
	updateToolInvocation(toolCallId: string, partialArguments: Record<string, unknown>): this {
		const toolCall = this.toolCallMap.get(toolCallId);
		if (toolCall) {
			toolCall.arguments = { ...toolCall.arguments, ...partialArguments };
		}
		this.stream.updateToolInvocation(toolCallId, partialArguments);
		return this;
	}

	/**
	 * Complete a tool invocation with result.
	 */
	completeToolInvocation(
		toolCallId: string,
		toolName: string,
		success: boolean,
		output?: string,
		error?: string
	): this {
		const toolCall = this.toolCallMap.get(toolCallId);
		if (toolCall) {
			toolCall.status = success ? "completed" : "failed";
			toolCall.result = {
				success,
				output,
				...(error && { stderr: error }),
			};
		}
		this.stream.toolResult(toolCallId, toolName, success, output, error);
		return this;
	}

	/**
	 * Add reference to response.
	 */
	addReference(value: string | vscode.Uri | vscode.Location, title?: string): this {
		this.stream.reference(value, title);
		return this;
	}

	/**
	 * Add status update.
	 */
	addStatus(message: string, kind?: "info" | "success" | "warning" | "error"): this {
		this.stream.status(message, kind);
		return this;
	}

	/**
	 * Add error message.
	 */
	addError(message: string, code?: string): this {
		this.stream.error(message, code);
		return this;
	}

	/**
	 * Add file tree for visualizing edits.
	 */
	addFileTree(rootUri: vscode.Uri, entries: FileTreeEntry[]): this {
		this.stream.filetree(rootUri, entries);
		return this;
	}

	/**
	 * Get all collected parts.
	 */
	getParts(): ChatResponsePart[] {
		return this.stream.getParts();
	}

	/**
	 * Get tracked tool calls.
	 */
	getToolCalls(): ToolCallData[] {
		return Array.from(this.toolCallMap.values());
	}

	/**
	 * Get a specific tool call by ID.
	 */
	getToolCall(toolCallId: string): ToolCallData | undefined {
		return this.toolCallMap.get(toolCallId);
	}

	/**
	 * Pause streaming (queue subsequent parts).
	 */
	pause(): void {
		this.stream.pause();
	}

	/**
	 * Resume streaming (flush queued parts).
	 */
	resume(): ChatResponsePart[] {
		return this.stream.resume();
	}

	/**
	 * Build final response object.
	 */
	build(): StreamingResponse {
		return {
			parts: this.stream.getParts(),
			toolCalls: Array.from(this.toolCallMap.values()),
		};
	}
}

/**
 * Final streaming response object with all collected data.
 */
export interface StreamingResponse {
	parts: ChatResponsePart[];
	toolCalls: ToolCallData[];
}
