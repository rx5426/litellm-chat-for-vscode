import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

export type SetupSuggestionKind = "setup-tests" | "install-extension" | "search-extensions";
export type SetupSuggestionPresentation = "modal" | "reminder";

export interface FallbackSetupSuggestion {
	kind: SetupSuggestionKind;
	presentation: SetupSuggestionPresentation;
	title: string;
	description: string;
	recommendedExtensionId?: string;
	recommendedExtensionName?: string;
	reason: string;
}

interface PackageJsonLite {
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

const TEST_INTENT_PATTERN = /\b(test|tests|unit test|integration test|e2e|coverage|setup tests?)\b/i;
const CONFIRMATION_PATTERN =
	/(^\/(tool-approve|tool-reject|loop-approve|loop-rollback)\b)|\b(approve|reject|confirmed|confirmation)\b/i;

export async function computeFallbackSetupSuggestion(
	prompt: string,
	workspaceFolder: vscode.WorkspaceFolder | undefined,
	hasShownSuggestionBefore: boolean
): Promise<FallbackSetupSuggestion | undefined> {
	if (!prompt || !TEST_INTENT_PATTERN.test(prompt) || CONFIRMATION_PATTERN.test(prompt)) {
		return undefined;
	}

	const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
	const enabled = config.get<boolean>("automatedSetupSuggestions.enabled", true);
	if (!enabled) {
		return undefined;
	}

	const presentation: SetupSuggestionPresentation = hasShownSuggestionBefore ? "reminder" : "modal";
	const hasTests = await hasExistingTests();
	if (hasTests) {
		return undefined;
	}

	const languageId = await inferPrimaryLanguage(workspaceFolder);
	const packageJson = readPackageJson(workspaceFolder);
	const framework = detectTestFramework(packageJson);

	if (
		(languageId === "javascript" ||
			languageId === "typescript" ||
			languageId === "javascriptreact" ||
			languageId === "typescriptreact") &&
		!framework
	) {
		return {
			kind: "setup-tests",
			presentation,
			title: "Set up automated test tooling",
			description: "No test framework was detected. I can bootstrap a Vitest setup and test scripts automatically.",
			reason: "missing-test-framework",
		};
	}

	const extensionHint = getRecommendedTestExtension(languageId, framework);
	if (extensionHint && !vscode.extensions.getExtension(extensionHint.id)) {
		return {
			kind: "install-extension",
			presentation,
			title: "Install a test extension",
			description: `Install ${extensionHint.name} for better test discovery and inline run/debug actions.`,
			recommendedExtensionId: extensionHint.id,
			recommendedExtensionName: extensionHint.name,
			reason: "missing-test-extension",
		};
	}

	return {
		kind: "search-extensions",
		presentation,
		title: "Find testing support",
		description: "I can open the Extensions view with a test setup search for this workspace.",
		reason: "generic-testing-help",
	};
}

export function formatFallbackSetupSuggestionMarkdown(suggestion: FallbackSetupSuggestion): string {
	const prefix = suggestion.presentation === "modal" ? "### Recommended Setup" : "### Reminder";
	const extensionLine = suggestion.recommendedExtensionName
		? `\n- Recommended extension: ${suggestion.recommendedExtensionName}`
		: "";

	return `${prefix}\n\n${suggestion.description}${extensionLine}`;
}

export async function runAutomatedTestSetup(
	workspaceFolder: vscode.WorkspaceFolder | undefined
): Promise<{ started: boolean; command?: string; reason?: string }> {
	if (!workspaceFolder || workspaceFolder.uri.scheme !== "file") {
		return { started: false, reason: "No filesystem workspace folder is available." };
	}

	const packageJsonPath = path.join(workspaceFolder.uri.fsPath, "package.json");
	if (!fs.existsSync(packageJsonPath)) {
		return { started: false, reason: "No package.json found in workspace root." };
	}

	const packageManager = detectPackageManager(workspaceFolder.uri.fsPath);
	const installCmd =
		packageManager === "pnpm"
			? "pnpm add -D vitest @vitest/coverage-v8"
			: packageManager === "yarn"
				? "yarn add -D vitest @vitest/coverage-v8"
				: packageManager === "bun"
					? "bun add -d vitest @vitest/coverage-v8"
					: "npm install -D vitest @vitest/coverage-v8";

	const scriptCmd =
		packageManager === "npm"
			? 'npm pkg set scripts.test="vitest run" && npm pkg set scripts[\'test:watch\']="vitest"'
			: packageManager === "pnpm"
				? "pnpm pkg set scripts.test='vitest run' && pnpm pkg set scripts.test:watch='vitest'"
				: packageManager === "yarn"
					? "yarn pkg set scripts.test='vitest run' && yarn pkg set scripts.test:watch='vitest'"
					: 'npm pkg set scripts.test="vitest run" && npm pkg set scripts[\'test:watch\']="vitest"';

	const command = `${installCmd} && ${scriptCmd}`;
	const terminal = vscode.window.createTerminal({
		name: "LiteLLM Test Setup",
		cwd: workspaceFolder.uri.fsPath,
	});
	terminal.show(true);
	terminal.sendText(command, true);

	return { started: true, command };
}

export async function openTestingExtensionsSearch(query?: string): Promise<void> {
	const searchQuery = query?.trim() || "testing framework";
	await vscode.commands.executeCommand("workbench.extensions.search", searchQuery);
}

function readPackageJson(workspaceFolder: vscode.WorkspaceFolder | undefined): PackageJsonLite | undefined {
	if (!workspaceFolder || workspaceFolder.uri.scheme !== "file") {
		return undefined;
	}

	const packageJsonPath = path.join(workspaceFolder.uri.fsPath, "package.json");
	if (!fs.existsSync(packageJsonPath)) {
		return undefined;
	}

	try {
		const raw = fs.readFileSync(packageJsonPath, "utf-8");
		return JSON.parse(raw) as PackageJsonLite;
	} catch {
		return undefined;
	}
}

function detectTestFramework(packageJson: PackageJsonLite | undefined): "vitest" | "jest" | "mocha" | undefined {
	if (!packageJson) {
		return undefined;
	}

	const deps = {
		...(packageJson.dependencies ?? {}),
		...(packageJson.devDependencies ?? {}),
	};
	const scripts = packageJson.scripts ?? {};

	if (deps.vitest || hasScriptContaining(scripts, "vitest")) {
		return "vitest";
	}
	if (deps.jest || hasScriptContaining(scripts, "jest")) {
		return "jest";
	}
	if (deps.mocha || hasScriptContaining(scripts, "mocha")) {
		return "mocha";
	}
	return undefined;
}

function hasScriptContaining(scripts: Record<string, string>, token: string): boolean {
	return Object.values(scripts).some((value) => value.toLowerCase().includes(token));
}

async function hasExistingTests(): Promise<boolean> {
	const patterns = ["**/*.test.{ts,tsx,js,jsx}", "**/*.spec.{ts,tsx,js,jsx}", "**/test/**/*.ts", "**/test/**/*.js"];

	for (const pattern of patterns) {
		const matches = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 1);
		if (matches.length > 0) {
			return true;
		}
	}
	return false;
}

