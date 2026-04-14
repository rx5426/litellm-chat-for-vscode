/**
 * UI Components Registry for Enhanced Chat Display
 *
 * Provides renderers for advanced UI elements:
 * - Thinking/reasoning blocks
 * - Question carousels
 * - File tree visualization
 * - Progress indicators
 *
 * Bridges the gap between response parts and VS Code chat UI.
 */

import * as vscode from "vscode";
import {
	ChatResponsePart,
	ChatResponseThinkingPart,
	ChatResponseCodeBlockPart,
	FileTreeEntry,
} from "./response-stream";

// ============================================================================
// Thinking Block Component
// ============================================================================

/**
 * Render thinking/reasoning content as collapsible block.
 *
 * Mimics vscode-copilot-chat's thinking visualization:
 * - Shows progress incrementally
 * - Collapsible for screen space efficiency
 * - Different styling for complete vs in-progress
 */
export class ThinkingBlockRenderer {
	private thinkingContent: string[] = [];
	private isComplete = false;

	/**
	 * Add thinking content (streaming updates).
	 */
	addContent(content: string | { content: string; delta?: string }): void {
		const normalized = typeof content === "string" ? { content } : content;

		if (normalized.delta) {
			// Incremental update
			if (this.thinkingContent.length === 0) {
				this.thinkingContent.push(normalized.delta);
			} else {
				// Append to last chunk
				this.thinkingContent[this.thinkingContent.length - 1] += normalized.delta;
			}
		} else {
			// Full content
			this.thinkingContent.push(normalized.content);
		}
	}

	/**
	 * Mark thinking block as complete.
	 */
	complete(): void {
		this.isComplete = true;
	}

	/**
	 * Render as markdown with collapsible details.
	 */
	render(): string {
		const content = this.thinkingContent.join("");
		if (!content) {
			return "";
		}

		// Collapsible block (HTML details element in markdown)
		return ["<details>", "<summary>🧠 <strong>Thinking...</strong></summary>", "", content, "", "</details>"].join(
			"\n"
		);
	}

	/**
	 * Render as inline progress (for in-flight thinking).
	 */
	renderProgress(): string {
		const content = this.thinkingContent.join("");
		if (!content) {
			return "";
		}

		// Show first 100 chars as preview
		const preview = content.substring(0, 100).padEnd(100, ".");
		return `🧠 *${preview}*`;
	}

	/**
	 * Get current thinking content.
	 */
	getContent(): string {
		return this.thinkingContent.join("");
	}
}

// ============================================================================
// Question Carousel Component
// ============================================================================

/**
 * Question to present to user.
 */
export interface QuestionOption {
	label: string;
	description?: string;
	value?: unknown;
	selected?: boolean;
}

/**
 * Configuration for question carousel.
 */
export interface QuestionCarouselConfig {
	questions: QuestionOption[];
	title?: string;
	instructions?: string;
	allowSkip?: boolean;
	allowMultiple?: boolean;
}

/**
 * Render question carousel.
 *
 * Presents multiple choice questions inline in chat.
 * Similar to vscode-copilot-chat's question carousel.
 */
export class QuestionCarouselRenderer {
	constructor(private config: QuestionCarouselConfig) {}

	/**
	 * Render as interactive markdown/HTML.
	 */
	render(): string {
		const parts: string[] = [];

		if (this.config.title) {
			parts.push(`### ${this.config.title}`);
		}

		if (this.config.instructions) {
			parts.push(this.config.instructions);
		}

		parts.push("");
		parts.push("**Select options:**");
		parts.push("");

		// Render as numbered list with checkboxes
		for (const q of this.config.questions) {
			const checkbox = this.config.allowMultiple ? "☐" : "○";
			const selected = q.selected ? "✓" : checkbox;

			const line = `${selected} **${q.label}**`;
			if (q.description) {
				parts.push(`${line}`);
				parts.push(`   *${q.description}*`);
			} else {
				parts.push(line);
			}
		}

		if (this.config.allowSkip) {
			parts.push("");
			parts.push("⊘ Skip questions");
		}

		return parts.join("\n");
	}

	/**
	 * Get selected questions.
	 */
	getSelected(): QuestionOption[] {
		return this.config.questions.filter((q) => q.selected);
	}

