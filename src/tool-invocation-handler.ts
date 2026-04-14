/**
 * Tool Invocation Handler
 *
 * Enhanced tool calling system with streaming support.
 *
 * Features matching vscode-copilot-chat:
 * - Streaming partial arguments (user sees tool being built)
 * - Tool invocation lifecycle (pending → executing → completed)
 * - Result metadata and formatting
 * - Tool call tracking and history
 * - Error recovery
 * - Approval gating (optional)
 */

import * as vscode from "vscode";
import { ChatResponseStream, ToolResultData } from "./response-stream";

// ============================================================================
// Tool Invocation State Machine
// ============================================================================

/**
 * States a tool call progresses through.
 */
export type ToolInvocationState =
	| "pending"
	| "streaming"
	| "approved"
	| "executing"
	| "completed"
	| "failed"
	| "rejected";

/**
 * Represents a tool invocation with full lifecycle tracking.
 */
export interface TrackingToolCall {
	id: string;
	name: string;
	createdAt: number;
	state: ToolInvocationState;

	// Streaming arguments
	partialArguments: Record<string, unknown>;
	argumentsRaw?: string; // Raw partial JSON before validation

	// Approval gating
	requiresApproval?: boolean;
	approvedAt?: number;

	// Execution
	executedAt?: number;
	result?: ToolResultData;
	error?: string;
	errorCode?: string;

	// UI feedback
	invocationMessage?: string; // Custom message shown to user
	progressUpdates: ToolProgressUpdate[];
}

/**
 * Progress update for tool invocation.
 */
export interface ToolProgressUpdate {
	timestamp: number;
	message: string;
	kind: "info" | "warning" | "error" | "success";
}

// ============================================================================
// Tool Invocation Manager
// ============================================================================

/**
 * Manages tool invocations across a chat session.
 *
 * Tracks:
 * - Active tool calls
 * - Streaming argument assembly
 * - Approval gating
 * - Result formatting
 */
export class ToolInvocationManager {
	private toolCalls: Map<string, TrackingToolCall> = new Map<string, TrackingToolCall>();
	private approvalRequired = false;
	private listeners: ToolInvocationListener[] = [];

	constructor(options?: { approvalRequired?: boolean }) {
		this.approvalRequired = options?.approvalRequired ?? false;
	}

	/**
	 * Register a new tool invocation.
	 */
	beginInvocation(toolCallId: string, toolName: string, partialArguments?: Record<string, unknown>): TrackingToolCall {
		const call: TrackingToolCall = {
			id: toolCallId,
			name: toolName,
			createdAt: Date.now(),
			state: "pending",
			partialArguments: partialArguments || {},
			requiresApproval: this.approvalRequired,
			progressUpdates: [],
		};

		this.toolCalls.set(toolCallId, call);
		this.notifyListeners({ type: "invocation-created", toolCall: call });
		return call;
	}

	/**
	 * Update streaming partial arguments for a tool.
	 */
	updatePartialArguments(toolCallId: string, updates: Record<string, unknown>): TrackingToolCall | undefined {
		const call = this.toolCalls.get(toolCallId);
		if (!call) {
			return undefined;
		}

		call.partialArguments = { ...call.partialArguments, ...updates };
		call.state = "streaming";

		this.notifyListeners({ type: "arguments-updated", toolCall: call });
		return call;
	}

	/**
	 * Mark tool as approved for execution (when approval gating is enabled).
	 */
	approveTool(toolCallId: string): TrackingToolCall | undefined {
		const call = this.toolCalls.get(toolCallId);
		if (!call) {
			return undefined;
		}

		call.state = "approved";
		call.approvedAt = Date.now();

		this.notifyListeners({ type: "tool-approved", toolCall: call });
		return call;
	}

	/**
	 * Mark tool as rejected (when approval gating is enabled).
	 */
	rejectTool(toolCallId: string, reason?: string): TrackingToolCall | undefined {
		const call = this.toolCalls.get(toolCallId);
		if (!call) {
			return undefined;
		}

		call.state = "rejected";
		if (reason) {
			call.progressUpdates.push({
				timestamp: Date.now(),
				message: `Rejected: ${reason}`,
				kind: "warning",
			});
		}

		this.notifyListeners({ type: "tool-rejected", toolCall: call });
		return call;
	}

	/**
	 * Mark tool as executing.
	 */
	markExecuting(toolCallId: string): TrackingToolCall | undefined {
		const call = this.toolCalls.get(toolCallId);
		if (!call) {
			return undefined;
		}

		call.state = "executing";
		call.executedAt = Date.now();

		this.notifyListeners({ type: "execution-started", toolCall: call });
		return call;
	}

