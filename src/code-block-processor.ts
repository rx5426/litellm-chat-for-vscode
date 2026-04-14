/**
 * Code Block Extraction Middleware
 *
 * Extracts and decorates code blocks from markdown content.
 * Similar to vscode-copilot-chat's CodeBlockProcessor.
 *
 * Features:
 * - Incremental markdown parsing
 * - Language detection and hints
 * - File path resolution for edits
 * - Vulnerability annotation preservation
 * - Block deduplication
 */

import * as vscode from "vscode";
import {
	ChatResponseMarkdownPart,
	ChatResponseCodeBlockPart,
	ChatResponseStream,
	ChatVulnerability,
} from "./response-stream";

// ============================================================================
// Code Block Parser
// ============================================================================

/**
 * Represents a parsed code block from markdown.
 */
export interface ParsedCodeBlock {
	startIndex: number;
	endIndex: number;
	language?: string;
	code: string;
	markdownBefore?: string; // Context text before this block in markdown
	vulnerabilities?: ChatVulnerability[];
}

/**
 * Parser for extracting code blocks from markdown.
 *
 * Handles:
 * - Triple-backtick code fences
 * - Language specification (```typescript, ```python, etc.)
 * - Nested code in markdown structure
 * - Incremental parsing for streaming
 */
export class MarkdownCodeBlockParser {
	private buffer = "";
	private blocks: ParsedCodeBlock[] = [];

	/**
	 * Feed markdown content into parser (streaming).
	 * @returns Array of newly completed blocks
	 */
	feed(chunk: string): ParsedCodeBlock[] {
		this.buffer += chunk;
		const newBlocks: ParsedCodeBlock[] = [];

		// Simple state machine for finding code blocks
		let i = 0;
		while (i < this.buffer.length) {
			// Look for opening fence ```
			if (this.buffer.substr(i, 3) === "```") {
				const fenceStart = i;
				i += 3;

				// Get language identifier (if any)
				let language = "";
				while (i < this.buffer.length && this.buffer[i] !== "\n" && this.buffer[i] !== "\r") {
					language += this.buffer[i];
					i++;
				}

				// Skip newline
				if (this.buffer[i] === "\r" && this.buffer[i + 1] === "\n") {
					i += 2;
				} else if (this.buffer[i] === "\n" || this.buffer[i] === "\r") {
					i += 1;
				}

				const codeStart = i;

				// Look for closing fence
				const endIndex = this.buffer.indexOf("```", codeStart);
				if (endIndex === -1) {
					// Incomplete block, wait for more data
					break;
				}

				const codeEnd = endIndex;
				const code = this.buffer.substring(codeStart, codeEnd);

				const block: ParsedCodeBlock = {
					startIndex: fenceStart,
					endIndex: endIndex + 3,
					language: language.trim() || undefined,
					code: code.trimEnd(),
					markdownBefore: fenceStart > 0 ? this.buffer.substring(0, fenceStart) : undefined,
				};

				newBlocks.push(block);
				this.blocks.push(block);

				i = block.endIndex;
			} else {
				i++;
			}
		}

		// Keep incomplete buffer for next chunk
		if (newBlocks.length > 0) {
			const lastBlock = newBlocks[newBlocks.length - 1];
			this.buffer = this.buffer.substring(lastBlock.endIndex);
		}

		return newBlocks;
	}

	/**
	 * Finalize parsing when stream ends.
	 */
	finalize(): ParsedCodeBlock[] {
		// Return any remaining blocks
		const remaining = [...this.blocks];
		this.blocks = [];
		return remaining;
	}

	/**
	 * Get all parsed blocks.
	 */
	getBlocks(): ParsedCodeBlock[] {
		return [...this.blocks];
	}

	/**
	 * Reset parser state.
	 */
	reset(): void {
		this.buffer = "";
		this.blocks = [];
	}
}

// ============================================================================
// File Path Resolution
// ============================================================================