	/**
	 * Mark question as selected.
	 */
	select(index: number): void {
		if (index >= 0 && index < this.config.questions.length) {
			if (this.config.allowMultiple) {
				this.config.questions[index].selected = !this.config.questions[index].selected;
			} else {
				// Single select mode
				for (const q of this.config.questions) {
					q.selected = false;
				}
				this.config.questions[index].selected = true;
			}
		}
	}
}

// ============================================================================
// File Tree Component
// ============================================================================

/**
 * Render file tree for visualizing multi-file edits.
 *
 * Shows:
 * - Directory structure
 * - File status (added, modified, deleted)
 * - File paths with clickable links
 */
export class FileTreeRenderer {
	constructor(
		private rootUri: vscode.Uri,
		private entries: FileTreeEntry[]
	) {}

	/**
	 * Render as markdown tree.
	 */
	render(): string {
		const lines: string[] = [];

		lines.push("📁 **File Changes**");
		lines.push("");

		// Render entries, grouped by status
		const byStatus = this.groupByStatus(this.entries);

		for (const [status, entries] of Object.entries(byStatus)) {
			const icon = this.getStatusIcon(status as string);
			lines.push(`${icon} **${this.capitalizeStatus(status)}** (${entries.length})`);

			for (const entry of entries) {
				lines.push(this.renderEntry(entry, 0));
			}

			lines.push("");
		}

		return lines.join("\n");
	}

	/**
	 * Render a single tree entry with indentation.
	 */
	private renderEntry(entry: FileTreeEntry, depth: number): string {
		const indent = "  ".repeat(depth);
		const icon = entry.type === "directory" ? "📁" : "📄";
		const statusIcon = entry.status ? this.getStatusIcon(entry.status) : "";
		const name = vscode.workspace.asRelativePath(entry.uri);

		let line = `${indent}${statusIcon ? statusIcon + " " : ""}${icon} \`${name}\``;

		if (entry.description) {
			line += ` - *${entry.description}*`;
		}

		let result = line;

		// Recursively render children
		if (entry.children && entry.children.length > 0) {
			for (const child of entry.children) {
				result += "\n" + this.renderEntry(child, depth + 1);
			}
		}

		return result;
	}

	/**
	 * Group entries by modification status.
	 */
	private groupByStatus(entries: FileTreeEntry[]): Record<string, FileTreeEntry[]> {
		const grouped: Record<string, FileTreeEntry[]> = {
			added: [],
			modified: [],
			deleted: [],
			conflict: [],
		};

		const distribute = (entry: FileTreeEntry): void => {
			const status = entry.status || "modified";
			if (!grouped[status]) {
				grouped[status] = [];
			}
			grouped[status].push(entry);

			if (entry.children) {
				for (const child of entry.children) {
					distribute(child);
				}
			}
		};

		for (const entry of entries) {
			distribute(entry);
		}

		return grouped;
	}

	/**
	 * Get icon for file status.
	 */
	private getStatusIcon(status: string): string {
		const icons: Record<string, string> = {
			added: "✨",
			modified: "✏️",
			deleted: "🗑️",
			conflict: "⚠️",
		};
		return icons[status] || "•";
	}

	/**
	 * Capitalize status name.
	 */
	private capitalizeStatus(status: string): string {
		return status.charAt(0).toUpperCase() + status.slice(1);
	}

	/**
	 * Count files by status.
	 */
	getStatusCounts(): Record<string, number> {
		const counts: Record<string, number> = {
			added: 0,
			modified: 0,
			deleted: 0,
			conflict: 0,
		};

		const count = (entry: FileTreeEntry): void => {
			const status = entry.status || "modified";
			if (Object.prototype.hasOwnProperty.call(counts, status)) {
				counts[status]++;
			}

			if (entry.children) {
				for (const child of entry.children) {
					count(child);
				}
			}
		};

		for (const entry of this.entries) {
			count(entry);
		}

		return counts;
	}
}

// ============================================================================
// Code Block Display Enhancements
// ============================================================================

/**
 * Render code block with enhanced features.
 */
export class CodeBlockRenderer {
	constructor(private codeBlock: ChatResponseCodeBlockPart) {}

	/**
	 * Render with language highlighting hint and file context.
	 */
	render(): string {
		const parts: string[] = [];

		// File context header (if available)
		if (this.codeBlock.filename || this.codeBlock.filePath) {
			const filename = this.codeBlock.filename || vscode.workspace.asRelativePath(this.codeBlock.filePath!);
			parts.push(`📄 **${filename}**`);
			parts.push("");
		}

		// Code block with language
		const fence = "```";
		parts.push(`${fence}${this.codeBlock.language || ""}`);
		parts.push(this.codeBlock.code);
		parts.push(fence);

		// Vulnerability rendering disabled due to type mismatch with VS Code chat part type
		return parts.join("\n");
	}