	/**
	 * Mark tool as complete with result.
	 */
	markCompleted(toolCallId: string, success: boolean, result?: ToolResultData): TrackingToolCall | undefined {
		const call = this.toolCalls.get(toolCallId);
		if (!call) {
			return undefined;
		}

		call.state = success ? "completed" : "failed";
		call.result = result;

		this.notifyListeners({ type: "execution-completed", toolCall: call });
		return call;
	}

	/**
	 * Mark tool as failed with error.
	 */
	markFailed(toolCallId: string, error: string, code?: string): TrackingToolCall | undefined {
		const call = this.toolCalls.get(toolCallId);
		if (!call) {
			return undefined;
		}

		call.state = "failed";
		call.error = error;
		call.errorCode = code;

		this.notifyListeners({ type: "execution-failed", toolCall: call });
		return call;
	}

	/**
	 * Add progress update to tool invocation.
	 */
	addProgress(toolCallId: string, message: string, kind: "info" | "warning" | "error" | "success" = "info"): void {
		const call = this.toolCalls.get(toolCallId);
		if (call) {
			call.progressUpdates.push({
				timestamp: Date.now(),
				message,
				kind,
			});

			this.notifyListeners({ type: "progress-updated", toolCall: call });
		}
	}

	/**
	 * Get a specific tool call.
	 */
	getToolCall(toolCallId: string): TrackingToolCall | undefined {
		return this.toolCalls.get(toolCallId);
	}

	/**
	 * Get all tool calls in session.
	 */
	getAllToolCalls(): TrackingToolCall[] {
		return Array.from(this.toolCalls.values());
	}

	/**
	 * Get completed tool calls.
	 */
	getCompletedToolCalls(): TrackingToolCall[] {
		return Array.from(this.toolCalls.values()).filter((c) => c.state === "completed");
	}

	/**
	 * Get pending tool calls.
	 */
	getPendingToolCalls(): TrackingToolCall[] {
		return Array.from(this.toolCalls.values()).filter((c) => c.state === "pending" || c.state === "streaming");
	}

	/**
	 * Listen to tool invocation events.
	 */
	onToolInvocationEvent(listener: ToolInvocationListener): vscode.Disposable {
		this.listeners.push(listener);
		return {
			dispose: () => {
				const idx = this.listeners.indexOf(listener);
				if (idx >= 0) {
					this.listeners.splice(idx, 1);
				}
			},
		};
	}