async function inferPrimaryLanguage(workspaceFolder: vscode.WorkspaceFolder | undefined): Promise<string | undefined> {
	const active = vscode.window.activeTextEditor?.document;
	if (active && !active.isUntitled) {
		return active.languageId;
	}

	if (!workspaceFolder) {
		return undefined;
	}

	const candidates = await vscode.workspace.findFiles("**/*.{ts,tsx,js,jsx,py,java,cs,go,rs}", "**/node_modules/**", 1);
	if (candidates.length === 0) {
		return undefined;
	}

	const doc = await vscode.workspace.openTextDocument(candidates[0]);
	return doc.languageId;
}

function getRecommendedTestExtension(
	languageId: string | undefined,
	framework: "vitest" | "jest" | "mocha" | undefined
): { id: string; name: string } | undefined {
	if (framework === "vitest") {
		return { id: "vitest.explorer", name: "Vitest" };
	}
	if (framework === "jest") {
		return { id: "orta.vscode-jest", name: "Jest" };
	}

	switch (languageId) {
		case "javascript":
		case "typescript":
		case "javascriptreact":
		case "typescriptreact":
			return { id: "orta.vscode-jest", name: "Jest" };
		case "python":
			return { id: "ms-python.python", name: "Python" };
		case "java":
			return { id: "vscjava.vscode-java-test", name: "Extension Pack for Java" };
		case "csharp":
			return { id: "ms-dotnettools.csharp", name: "C#" };
		case "go":
			return { id: "golang.go", name: "Go" };
		default:
			return undefined;
	}
}

function detectPackageManager(cwd: string): "npm" | "pnpm" | "yarn" | "bun" {
	if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
		return "pnpm";
	}
	if (fs.existsSync(path.join(cwd, "yarn.lock"))) {
		return "yarn";
	}
	if (fs.existsSync(path.join(cwd, "bun.lockb")) || fs.existsSync(path.join(cwd, "bun.lock"))) {
		return "bun";
	}
	return "npm";
}
