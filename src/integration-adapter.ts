/**
 * Integration Module for Enhanced Fallback Chat.
 *
 * Bridges VS Code chat stream with richer response-part rendering.
 */

import * as vscode from "vscode";
import {
	SimpleChatResponseStream,
	type ChatResponseCodeBlockPart,
	type ChatResponsePart,
	type FileTreeEntry,
} from "./response-stream";
import { ProgressIndicatorRenderer, QuestionCarouselRenderer, UnifiedResponseRenderer } from "./ui-components";
import { ToolInvocationManager, emitToolResult } from "./tool-invocation-handler";

export interface EnhancedFallbackChatConfig {
	enableThinkingBlocks: boolean;
	enableCodeBlockExtraction: boolean;
	enableFileTreeVisualization: boolean;
	requireToolApproval: boolean;
	streamToolArguments: boolean;
	showProgress: boolean;
}

export function getEnhancedChatConfig(): EnhancedFallbackChatConfig {
	const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
	return {
		enableThinkingBlocks: config.get("showThinkingBlocks", true),
		enableCodeBlockExtraction: config.get("enableCodeBlockExtraction", true),
		enableFileTreeVisualization: config.get("showFileTreeForEdits", true),
		requireToolApproval: config.get("toolApprovalRequired", false),
		streamToolArguments: config.get("streamingToolArguments", true),
		showProgress: config.get("showProgressIndicators", true),
	};
}

export interface FallbackEditTreeItem {
	path: string;
	isNew?: boolean;
	description?: string;
}

export class FallbackChatStreamAdapter {
	private readonly toolManager: ToolInvocationManager;
	private readonly config: EnhancedFallbackChatConfig;
	private readonly vscodeStream: vscode.ChatResponseStream;
	private readonly baseStream = new SimpleChatResponseStream();
	private readonly toolIdMap = new Map<string, string>();
	private readonly workspaceFolder?: vscode.WorkspaceFolder;

	constructor(
		vscodeStream: vscode.ChatResponseStream,
		config?: EnhancedFallbackChatConfig,
		workspaceFolder?: vscode.WorkspaceFolder
	) {
		this.vscodeStream = vscodeStream;
		this.config = config || getEnhancedChatConfig();
		this.workspaceFolder = workspaceFolder;
		this.toolManager = new ToolInvocationManager({ approvalRequired: this.config.requireToolApproval });
	}

	emitMarkdown(content: string): void {
		this.baseStream.markdown(content);
		this.flushLastPart();
	}

	emitThinking(content: string): void {
		if (!this.config.enableThinkingBlocks) {
			return;
		}
		this.baseStream.thinking(content);
		this.flushLastPart();
	}

	emitCodeBlock(codeBlock: ChatResponseCodeBlockPart): void {
		this.baseStream.push(codeBlock);
		this.flushLastPart();
	}

	emitFileTree(edits: FallbackEditTreeItem[]): void {
		if (!this.config.enableFileTreeVisualization || edits.length === 0 || !this.workspaceFolder) {
			return;
		}

		const entries: FileTreeEntry[] = edits.map((edit) => ({
			uri: vscode.Uri.joinPath(this.workspaceFolder!.uri, edit.path),
			type: "file",
			status: edit.isNew ? "added" : "modified",
			description: edit.description || (edit.isNew ? "New file" : "Modified"),
		}));

		this.baseStream.filetree(this.workspaceFolder.uri, entries);
		this.flushLastPart();
	}

	emitQuestionCarousel(title: string, options: Array<{ label: string; description?: string }>): void {
		const renderer = new QuestionCarouselRenderer({
			title,
			questions: options,
			allowMultiple: false,
			allowSkip: false,
		});
		this.vscodeStream.markdown(renderer.render());
	}

	emitProgressSteps(
		steps: Array<{
			title: string;
			description?: string;
			status: "pending" | "in-progress" | "complete" | "failed";
			error?: string;
		}>
	): void {
		if (!this.config.showProgress || steps.length === 0) {
			return;
		}

		const renderer = new ProgressIndicatorRenderer();
		for (const step of steps) {
			renderer.addStep(step.title, step.description);
		}

		steps.forEach((step, index) => {
			switch (step.status) {
				case "in-progress":
					renderer.markStepInProgress(index);
					break;
				case "complete":
					renderer.markStepComplete(index);
					break;
				case "failed":
					renderer.markStepFailed(index, step.error);
					break;
			}
		});

		this.vscodeStream.markdown(renderer.render());
	}