	private notifyListeners(event: ToolInvocationEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	/**
	 * Clear all tracked tool calls.
	 */
	clear(): void {
		this.toolCalls.clear();
	}
}

/**
 * Event emitted when tool invocation state changes.
 */
export type ToolInvocationEvent =
	| { type: "invocation-created"; toolCall: TrackingToolCall }
	| { type: "arguments-updated"; toolCall: TrackingToolCall }
	| { type: "tool-approved"; toolCall: TrackingToolCall }
	| { type: "tool-rejected"; toolCall: TrackingToolCall }
	| { type: "execution-started"; toolCall: TrackingToolCall }
	| { type: "execution-completed"; toolCall: TrackingToolCall }
	| { type: "execution-failed"; toolCall: TrackingToolCall }
	| { type: "progress-updated"; toolCall: TrackingToolCall };

export type ToolInvocationListener = (event: ToolInvocationEvent) => void;

// ============================================================================
// Tool Result Formatting
// ============================================================================

/**
 * Format tool result for display in chat.
 *
 * Handles:
 * - Rich formatting (markdown, file paths)
 * - Success/error styling
 * - Metadata presentation
 */
export function formatToolResult(
	toolCall: TrackingToolCall,
	options?: { verbose?: boolean; includeMetadata?: boolean }
): string {
	const parts: string[] = [];

	// Tool name and status
	const statusEmoji = getStatusEmoji(toolCall.state);
	parts.push(`${statusEmoji} **${toolCall.name}**`);

	// Result output
	if (toolCall.result?.output) {
		parts.push("```");
		parts.push(toolCall.result.output);
		parts.push("```");
	}

	// Error information
	if (toolCall.error) {
		parts.push(`⚠️ **Error**: ${toolCall.error}`);
		if (toolCall.errorCode) {
			parts.push(`(Code: ${toolCall.errorCode})`);
		}
	}

	// Progress updates
	if (options?.verbose && toolCall.progressUpdates.length > 0) {
		parts.push("**Progress**:");
		for (const update of toolCall.progressUpdates) {
			const emoji = getProgressEmoji(update.kind);
			parts.push(`- ${emoji} ${update.message}`);
		}
	}

	// Metadata
	if (options?.includeMetadata && toolCall.result?.metadata) {
		const metadataStr = JSON.stringify(toolCall.result.metadata, null, 2);
		parts.push("**Metadata**:");
		parts.push("```json");
		parts.push(metadataStr);
		parts.push("```");
	}

	return parts.join("\n");
}

function getStatusEmoji(state: ToolInvocationState): string {
	const emojis: Record<ToolInvocationState, string> = {
		pending: "⏳",
		streaming: "📥",
		approved: "✅",
		executing: "🔄",
		completed: "✓",
		failed: "❌",
		rejected: "⛔",
	};
	return emojis[state] || "•";
}

function getProgressEmoji(kind: string): string {
	const emojis: Record<string, string> = {
		info: "ℹ️",
		success: "✅",
		warning: "⚠️",
		error: "❌",
	};
	return emojis[kind] || "•";
}

// ============================================================================
// Stream Integration - Tool Results to Response Stream
// ============================================================================

/**
 * Emit tool invocation to response stream.
 */
export function emitToolInvocation(
	stream: ChatResponseStream,
	toolCall: TrackingToolCall,
	invocationMessage?: string
): void {
	const message = invocationMessage || generateInvocationMessage(toolCall);

	stream.beginToolInvocation(toolCall.id, toolCall.name, toolCall.partialArguments);

	if (message) {
		stream.status(message, "info");
	}
}

/**
 * Emit tool result to response stream.
 */
export function emitToolResult(stream: ChatResponseStream, toolCall: TrackingToolCall): void {
	const success = toolCall.state === "completed" && !toolCall.error;
	stream.toolResult(
		toolCall.id,
		toolCall.name,
		success,
		toolCall.result?.output || toolCall.result?.stdout,
		toolCall.error
	);
}

/**
 * Generate a default invocation message.
 */
function generateInvocationMessage(toolCall: TrackingToolCall): string {
	// Get key arguments for context
	const args = toolCall.partialArguments;
	const context: string[] = [];

	// Tool-specific context
	switch (toolCall.name) {
		case "read_file":
			if (args.path) {
				context.push(`Reading \`${args.path}\``);
			}
			break;
		case "write_file":
			if (args.path) {
				context.push(`Writing to \`${args.path}\``);
			}
			break;
		case "execute_command":
			if (args.command) {
				context.push(`Running \`${args.command}\``);
			}
			break;
		case "git_command":
			if (args.command) {
				context.push(`Git: \`${args.command}\``);
			}
			break;
		case "run_tests":
			context.push("Running tests");
			break;
		default:
			context.push(`Calling ${toolCall.name}`);
	}

	return context.length > 0 ? context.join(" · ") : `Calling ${toolCall.name}`;
}

// ============================================================================
// Tool Call Batch Management
// ============================================================================

/**
 * Represents a batch of tool calls to be executed together.
 * Useful for multi-tool workflows where order matters.
 */
export class ToolCallBatch {
	private toolCalls: TrackingToolCall[] = [];
	private executionOrder: string[] = []; // Tool call IDs in execution order

	constructor(private manager: ToolInvocationManager) {}

	/**
	 * Add tool call to batch.
	 */
	add(toolCall: TrackingToolCall): this {
		this.toolCalls.push(toolCall);
		this.executionOrder.push(toolCall.id);
		return this;
	}

	/**
	 * Get execution order.
	 */
	getExecutionOrder(): string[] {
		return [...this.executionOrder];
	}

	/**
	 * Get all tool calls in batch.
	 */
	getToolCalls(): TrackingToolCall[] {
		return [...this.toolCalls];
	}

	/**
	 * Get completion status of batch.
	 */
	getStatus(): { total: number; completed: number; failed: number; pending: number } {
		let completed = 0,
			failed = 0,
			pending = 0;

		for (const call of this.toolCalls) {
			if (call.state === "completed") {
				completed++;
			} else if (call.state === "failed") {
				failed++;
			} else if (call.state === "pending" || call.state === "streaming") {
				pending++;
			}
		}

		return {
			total: this.toolCalls.length,
			completed,
			failed,
			pending,
		};
	}

	/**
	 * Check if batch is complete.
	 */
	isComplete(): boolean {
		const status = this.getStatus();
		return status.completed + status.failed === status.total;
	}

	/**
	 * Check if any tool call failed.
	 */
	anyFailed(): boolean {
		return this.getStatus().failed > 0;
	}

	/**
	 * Clear batch.
	 */
	clear(): void {
		this.toolCalls = [];
		this.executionOrder = [];
	}
}