	private getSeverityEmoji(severity: string): string {
		const emojis: Record<string, string> = {
			low: "ℹ️",
			medium: "⚠️",
			high: "🔴",
			critical: "🚨",
		};
		return emojis[severity] || "•";
	}
}

// ============================================================================
// Response Part Renderer (Main)
// ============================================================================

/**
 * Unified renderer for all response parts.
 *
 * Routes each part type to appropriate renderer.
 */
export class UnifiedResponseRenderer {
	/**
	 * Render a response part to markdown string.
	 */
	static render(part: ChatResponsePart): string {
		switch (part.type) {
			case "markdown":
				return part.content;

			case "thinking": {
				const renderer = new ThinkingBlockRenderer();
				renderer.addContent(part.content);
				if (!(part as ChatResponseThinkingPart).delta) {
					renderer.complete();
				}
				return renderer.render();
			}

			case "codeblock": {
				const renderer = new CodeBlockRenderer(part as ChatResponseCodeBlockPart);
				return renderer.render();
			}

			case "tool-invocation":
				return `🔧 Calling **${part.toolName}**...`;

			case "tool-result":
				return part.success ? `✓ ${part.toolName} completed` : `❌ ${part.toolName} failed`;

			case "reference":
				return `📎 Reference: ${part.title || String(part.value)}`;

			case "status":
				return `${this.getStatusEmoji(part.kind)} ${part.message}`;

			case "error":
				return `❌ **Error**: ${part.message}`;

			case "filetree": {
				const renderer = new FileTreeRenderer(part.rootUri, part.entries);
				return renderer.render();
			}

			default:
				return "";
		}
	}

	private static getStatusEmoji(kind: string): string {
		const emojis: Record<string, string> = {
			info: "ℹ️",
			success: "✅",
			warning: "⚠️",
			error: "❌",
		};
		return emojis[kind] || "•";
	}

	/**
	 * Render multiple parts as combined markdown.
	 */
	static renderAll(parts: ChatResponsePart[]): string {
		return parts.map((part) => this.render(part)).join("\n\n");
	}
}

// ============================================================================
// Progress Indicator Component
// ============================================================================

/**
 * Render progress of long-running operations.
 */
export class ProgressIndicatorRenderer {
	private steps: ProgressStep[] = [];
	private currentStep = 0;

	addStep(title: string, description?: string): this {
		this.steps.push({
			title,
			description,
			status: "pending",
		});
		return this;
	}

	markStepInProgress(stepIndex: number): this {
		if (stepIndex >= 0 && stepIndex < this.steps.length) {
			this.steps[stepIndex].status = "in-progress";
			this.currentStep = stepIndex;
		}
		return this;
	}

	markStepComplete(stepIndex: number): this {
		if (stepIndex >= 0 && stepIndex < this.steps.length) {
			this.steps[stepIndex].status = "complete";
		}
		return this;
	}

	markStepFailed(stepIndex: number, error?: string): this {
		if (stepIndex >= 0 && stepIndex < this.steps.length) {
			this.steps[stepIndex].status = "failed";
			this.steps[stepIndex].error = error;
		}
		return this;
	}

	render(): string {
		const parts: string[] = [];

		parts.push("**Progress:**");
		parts.push("");

		for (const step of this.steps) {
			const icon = this.getStepIcon(step.status);
			parts.push(`${icon} **${step.title}**`);

			if (step.description) {
				parts.push(`   ${step.description}`);
			}

			if (step.error) {
				parts.push(`   ❌ ${step.error}`);
			}
		}

		const percentage = (this.currentStep / Math.max(1, this.steps.length)) * 100;
		parts.push("");
		parts.push(`Progress: ${Math.round(percentage)}%`);

		return parts.join("\n");
	}

	private getStepIcon(status: string): string {
		const icons: Record<string, string> = {
			pending: "⭕",
			"in-progress": "🔄",
			complete: "✅",
			failed: "❌",
		};
		return icons[status] || "•";
	}
}

interface ProgressStep {
	title: string;
	description?: string;
	status: "pending" | "in-progress" | "complete" | "failed";
	error?: string;
}