	beginToolCall(name: string, id: string, args: Record<string, unknown>): void {
		this.toolIdMap.set(id, name);
		const tracking = this.toolManager.beginInvocation(id, name, args);
		this.baseStream.beginToolInvocation(tracking.id, tracking.name, tracking.partialArguments);
		this.flushLastPart();

		if (this.config.showProgress) {
			const argsCount = Object.keys(args).length;
			const argsStr = argsCount > 0 ? ` (${argsCount} args)` : "";
			this.vscodeStream.markdown(`Calling tool ${name}${argsStr}`);
		}
	}

	updateToolCall(toolId: string, args: Record<string, unknown>): void {
		const toolName = this.toolIdMap.get(toolId) || "tool";
		this.toolManager.updatePartialArguments(toolId, args);
		if (this.config.streamToolArguments) {
			this.vscodeStream.markdown(
				`Updating tool ${toolName} arguments:\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``
			);
		}
	}

	markToolExecuting(toolId: string): void {
		const toolName = this.toolIdMap.get(toolId) || "tool";
		this.toolManager.markExecuting(toolId);
		if (this.config.showProgress) {
			this.baseStream.status(`Executing ${toolName}`, "info");
			this.flushLastPart();
		}
	}

	markToolCompleted(toolId: string): void {
		const toolName = this.toolIdMap.get(toolId) || "tool";
		const tracked = this.toolManager.markCompleted(toolId, true, { success: true, output: `${toolName} completed` });
		if (tracked) {
			emitToolResult(this.baseStream, tracked);
			this.flushLastPart();
		}
	}

	markToolFailed(toolId: string, error?: string): void {
		const toolName = this.toolIdMap.get(toolId) || "tool";
		const failureMessage = error || "Unknown error";
		this.toolManager.markFailed(toolId, failureMessage);
		this.baseStream.error(`${toolName} failed: ${failureMessage}`);
		this.flushLastPart();
	}

	approveTool(toolId: string): void {
		const toolName = this.toolIdMap.get(toolId) || "tool";
		this.toolManager.approveTool(toolId);
		this.vscodeStream.markdown(`Approved tool ${toolName}`);
	}

	rejectTool(toolId: string, reason?: string): void {
		const toolName = this.toolIdMap.get(toolId) || "tool";
		this.toolManager.rejectTool(toolId, reason);
		this.vscodeStream.markdown(`Rejected tool ${toolName}${reason ? `: ${reason}` : ""}`);
	}

	getToolManager(): ToolInvocationManager {
		return this.toolManager;
	}

	private flushLastPart(): void {
		const parts = this.baseStream.getParts();
		const last = parts[parts.length - 1];
		if (!last) {
			return;
		}
		this.renderPart(last);
	}

	private renderPart(part: ChatResponsePart): void {
		const rendered = UnifiedResponseRenderer.render(part);
		if (rendered.trim().length > 0) {
			this.vscodeStream.markdown(rendered);
		}
	}
}

export function createEnhancedAdapter(
	stream: vscode.ChatResponseStream,
	workspaceFolder?: vscode.WorkspaceFolder
): FallbackChatStreamAdapter {
	const config = getEnhancedChatConfig();
	return new FallbackChatStreamAdapter(stream, config, workspaceFolder);
}

export function inferLanguageFromPath(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() || "";
	const languageMap: Record<string, string> = {
		js: "javascript",
		ts: "typescript",
		jsx: "javascript",
		tsx: "typescript",
		py: "python",
		java: "java",
		cpp: "cpp",
		c: "c",
		cs: "csharp",
		go: "go",
		rs: "rust",
		rb: "ruby",
		php: "php",
		swift: "swift",
		kt: "kotlin",
		json: "json",
		xml: "xml",
		html: "html",
		css: "css",
		sql: "sql",
		sh: "bash",
		bash: "bash",
		yml: "yaml",
		yaml: "yaml",
	};

	return languageMap[ext] || ext;
}