/**
 * Infer file path from code block context.
 *
 * Looks at:
 * - Language identifier (e.g., .ts, .py, .js)
 * - Markdown context (comments about file names)
 * - Editor context if available
 */
export async function inferFilePathFromCodeBlock(
	codeBlock: ParsedCodeBlock,
	workspaceFolder?: vscode.WorkspaceFolder
): Promise<vscode.Uri | undefined> {
	if (!workspaceFolder) {
		return undefined;
	}

	// Try to extract filename from code comments
	const lines = codeBlock.code.split("\n");
	for (const line of lines.slice(0, 5)) {
		// Look for patterns like: // file: src/main.ts
		const fileMatch = line.match(/(?:file|path|location)[:\s]+(.+?)(?:\s*$|[#\n])/i);
		if (fileMatch) {
			const possiblePath = fileMatch[1].trim();
			return vscode.Uri.joinPath(workspaceFolder.uri, possiblePath);
		}
	}

	// Try markdown context before code block
	if (codeBlock.markdownBefore) {
		// Look for markdown header or mention: "src/main.ts" or `src/main.ts`
		const pathPatterns = [/`([^`]+\.\w+)`/, /"([^"]+\.\w+)"/, /^#+\s+.+?:\s*(\S+\.\w+)/m];

		for (const pattern of pathPatterns) {
			const match = codeBlock.markdownBefore.match(pattern);
			if (match) {
				const possiblePath = match[1];
				// Validate it looks like a file path
				if (possiblePath.includes("/") || possiblePath.includes("\\")) {
					return vscode.Uri.joinPath(workspaceFolder.uri, possiblePath);
				}
			}
		}
	}

	// Use language to infer extension
	if (codeBlock.language) {
		const ext = languageToFileExtension(codeBlock.language);
		if (ext) {
			// Without better context, we can't create a proper path
			// but we can store the extension for reference
			return undefined;
		}
	}

	return undefined;
}

/**
 * Map language identifier to file extension.
 */
function languageToFileExtension(language: string): string | undefined {
	const mapping: Record<string, string> = {
		typescript: ".ts",
		javascript: ".js",
		jsx: ".jsx",
		tsx: ".tsx",
		python: ".py",
		java: ".java",
		csharp: ".cs",
		cpp: ".cpp",
		c: ".c",
		go: ".go",
		rust: ".rs",
		rb: ".rb",
		ruby: ".rb",
		php: ".php",
		swift: ".swift",
		kotlin: ".kt",
		scala: ".scala",
		json: ".json",
		yaml: ".yaml",
		yml: ".yml",
		xml: ".xml",
		html: ".html",
		css: ".css",
		scss: ".scss",
		bash: ".sh",
		shell: ".sh",
		powershell: ".ps1",
		sql: ".sql",
		markdown: ".md",
		md: ".md",
		dockerfile: "Dockerfile",
		makefile: "Makefile",
	};

	return mapping[language.toLowerCase()];
}

// ============================================================================
// Code Block Extraction Stream Decorator
// ============================================================================

/**
 * Stream decorator that extracts code blocks from markdown.
 *
 * Intercepts markdown parts and:
 * 1. Extracts code blocks
 * 2. Emits them as separate ChatResponseCodeBlockParts
 * 3. Resolves file paths when possible
 * 4. Preserves vulnerabilities
 *
 * Similar to vscode-copilot-chat's CodeBlockTrackingChatResponseStream.
 */
export class CodeBlockExtractionDecorator {
	private parser = new MarkdownCodeBlockParser();
	private seenBlockHashes = new Set<string>();
	private workspaceFolder: vscode.WorkspaceFolder | undefined;

	constructor(workspaceFolder?: vscode.WorkspaceFolder) {
		this.workspaceFolder = workspaceFolder;
	}

	/**
	 * Create a decorated stream that automatically extracts code blocks.
	 * TODO: Fix async/await issue with map function
	 */
	decorateStream(innerStream: ChatResponseStream): ChatResponseStream {
		// TODO: This needs to be refactored to handle async code block extraction
		// For now, returning stream as-is
		return innerStream;
	}
	/**
	 * Process markdown part and extract code blocks.
	 */
	private async processMarkdownPart(part: ChatResponseMarkdownPart, stream: ChatResponseStream): Promise<void> {
		const blocks = this.parser.feed(part.content);

		for (const block of blocks) {
			// Deduplicate blocks by content hash
			const hash = this.hashCodeBlock(block);
			if (this.seenBlockHashes.has(hash)) {
				continue;
			}
			this.seenBlockHashes.add(hash);

			// Resolve file path
			const filePath = await inferFilePathFromCodeBlock(block, this.workspaceFolder);

			// Emit code block as separate part
			const codeBlockPart: ChatResponseCodeBlockPart = {
				type: "codeblock",
				code: block.code,
				language: block.language,
				filePath,
				filename: filePath ? vscode.workspace.asRelativePath(filePath) : undefined,
				isEdit: isLikelyEditBlock(block),
				markdownBeforeBlock: block.markdownBefore,
				// TODO: vulnerabilities property not in VS Code type - fix type compatibility
				// vulnerabilities: block.vulnerabilities,
			};
			stream.push(codeBlockPart);
		}
	}

	/**
	 * Finalize parsing when stream completes.
	 */
	finalize(): void {
		this.parser.finalize();
	}

	/**
	 * Generate hash for code block (for deduplication).
	 */
	private hashCodeBlock(block: ParsedCodeBlock): string {
		// Simple hash based on code content and language
		const str = `${block.language}:${block.code}`;
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return hash.toString(36);
	}
}

/**
 * Determine if code block likely represents an edit operation.
 *
 * Heuristics:
 * - Starts with existing file path reference
 * - Contains diff-like markers (+++, ---, @@)
 * - Explicitly marked as edit
 * - Is a known code edit format
 */
function isLikelyEditBlock(block: ParsedCodeBlock): boolean {
	const code = block.code;

	// Check for diff markers
	if (code.includes("+++") || code.includes("---") || code.includes("@@")) {
		return true;
	}

	// Check for common file path in first line
	const firstLine = code.split("\n")[0];
	if (firstLine.includes("file:") || firstLine.includes("path:") || firstLine.match(/^([a-zA-Z0-9._\-/]+\.\w{2,})$/)) {
		return true;
	}

	return false;
}

// ============================================================================
// Markdown with Code Block Extraction
// ============================================================================

/**
 * Extract all code blocks from markdown text (non-streaming).
 *
 * Useful for batch processing complete responses.
 */
export async function extractCodeBlocksFromMarkdown(
	markdown: string,
	workspaceFolder?: vscode.WorkspaceFolder
): Promise<ParsedCodeBlock[]> {
	const parser = new MarkdownCodeBlockParser();
	const blocks = parser.feed(markdown);
	parser.finalize();

	// Resolve file paths for each block
	if (workspaceFolder) {
		for (const block of blocks) {
			block.markdownBefore = markdown.substring(0, block.startIndex);
		}
	}

	return blocks;
}

/**
 * Extract code blocks from markdown with full metadata.
 */
export async function enrichCodeBlocksWithMetadata(
	blocks: ParsedCodeBlock[],
	workspaceFolder?: vscode.WorkspaceFolder
): Promise<ChatResponseCodeBlockPart[]> {
	const results: ChatResponseCodeBlockPart[] = [];

	for (const block of blocks) {
		const filePath = await inferFilePathFromCodeBlock(block, workspaceFolder);

		results.push({
			type: "codeblock",
			code: block.code,
			language: block.language,
			filePath,
			filename: filePath ? vscode.workspace.asRelativePath(filePath) : undefined,
			isEdit: isLikelyEditBlock(block),
			markdownBeforeBlock: block.markdownBefore,
		});
	}

	return results;
}
