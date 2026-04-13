import * as assert from "assert";
import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "../provider";
import { activate } from "../extension";
import {
	buildPromptWithReferences,
	convertMessages,
	convertTools,
	extractCodeBlocks,
	extractStructuredEdits,
	resolveFallbackModelOptions,
	validateRequest,
	validateTools,
	tryParseJSONObject,
	formatToolResult,
	executeFallbackTool,
} from "../utils";

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}
interface ConvertedMessage {
	role: "user" | "assistant" | "tool";
	content?: string;
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

suite("LiteLLM Chat Provider Extension", () => {
	suite("provider", () => {
		test("prepareLanguageModelChatInformation returns array (no key -> empty)", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			assert.ok(Array.isArray(infos));
		});

		test("provideTokenCount counts simple string", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const est = await provider.provideTokenCount(
				{
					id: "m",
					name: "m",
					family: "litellm",
					version: "1.0.0",
					maxInputTokens: 1000,
					maxOutputTokens: 1000,
					capabilities: {},
				} as unknown as vscode.LanguageModelChatInformation,
				"hello world",
				new vscode.CancellationTokenSource().token
			);
			assert.equal(typeof est, "number");
			assert.ok(est > 0);
		});

		test("provideTokenCount counts message parts", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const msg: vscode.LanguageModelChatMessage = {
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("hello world")],
				name: undefined,
			};
			const est = await provider.provideTokenCount(
				{
					id: "m",
					name: "m",
					family: "litellm",
					version: "1.0.0",
					maxInputTokens: 1000,
					maxOutputTokens: 1000,
					capabilities: {},
				} as unknown as vscode.LanguageModelChatInformation,
				msg,
				new vscode.CancellationTokenSource().token
			);
			assert.equal(typeof est, "number");
			assert.ok(est > 0);
		});

		test("provideLanguageModelChatResponse throws without configuration", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			let threw = false;
			try {
				await provider.provideLanguageModelChatResponse(
					{
						id: "m",
						name: "m",
						family: "litellm",
						version: "1.0.0",
						maxInputTokens: 1000,
						maxOutputTokens: 1000,
						capabilities: {},
					} as unknown as vscode.LanguageModelChatInformation,
					[],
					{} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
					{ report: () => {} },
					new vscode.CancellationTokenSource().token
				);
			} catch {
				threw = true;
			}
			assert.ok(threw);
		});

		test("uses token constraints from provider info when available", async () => {
			// Mock fetch to return model with token constraints
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "test-provider",
										status: "active",
										supports_tools: true,
										context_length: 100000,
										max_output_tokens: 8000,
										max_input_tokens: 90000,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			global.fetch = originalFetch;

			// Find the per-provider entry
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxOutputTokens, 8000, "Should use max_output_tokens from provider");
			assert.equal(providerEntry.maxInputTokens, 90000, "Should use max_input_tokens from provider");
		});

		test("uses workspace settings as fallback when provider fields absent", async () => {
			// Mock fetch to return model without token constraints
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "test-provider",
										status: "active",
										supports_tools: true,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			// Mock workspace configuration
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat") {
					return {
						get: (key: string, defaultValue?: unknown) => {
							if (key === "defaultMaxOutputTokens") {
								return 20000;
							}
							if (key === "defaultContextLength") {
								return 200000;
							}
							if (key === "defaultMaxInputTokens") {
								return null;
							}
							return defaultValue;
						},
					} as unknown as vscode.WorkspaceConfiguration;
				}
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			global.fetch = originalFetch;
			vscode.workspace.getConfiguration = originalGetConfiguration;

			// Find the per-provider entry
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxOutputTokens, 20000, "Should use workspace setting for max output tokens");
			assert.equal(providerEntry.maxInputTokens, 180000, "Should calculate max input as context - output");
		});

		test("uses configured defaultMaxInputTokens as an explicit override", async () => {
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "test-provider",
										status: "active",
										supports_tools: true,
										context_length: 100000,
										max_output_tokens: 8000,
										max_input_tokens: 90000,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat") {
					return {
						get: (key: string, defaultValue?: unknown) => {
							if (key === "defaultMaxInputTokens") {
								return 50000;
							}
							return defaultValue;
						},
					} as unknown as vscode.WorkspaceConfiguration;
				}
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			global.fetch = originalFetch;
			vscode.workspace.getConfiguration = originalGetConfiguration;

			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxInputTokens, 50000, "Should use configured max input token override");
		});

		test("treats null provider max_input_tokens as missing and falls back to workspace setting", async () => {
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "test-provider",
										status: "active",
										supports_tools: true,
										context_length: 100000,
										max_output_tokens: 8000,
										max_input_tokens: null,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat") {
					return {
						get: (key: string, defaultValue?: unknown) => {
							if (key === "defaultMaxInputTokens") {
								return 48000;
							}
							return defaultValue;
						},
					} as unknown as vscode.WorkspaceConfiguration;
				}
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			global.fetch = originalFetch;
			vscode.workspace.getConfiguration = originalGetConfiguration;

			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxInputTokens, 48000, "Should ignore null provider max_input_tokens");
		});

		test("uses hardcoded defaults when provider and settings absent", async () => {
			// Mock fetch to return model without token constraints
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "test-provider",
										status: "active",
										supports_tools: true,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			// Mock workspace configuration to return defaults
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat") {
					return {
						get: (key: string, defaultValue?: unknown) => defaultValue,
					} as unknown as vscode.WorkspaceConfiguration;
				}
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			global.fetch = originalFetch;
			vscode.workspace.getConfiguration = originalGetConfiguration;

			// Find the per-provider entry
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxOutputTokens, 16000, "Should use hardcoded default for max output tokens");
			assert.equal(providerEntry.maxInputTokens, 112000, "Should calculate with hardcoded defaults (128000 - 16000)");
		});

		test("aggregates minimum token constraints for cheapest/fastest entries", async () => {
			// Mock fetch to return model with multiple providers
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "provider-a",
										status: "active",
										supports_tools: true,
										context_length: 100000,
										max_output_tokens: 8000,
									},
									{
										provider: "provider-b",
										status: "active",
										supports_tools: true,
										context_length: 50000,
										max_output_tokens: 4000,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			global.fetch = originalFetch;

			// Find the cheapest/fastest entries
			const cheapestEntry = infos.find((i) => i.id === "test-model:cheapest");
			const fastestEntry = infos.find((i) => i.id === "test-model:fastest");

			assert.ok(cheapestEntry, "Cheapest entry should exist");
			assert.ok(fastestEntry, "Fastest entry should exist");

			// Should use minimum of both providers
			assert.equal(cheapestEntry.maxOutputTokens, 4000, "Should use minimum max_output_tokens");
			assert.equal(fastestEntry.maxOutputTokens, 4000, "Should use minimum max_output_tokens");
			assert.equal(cheapestEntry.maxInputTokens, 46000, "Should calculate with minimum context (50000 - 4000)");
		});

		test("provider max_output_tokens takes priority over max_tokens", async () => {
			// Mock fetch to return model with both max_output_tokens and max_tokens
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "test-provider",
										status: "active",
										supports_tools: true,
										context_length: 100000,
										max_tokens: 10000,
										max_output_tokens: 8000,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			global.fetch = originalFetch;

			// Find the per-provider entry
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxOutputTokens, 8000, "Should prefer max_output_tokens over max_tokens");
		});

		suite("modelParameters configuration", () => {
			test("exact model ID match returns parameters", async () => {
				const originalGetConfiguration = vscode.workspace.getConfiguration;
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => {
								if (key === "modelParameters") {
									return {
										"gpt-4": {
											temperature: 0.8,
											max_tokens: 8000,
										},
									};
								}
								return defaultValue;
							},
						} as unknown as vscode.WorkspaceConfiguration;
					}
					return originalGetConfiguration(section);
				}) as unknown as typeof vscode.workspace.getConfiguration;

				// Access the private method through type assertion
				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const params = (provider as any).getModelParameters("gpt-4");

				vscode.workspace.getConfiguration = originalGetConfiguration;

				assert.deepEqual(params, { temperature: 0.8, max_tokens: 8000 });
			});

			test("prefix match returns parameters", async () => {
				const originalGetConfiguration = vscode.workspace.getConfiguration;
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => {
								if (key === "modelParameters") {
									return {
										"gpt-4": {
											temperature: 0.7,
										},
									};
								}
								return defaultValue;
							},
						} as unknown as vscode.WorkspaceConfiguration;
					}
					return originalGetConfiguration(section);
				}) as unknown as typeof vscode.workspace.getConfiguration;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const params = (provider as any).getModelParameters("gpt-4-turbo:openai");

				vscode.workspace.getConfiguration = originalGetConfiguration;

				assert.deepEqual(params, { temperature: 0.7 });
			});

			test("longest prefix match takes precedence", async () => {
				const originalGetConfiguration = vscode.workspace.getConfiguration;
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => {
								if (key === "modelParameters") {
									return {
										gpt: {
											temperature: 0.5,
										},
										"gpt-4": {
											temperature: 0.7,
										},
										"gpt-4-turbo": {
											temperature: 0.9,
										},
									};
								}
								return defaultValue;
							},
						} as unknown as vscode.WorkspaceConfiguration;
					}
					return originalGetConfiguration(section);
				}) as unknown as typeof vscode.workspace.getConfiguration;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// Should match "gpt-4-turbo" (length 12) over "gpt-4" (length 5) and "gpt" (length 3)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const params = (provider as any).getModelParameters("gpt-4-turbo:fastest");

				vscode.workspace.getConfiguration = originalGetConfiguration;

				assert.deepEqual(params, { temperature: 0.9 });
			});

			test("no match returns empty object", async () => {
				const originalGetConfiguration = vscode.workspace.getConfiguration;
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => {
								if (key === "modelParameters") {
									return {
										"gpt-4": {
											temperature: 0.7,
										},
									};
								}
								return defaultValue;
							},
						} as unknown as vscode.WorkspaceConfiguration;
					}
					return originalGetConfiguration(section);
				}) as unknown as typeof vscode.workspace.getConfiguration;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const params = (provider as any).getModelParameters("claude-opus");

				vscode.workspace.getConfiguration = originalGetConfiguration;

				assert.deepEqual(params, {});
			});

			test("empty configuration returns empty object", async () => {
				const originalGetConfiguration = vscode.workspace.getConfiguration;
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => defaultValue,
						} as unknown as vscode.WorkspaceConfiguration;
					}
					return originalGetConfiguration(section);
				}) as unknown as typeof vscode.workspace.getConfiguration;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const params = (provider as any).getModelParameters("gpt-4");

				vscode.workspace.getConfiguration = originalGetConfiguration;

				assert.deepEqual(params, {});
			});

			test("modelParameters supports various parameter types", async () => {
				const originalGetConfiguration = vscode.workspace.getConfiguration;
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => {
								if (key === "modelParameters") {
									return {
										"test-model": {
											temperature: 0.8,
											max_tokens: 4096,
											top_p: 0.9,
											frequency_penalty: 0.5,
											presence_penalty: 0.3,
											stop: ["END", "STOP"],
										},
									};
								}
								return defaultValue;
							},
						} as unknown as vscode.WorkspaceConfiguration;
					}
					return originalGetConfiguration(section);
				}) as unknown as typeof vscode.workspace.getConfiguration;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const params = (provider as any).getModelParameters("test-model");

				vscode.workspace.getConfiguration = originalGetConfiguration;

				assert.deepEqual(params, {
					temperature: 0.8,
					max_tokens: 4096,
					top_p: 0.9,
					frequency_penalty: 0.5,
					presence_penalty: 0.3,
					stop: ["END", "STOP"],
				});
			});
		});

		suite("stop sequences", () => {
			test("normalizes and de-duplicates stop sequences from configuration", async () => {
				const originalGetConfiguration = vscode.workspace.getConfiguration;
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => {
								if (key === "stopSequences") {
									return [" END ", "", "STOP", "END", 42, " STOP "];
								}
								return defaultValue;
							},
						} as unknown as vscode.WorkspaceConfiguration;
					}
					return originalGetConfiguration(section);
				}) as unknown as typeof vscode.workspace.getConfiguration;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const stop = (provider as any).resolveStopSequences(undefined, undefined);

				vscode.workspace.getConfiguration = originalGetConfiguration;

				assert.deepEqual(stop, ["END", "STOP"]);
			});

			test("runtime stop takes precedence over modelParameters and global setting", async () => {
				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const stop = (provider as any).resolveStopSequences(["RUNTIME"], ["MODEL"]);

				assert.deepEqual(stop, ["RUNTIME"]);
			});

			test("falls back to modelParameters stop when runtime stop is invalid", async () => {
				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const stop = (provider as any).resolveStopSequences(["   ", 123], "MODEL_STOP");

				assert.deepEqual(stop, ["MODEL_STOP"]);
			});
		});

		suite("diagnostics", () => {
			test("status callback reports successful fetch with model count", async () => {
				const originalFetch = global.fetch;
				global.fetch = async () =>
					({
						ok: true,
						json: async () => ({
							object: "list",
							data: [
								{
									id: "model-1",
									object: "model",
									created: 0,
									owned_by: "test",
									providers: [
										{
											provider: "test-provider",
											status: "active",
											supports_tools: true,
										},
									],
								},
								{
									id: "model-2",
									object: "model",
									created: 0,
									owned_by: "test",
									providers: [
										{
											provider: "test-provider",
											status: "active",
											supports_tools: true,
										},
									],
								},
							],
						}),
					}) as unknown as Response;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				let callbackModelCount: number | undefined;
				let callbackError: string | undefined;

				provider.setStatusCallback((modelCount: number, error?: string) => {
					callbackModelCount = modelCount;
					callbackError = error;
				});

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				// Should report success with 6 model entries (2 models × 3 entries each: cheapest, fastest, provider-specific)
				assert.equal(typeof callbackModelCount, "number");
				assert.ok(callbackModelCount && callbackModelCount > 0, "Should report positive model count");
				assert.equal(callbackError, undefined, "Should not report error on success");
			});

			test("status callback reports error on fetch failure", async () => {
				const originalFetch = global.fetch;
				global.fetch = async () => {
					throw new Error("Network error");
				};

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				let callbackModelCount: number | undefined;
				let callbackError: string | undefined;

				provider.setStatusCallback((modelCount: number, error?: string) => {
					callbackModelCount = modelCount;
					callbackError = error;
				});

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				assert.equal(callbackModelCount, 0, "Should report 0 models on error");
				assert.equal(typeof callbackError, "string", "Should report error message");
				assert.ok(callbackError && callbackError.includes("Network"), "Error message should mention network");
			});

			test("status callback reports empty model list", async () => {
				const originalFetch = global.fetch;
				global.fetch = async () =>
					({
						ok: true,
						json: async () => ({
							object: "list",
							data: [],
						}),
					}) as unknown as Response;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				let callbackModelCount: number | undefined;
				let callbackError: string | undefined;

				provider.setStatusCallback((modelCount: number, error?: string) => {
					callbackModelCount = modelCount;
					callbackError = error;
				});

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				assert.equal(callbackModelCount, 0, "Should report 0 models");
				assert.equal(typeof callbackError, "string", "Should report error for empty list");
				assert.ok(callbackError && callbackError.includes("0 models"), "Error should mention 0 models");
			});

			test("status callback reports missing configuration", async () => {
				const provider = new LiteLLMChatModelProvider(
					{
						get: async () => undefined,
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				let callbackModelCount: number | undefined;
				let callbackError: string | undefined;

				provider.setStatusCallback((modelCount: number, error?: string) => {
					callbackModelCount = modelCount;
					callbackError = error;
				});

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				assert.equal(callbackModelCount, 0, "Should report 0 models");
				assert.equal(typeof callbackError, "string", "Should report error");
				assert.ok(callbackError && callbackError.includes("Not configured"), "Error should mention not configured");
			});

			test("output channel receives log messages", async () => {
				const logs: string[] = [];
				const mockOutputChannel = {
					appendLine: (message: string) => logs.push(message),
					show: () => {},
					dispose: () => {},
				} as unknown as vscode.OutputChannel;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async () => undefined,
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test",
					mockOutputChannel
				);

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				assert.ok(logs.length > 0, "Should log messages");
				assert.ok(
					logs.some((log) => log.includes("ensureConfig")),
					"Should log ensureConfig call"
				);
				assert.ok(
					logs.some((log) => log.includes("No config found")),
					"Should log missing config"
				);
			});

			test("output channel receives error logs with timestamps", async () => {
				const originalFetch = global.fetch;
				global.fetch = async () => {
					throw new Error("Test error");
				};

				const logs: string[] = [];
				const mockOutputChannel = {
					appendLine: (message: string) => logs.push(message),
					show: () => {},
					dispose: () => {},
				} as unknown as vscode.OutputChannel;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test",
					mockOutputChannel
				);

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				assert.ok(logs.length > 0, "Should log messages");
				assert.ok(
					logs.some((log) => log.includes("ERROR")),
					"Should log error"
				);
				assert.ok(
					logs.some((log) => log.includes("Test error")),
					"Should include error message"
				);
				assert.ok(
					logs.some((log) => /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(log)),
					"Should include timestamps"
				);
			});
		});
	});

	suite("utils/convertMessages", () => {
		test("maps user/assistant text", () => {
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("hi")],
					name: undefined,
				},
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [new vscode.LanguageModelTextPart("hello")],
					name: undefined,
				},
			];
			const out = convertMessages(messages) as ConvertedMessage[];
			assert.deepEqual(out, [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			]);
		});

		test("maps tool calls and results", () => {
			const toolCall = new vscode.LanguageModelToolCallPart("abc", "toolA", { foo: 1 });
			const toolResult = new vscode.LanguageModelToolResultPart("abc", [new vscode.LanguageModelTextPart("result")]);
			const messages: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolResult], name: undefined },
			];
			const out = convertMessages(messages) as ConvertedMessage[];
			const hasToolCalls = out.some((m: ConvertedMessage) => Array.isArray(m.tool_calls));
			const hasToolMsg = out.some((m: ConvertedMessage) => m.role === "tool");
			assert.ok(hasToolCalls && hasToolMsg);
		});

		test("handles mixed text + tool calls in one assistant message", () => {
			const toolCall = new vscode.LanguageModelToolCallPart("call1", "search", { q: "hello" });
			const msg: vscode.LanguageModelChatMessage = {
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("before "), toolCall, new vscode.LanguageModelTextPart(" after")],
				name: undefined,
			};
			const out = convertMessages([msg]) as ConvertedMessage[];
			assert.equal(out.length, 1);
			assert.equal(out[0].role, "assistant");
			assert.ok(out[0].content?.includes("before"));
			assert.ok(out[0].content?.includes("after"));
			assert.ok(Array.isArray(out[0].tool_calls) && out[0].tool_calls.length === 1);
			assert.equal(out[0].tool_calls?.[0].function.name, "search");
		});
	});

	suite("utils/tools", () => {
		test("convertTools returns function tool definitions", () => {
			const out = convertTools({
				tools: [
					{
						name: "do_something",
						description: "Does something",
						inputSchema: { type: "object", properties: { x: { type: "number" } }, additionalProperties: false },
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);

			assert.ok(out);
			assert.equal(out.tool_choice, "auto");
			assert.ok(Array.isArray(out.tools) && out.tools[0].type === "function");
			assert.equal(out.tools[0].function.name, "do_something");
		});

		test("convertTools respects ToolMode.Required for single tool", () => {
			const out = convertTools({
				toolMode: vscode.LanguageModelChatToolMode.Required,
				tools: [
					{
						name: "only_tool",
						description: "Only tool",
						inputSchema: {},
					},
				],
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			assert.deepEqual(out.tool_choice, { type: "function", function: { name: "only_tool" } });
		});

		test("validateTools rejects invalid names", () => {
			const badTools: vscode.LanguageModelChatTool[] = [{ name: "bad name!", description: "", inputSchema: {} }];
			assert.throws(() => validateTools(badTools));
		});
	});

	suite("utils/validation", () => {
		test("validateRequest enforces tool result pairing", () => {
			const callId = "xyz";
			const toolCall = new vscode.LanguageModelToolCallPart(callId, "toolA", { q: 1 });
			const toolRes = new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")]);
			const valid: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.User, content: [toolRes], name: undefined },
			];
			assert.doesNotThrow(() => validateRequest(valid));

			const invalid: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("missing")],
					name: undefined,
				},
			];
			assert.throws(() => validateRequest(invalid));
		});
	});

	suite("utils/json", () => {
		test("tryParseJSONObject handles valid and invalid JSON", () => {
			assert.deepEqual(tryParseJSONObject('{"a":1}'), { ok: true, value: { a: 1 } });
			assert.deepEqual(tryParseJSONObject("[1,2,3]"), { ok: false });
			assert.deepEqual(tryParseJSONObject("not json"), { ok: false });
		});
	});

	suite("model info and fallback", () => {
		test("fallback from /v1/model/info to /v1/models on error", async () => {
			const originalFetch = global.fetch;
			let modelInfoAttempted = false;
			let modelsAttempted = false;

			global.fetch = async (url: string | URL | Request) => {
				const urlStr = url.toString();
				if (urlStr.includes("/v1/model/info")) {
					modelInfoAttempted = true;
					throw new Error("model/info endpoint failed");
				}
				if (urlStr.includes("/v1/models")) {
					modelsAttempted = true;
					return {
						ok: true,
						json: async () => ({
							object: "list",
							data: [
								{
									id: "test-model",
									object: "model",
									created: 0,
									owned_by: "test",
								},
							],
						}),
					} as unknown as Response;
				}
				throw new Error("Unexpected URL");
			};

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			global.fetch = originalFetch;

			assert.ok(modelInfoAttempted, "Should attempt /v1/model/info first");
			assert.ok(modelsAttempted, "Should fallback to /v1/models on error");
			assert.ok(infos.length > 0, "Should still return models from fallback");
		});

		test("prompt caching support detected from model/info", async () => {
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						data: [
							{
								model_name: "claude-3-5-sonnet-20241022",
								model_info: {
									id: "claude-3-5-sonnet-20241022",
									supports_function_calling: true,
									supports_prompt_caching: true,
									max_tokens: 8192,
									max_input_tokens: 200000,
								},
							},
						],
					}),
				}) as unknown as Response;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			global.fetch = originalFetch;

			assert.ok(infos.length > 0, "Should return models");
			// Access private _promptCachingSupport to verify
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const cachingSupport = (provider as any)._promptCachingSupport;
			assert.equal(cachingSupport.get("claude-3-5-sonnet-20241022"), true, "Should detect prompt caching support");
		});

		test("prompt caching disabled for models without support", async () => {
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						data: [
							{
								model_name: "gpt-4",
								model_info: {
									id: "gpt-4",
									supports_function_calling: true,
									supports_prompt_caching: false,
									max_tokens: 8192,
								},
							},
						],
					}),
				}) as unknown as Response;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

			global.fetch = originalFetch;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const cachingSupport = (provider as any)._promptCachingSupport;
			assert.equal(cachingSupport.get("gpt-4"), false, "Should mark as not supporting prompt caching");
		});

		test("model ID extracted with fallback priority", async () => {
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						data: [
							{
								model_name: "preferred-name",
								litellm_params: { model: "fallback-name" },
								model_info: {
									key: "third-choice",
									id: "last-resort",
								},
							},
						],
					}),
				}) as unknown as Response;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			global.fetch = originalFetch;

			const modelEntry = infos.find((i) => i.id === "preferred-name");
			assert.ok(modelEntry, "Should use model_name as first priority");
		});
	});
});
suite("utils/chat references", () => {
	test("buildPromptWithReferences includes selected code content for location references", async () => {
		const reference = {
			id: "selection",
			modelDescription: "Selected code in src/example.ts",
			value: new vscode.Location(
				vscode.Uri.file("f:/Vscode/litellm-vscode-chat/src/example.ts"),
				new vscode.Range(2, 0, 4, 0)
			),
		} as vscode.ChatPromptReference;

		const prompt = await buildPromptWithReferences("Explain this", [reference], {
			resolveReferenceText: async () => ({
				label: "src/example.ts:3-5",
				content: "const answer = 42;\nreturn answer;",
			}),
		});

		assert.ok(prompt.includes("Explain this"));
		assert.ok(prompt.includes("Additional context from chat references:"));
		assert.ok(prompt.includes("Selected code in src/example.ts"));
		assert.ok(prompt.includes("src/example.ts:3-5"));
		assert.ok(prompt.includes("const answer = 42;"));
	});

	test("buildPromptWithReferences includes attached file content for uri references", async () => {
		const reference = {
			id: "file",
			modelDescription: "Attached file src/config.json",
			value: vscode.Uri.file("f:/Vscode/litellm-vscode-chat/src/config.json"),
		} as vscode.ChatPromptReference;

		const prompt = await buildPromptWithReferences("Review this file", [reference], {
			resolveReferenceText: async () => ({
				label: "src/config.json",
				content: '{"enabled": true, "mode": "test"}',
			}),
		});

		assert.ok(prompt.includes("Review this file"));
		assert.ok(prompt.includes("Attached file src/config.json"));
		assert.ok(prompt.includes("src/config.json"));
		assert.ok(prompt.includes('"enabled": true'));
	});

	test("buildPromptWithReferences rewrites inline reference mentions and restores prompt order", async () => {
		const rawPrompt = "Compare #left and #right";
		const leftStart = rawPrompt.indexOf("#left");
		const rightStart = rawPrompt.indexOf("#right");

		const rightReference = {
			id: "right",
			range: [rightStart, rightStart + "#right".length],
			modelDescription: "Right side reference",
			value: "right-value",
		} as unknown as vscode.ChatPromptReference;

		const leftReference = {
			id: "left",
			range: [leftStart, leftStart + "#left".length],
			modelDescription: "Left side reference",
			value: "left-value",
		} as unknown as vscode.ChatPromptReference;

		// Simulate VS Code reverse range ordering from ChatRequest.references
		const prompt = await buildPromptWithReferences(rawPrompt, [rightReference, leftReference], {
			resolveReferenceText: async (reference) => ({
				label: reference.id,
				content: `${reference.id}-content`,
			}),
		});

		assert.ok(prompt.includes("Compare [Reference 1] and [Reference 2]"));
		assert.ok(prompt.includes("Reference 1\nDescription: Left side reference\nSource: left"));
		assert.ok(prompt.includes("Reference 2\nDescription: Right side reference\nSource: right"));
	});

	test("buildPromptWithReferences ignores invalid ranges and keeps prompt text", async () => {
		const prompt = await buildPromptWithReferences(
			"Review #broken",
			[
				{
					id: "broken",
					range: [999, 1005],
					modelDescription: "Broken range",
					value: "ignored",
				} as unknown as vscode.ChatPromptReference,
			],
			{
				resolveReferenceText: async () => ({ label: "broken", content: "content" }),
			}
		);

		assert.ok(prompt.includes("Review #broken"));
		assert.ok(prompt.includes("Reference 1"));
	});

	test("buildPromptWithReferences renders image uri references with explicit image note", async () => {
		const reference = {
			id: "image",
			modelDescription: "Screenshot of failing toolbar alignment",
			value: vscode.Uri.file("f:/Vscode/litellm-vscode-chat/assets/toolbar.png"),
		} as vscode.ChatPromptReference;

		const prompt = await buildPromptWithReferences("Inspect screenshot", [reference]);

		assert.ok(prompt.includes("Reference 1"));
		assert.ok(prompt.includes("toolbar.png"));
		assert.ok(prompt.includes("Screenshot of failing toolbar alignment"));
	});
});

suite("utils/fallback model options", () => {
	test("matches routed fallback model IDs by normalized prefix", () => {
		const resolved = resolveFallbackModelOptions("claude-code-sonnet-4-6:cheapest", {
			"claude-code-sonnet-4-6": { max_tokens: 12000, temperature: 0.7 },
		});

		assert.equal(resolved.matchedKey, "claude-code-sonnet-4-6");
		assert.deepEqual(resolved.options, { max_tokens: 12000, temperature: 0.7 });
	});

	test("matches claude alias keys for haiku 4.5", () => {
		const resolved = resolveFallbackModelOptions("anthropic/claude-haiku-4.5:fastest", {
			"claude-code-haiku-4-5": { max_tokens: 8192, temperature: 0.6 },
		});

		assert.equal(resolved.matchedKey, "claude-code-haiku-4-5");
		assert.deepEqual(resolved.options, { max_tokens: 8192, temperature: 0.6 });
	});

	test("uses longest normalized key when multiple entries match", () => {
		const resolved = resolveFallbackModelOptions("claude-code-opus-4-6:provider-anthropic", {
			claude: { temperature: 0.9 },
			"claude-code-opus": { temperature: 0.7 },
			"claude-code-opus-4-6": { temperature: 0.5, top_p: 0.9 },
		});

		assert.equal(resolved.matchedKey, "claude-code-opus-4-6");
		assert.deepEqual(resolved.options, { temperature: 0.5, top_p: 0.9 });
	});
});

suite("utils/code block extraction", () => {
	test("extractCodeBlocks captures path from fence metadata", () => {
		const markdown = ["Here is the update:", "```ts file=src/utils.ts", "export const x = 1;", "```"].join("\n");

		const blocks = extractCodeBlocks(markdown);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0].language, "ts");
		assert.equal(blocks[0].path, "src/utils.ts");
	});

	test("extractCodeBlocks captures path from leading code comment", () => {
		const markdown = ["```python", "# file: scripts/task.py", "print('ok')", "```"].join("\n");

		const blocks = extractCodeBlocks(markdown);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0].path, "scripts/task.py");
	});

	test("extractStructuredEdits parses litellm-edit fence", () => {
		const markdown = [
			"```litellm-edit",
			JSON.stringify({
				path: "src/provider.ts",
				intent: "replace",
				language: "ts",
				content: "export const updated = true;",
			}),
			"```",
		].join("\n");

		const edits = extractStructuredEdits(markdown);
		assert.equal(edits.length, 1);
		assert.equal(edits[0].path, "src/provider.ts");
		assert.equal(edits[0].intent, "replace");
		assert.equal(edits[0].language, "ts");
		assert.equal(edits[0].content, "export const updated = true;");
	});

	test("extractStructuredEdits parses edit envelopes", () => {
		const markdown = [
			"```litellm-edit",
			JSON.stringify({
				edits: [
					{ path: "src/one.ts", intent: "replace", content: "one" },
					{ path: "src/two.ts", intent: "create", content: "two" },
				],
			}),
			"```",
		].join("\n");

		const edits = extractStructuredEdits(markdown);
		assert.equal(edits.length, 2);
		assert.equal(edits[0].path, "src/one.ts");
		assert.equal(edits[1].intent, "create");
	});
});

suite("extension/fallback commands", () => {
	const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
	let originalRegisterCommand: typeof vscode.commands.registerCommand;
	let originalExecuteCommand: typeof vscode.commands.executeCommand;
	let originalShowQuickPick: typeof vscode.window.showQuickPick;
	let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
	let originalCreateOutputChannel: typeof vscode.window.createOutputChannel;
	let originalCreateStatusBarItem: typeof vscode.window.createStatusBarItem;
	let originalCreateChatParticipant: typeof vscode.chat.createChatParticipant;
	let originalGetConfiguration: typeof vscode.workspace.getConfiguration;
	let originalPrepareLanguageModelChatInformation: LiteLLMChatModelProvider["prepareLanguageModelChatInformation"];
	let originalProvideLanguageModelChatResponse: LiteLLMChatModelProvider["provideLanguageModelChatResponse"];
	let originalLmRegisterLanguageModelChatProvider: unknown;
	let originalGetExtension: typeof vscode.extensions.getExtension;
	let fallbackParticipantHandler:
		| ((
				request: vscode.ChatRequest,
				chatContext: vscode.ChatContext,
				stream: vscode.ChatResponseStream,
				token: vscode.CancellationToken
		  ) => Promise<vscode.ChatResult | void>)
		| undefined;
	let capturedRequestMessages: readonly vscode.LanguageModelChatRequestMessage[] | undefined;
	let capturedRequestOptions: vscode.ProvideLanguageModelChatResponseOptions | undefined;

	const createMockContext = (
		store: Map<string, unknown>,
		secretValues?: { baseUrl?: string; apiKey?: string }
	): vscode.ExtensionContext => {
		const defaultBaseUrl = secretValues?.baseUrl ?? "http://test";
		const defaultApiKey = secretValues?.apiKey ?? "test-key";
		return {
			subscriptions: [],
			workspaceState: {
				get: (_key: string, defaultValue?: unknown) => defaultValue,
				update: async (_key: string, _value: unknown) => {},
				keys: () => [],
			} as unknown as vscode.Memento,
			globalState: {
				get: <T>(key: string, defaultValue?: T) => (store.has(key) ? (store.get(key) as T) : (defaultValue as T)),
				update: async (key: string, value: unknown) => {
					store.set(key, value);
				},
				keys: () => Array.from(store.keys()),
				setKeysForSync: (_keys: readonly string[]) => {},
			} as unknown as vscode.Memento,
			secrets: {
				get: async (key: string) => {
					if (key === "litellm.baseUrl") {
						return defaultBaseUrl;
					}
					if (key === "litellm.apiKey") {
						return defaultApiKey;
					}
					return undefined;
				},
				store: async () => {},
				delete: async () => {},
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage,
			extensionUri: vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode"),
			extensionPath: "f:/Vscode/litellm-chat-for-vscode",
			environmentVariableCollection: {} as unknown as vscode.GlobalEnvironmentVariableCollection,
			storageUri: undefined,
			storagePath: undefined,
			globalStorageUri: vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode/.global-storage"),
			globalStoragePath: "f:/Vscode/litellm-chat-for-vscode/.global-storage",
			logUri: vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode/.log"),
			logPath: "f:/Vscode/litellm-chat-for-vscode/.log",
			extensionMode: vscode.ExtensionMode.Test,
			extension: {} as vscode.Extension<unknown>,
			asAbsolutePath: (relativePath: string) => `f:/Vscode/litellm-chat-for-vscode/${relativePath}`,
			languageModelAccessInformation: {
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
				canSendRequest: () => true,
			} as unknown as vscode.LanguageModelAccessInformation,
		} as unknown as vscode.ExtensionContext;
	};

	setup(() => {
		commandHandlers.clear();
		fallbackParticipantHandler = undefined;
		capturedRequestMessages = undefined;
		capturedRequestOptions = undefined;
		originalRegisterCommand = vscode.commands.registerCommand;
		originalExecuteCommand = vscode.commands.executeCommand;
		originalShowQuickPick = vscode.window.showQuickPick;
		originalShowInformationMessage = vscode.window.showInformationMessage;
		originalCreateOutputChannel = vscode.window.createOutputChannel;
		originalCreateStatusBarItem = vscode.window.createStatusBarItem;
		originalCreateChatParticipant = vscode.chat.createChatParticipant;
		originalGetConfiguration = vscode.workspace.getConfiguration;
		originalPrepareLanguageModelChatInformation =
			LiteLLMChatModelProvider.prototype.prepareLanguageModelChatInformation;
		originalProvideLanguageModelChatResponse = LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse;
		const lmApi = (vscode as unknown as { lm?: { registerLanguageModelChatProvider?: unknown } }).lm;
		originalLmRegisterLanguageModelChatProvider = lmApi?.registerLanguageModelChatProvider;
		originalGetExtension = vscode.extensions.getExtension;

		LiteLLMChatModelProvider.prototype.prepareLanguageModelChatInformation = async function () {
			return [
				{
					id: "claude-code-sonnet-4-6:cheapest",
					name: "Claude Sonnet",
					family: "litellm",
					version: "1.0.0",
					maxInputTokens: 200000,
					maxOutputTokens: 16000,
					capabilities: {},
				} as unknown as vscode.LanguageModelChatInformation,
			];
		};

		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model: vscode.LanguageModelChatInformation,
			messages: readonly vscode.LanguageModelChatRequestMessage[],
			_options: vscode.ProvideLanguageModelChatResponseOptions,
			progress: vscode.Progress<vscode.LanguageModelResponsePart>
		) {
			capturedRequestMessages = messages;
			capturedRequestOptions = _options;
			progress.report(new vscode.LanguageModelTextPart("Step result: updated plan and generated patch."));
			return;
		};

		vscode.commands.registerCommand = ((command: string, callback: (...args: unknown[]) => unknown) => {
			commandHandlers.set(command, callback);
			return { dispose() {} };
		}) as unknown as typeof vscode.commands.registerCommand;

		vscode.window.createOutputChannel = (() => ({
			appendLine: () => {},
			show: () => {},
			dispose: () => {},
		})) as unknown as typeof vscode.window.createOutputChannel;

		vscode.window.createStatusBarItem = (() => ({
			text: "",
			tooltip: "",
			backgroundColor: undefined,
			command: undefined,
			show: () => {},
			dispose: () => {},
		})) as unknown as typeof vscode.window.createStatusBarItem;

		vscode.chat.createChatParticipant = ((_id: string, handler: unknown) => {
			fallbackParticipantHandler = handler as typeof fallbackParticipantHandler;
			return {
				iconPath: undefined,
				onDidReceiveFeedback: { dispose() {} },
				dispose: () => {},
			};
		}) as unknown as typeof vscode.chat.createChatParticipant;

		vscode.workspace.getConfiguration = ((section?: string) => {
			if (section === "litellm-vscode-chat") {
				return {
					get: (_key: string, defaultValue?: unknown) => defaultValue,
					update: async () => {},
				} as unknown as vscode.WorkspaceConfiguration;
			}
			return originalGetConfiguration(section);
		}) as unknown as typeof vscode.workspace.getConfiguration;

		if (lmApi && typeof lmApi === "object") {
			lmApi.registerLanguageModelChatProvider = () => ({ dispose() {} });
		}

		vscode.extensions.getExtension = (() => ({
			packageJSON: { version: "test" },
		})) as unknown as typeof vscode.extensions.getExtension;
	});

	teardown(() => {
		vscode.commands.registerCommand = originalRegisterCommand;
		vscode.commands.executeCommand = originalExecuteCommand;
		vscode.window.showQuickPick = originalShowQuickPick;
		vscode.window.showInformationMessage = originalShowInformationMessage;
		vscode.window.createOutputChannel = originalCreateOutputChannel;
		vscode.window.createStatusBarItem = originalCreateStatusBarItem;
		vscode.chat.createChatParticipant = originalCreateChatParticipant;
		vscode.workspace.getConfiguration = originalGetConfiguration;
		LiteLLMChatModelProvider.prototype.prepareLanguageModelChatInformation =
			originalPrepareLanguageModelChatInformation;
		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = originalProvideLanguageModelChatResponse;
		const lmApi = (vscode as unknown as { lm?: { registerLanguageModelChatProvider?: unknown } }).lm;
		if (lmApi && typeof lmApi === "object") {
			lmApi.registerLanguageModelChatProvider = originalLmRegisterLanguageModelChatProvider;
		}
		vscode.extensions.getExtension = originalGetExtension;
	});

	test("litellm.use103ModelPickerWorkaround selects model and opens fallback chat", async () => {
		const executedCommands: string[] = [];
		let quickPickCalled = 0;

		vscode.window.showQuickPick = (async (items: readonly unknown[]) => {
			quickPickCalled++;
			return items[0] as never;
		}) as unknown as typeof vscode.window.showQuickPick;

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			if (message.includes("On VS Code 1.103.x")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			executedCommands.push(command);
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([["litellm.hasShownWelcome", true]]);
		activate(createMockContext(state));

		const workaround = commandHandlers.get("litellm.use103ModelPickerWorkaround");
		assert.ok(workaround, "Expected workaround command to be registered");
		await workaround?.();

		assert.equal(quickPickCalled, 1);
		assert.ok(executedCommands.includes("workbench.action.chat.open"));
		assert.equal(state.get("litellm.selectedChatModel"), "claude-code-sonnet-4-6:cheapest");
	});

	test("litellm.openFallbackChat reuses selected model and opens chat", async () => {
		const executedCommands: string[] = [];
		let quickPickCalled = 0;

		vscode.window.showQuickPick = (async () => {
			quickPickCalled++;
			return undefined as never;
		}) as unknown as typeof vscode.window.showQuickPick;

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			if (message.includes("On VS Code 1.103.x")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			executedCommands.push(command);
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		const openFallbackChat = commandHandlers.get("litellm.openFallbackChat");
		assert.ok(openFallbackChat, "Expected open fallback chat command to be registered");
		await openFallbackChat?.();

		assert.equal(quickPickCalled, 0, "Should not prompt when stored model is available");
		assert.ok(executedCommands.includes("workbench.action.chat.open"));
	});

	test("1.103 workaround hint is shown only once", async () => {
		let workaroundHintShownCount = 0;
		const parseVersion = (value: string): [number, number, number] => {
			const [major = "0", minor = "0", patch = "0"] = value.split(".");
			const toNum = (part: string) => Number.parseInt(part.replace(/[^0-9]/g, ""), 10) || 0;
			return [toNum(major), toNum(minor), toNum(patch)];
		};
		const isLikelyLimitedModelPickerUi = (() => {
			const [major, minor] = parseVersion(vscode.version);
			return major < 1 || (major === 1 && minor < 108);
		})();

		vscode.window.showQuickPick = (async (items: readonly unknown[]) =>
			items[0] as never) as unknown as typeof vscode.window.showQuickPick;

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x")) {
				workaroundHintShownCount++;
				return "Dismiss" as never;
			}
			if (message.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([["litellm.hasShownWelcome", true]]);
		const context = createMockContext(state);

		activate(context);
		activate(context);

		assert.equal(workaroundHintShownCount, isLikelyLimitedModelPickerUi ? 1 : 0);
		assert.equal(state.get("litellm.hasShown103WorkaroundHint"), isLikelyLimitedModelPickerUi ? true : undefined);
	});

	test("fallback workflow slash command /goal persists task goal", async () => {
		const streamMarkdown: string[] = [];

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([["litellm.hasShownWelcome", true]]);
		activate(createMockContext(state));

		assert.ok(fallbackParticipantHandler, "Expected fallback participant handler to be captured");
		await fallbackParticipantHandler?.(
			{
				prompt: "/goal Finish migration",
				references: [],
			} as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: (value: string) => streamMarkdown.push(String(value)),
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		const workflowState = state.get("litellm.fallbackWorkflowState") as { goal?: string; notes?: string[] } | undefined;
		assert.equal(workflowState?.goal, "Finish migration");
		assert.ok(streamMarkdown.some((m) => m.includes("Saved fallback workflow goal")));
	});

	test("fallback workflow state is injected into normal fallback request prompts", async () => {
		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x")) {
				return "Dismiss" as never;
			}
			if (message.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			[
				"litellm.fallbackWorkflowState",
				{
					goal: "Ship stable release",
					notes: ["Keep changes minimal", "Run regression tests"],
					loopEnabled: false,
					pendingApproval: false,
					checkpoints: [],
					updatedAt: Date.now(),
				},
			],
		]);
		activate(createMockContext(state));

		assert.ok(fallbackParticipantHandler, "Expected fallback participant handler to be captured");
		await fallbackParticipantHandler?.(
			{
				prompt: "Continue implementation",
				references: [],
			} as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: () => {},
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		assert.ok(capturedRequestMessages && capturedRequestMessages.length > 0);
		const lastMessage = capturedRequestMessages?.[capturedRequestMessages.length - 1];
		assert.ok(lastMessage, "Expected captured fallback request message");
		const textParts = lastMessage?.content
			.filter((part) => part instanceof vscode.LanguageModelTextPart)
			.map((part) => (part as vscode.LanguageModelTextPart).value)
			.join("\n");

		assert.ok(textParts?.includes("## Task"));
		assert.ok(textParts?.includes("## References"));
		assert.ok(textParts?.includes("## Workflow State"));
		assert.ok(textParts?.includes("## Tool Results"));
		assert.ok(textParts?.includes("## Edit Intent"));
		assert.ok(textParts?.includes("Goal: Ship stable release"));
		assert.ok(textParts?.includes("- Keep changes minimal"));
		assert.ok(textParts?.includes("Continue implementation"));
	});

	test("fallback injects ranked workspace context from prompt, active file, and recent history", async () => {
		const originalActiveTextEditorDescriptor = Object.getOwnPropertyDescriptor(vscode.window, "activeTextEditor");
		const originalExecuteCommand = vscode.commands.executeCommand;

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x")) {
				return "Dismiss" as never;
			}
			if (message.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			if (command === "vscode.executeDocumentSymbolProvider") {
				return [
					new vscode.DocumentSymbol(
						"toolModeOverride",
						"",
						vscode.SymbolKind.Variable,
						new vscode.Range(40, 0, 40, 20),
						new vscode.Range(40, 0, 40, 20)
					),
				] as unknown;
			}
			if (command === "vscode.executeReferenceProvider") {
				const uri = args[0] as vscode.Uri;
				return [new vscode.Location(uri, new vscode.Range(120, 4, 120, 20))] as unknown;
			}
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return await originalExecuteCommand(command, ...args);
		}) as unknown as typeof vscode.commands.executeCommand;

		Object.defineProperty(vscode.window, "activeTextEditor", {
			configurable: true,
			get: () =>
				({
					document: {
						uri: vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode/src/extension.ts"),
					} as vscode.TextDocument,
				}) as vscode.TextEditor,
		});

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		try {
			await fallbackParticipantHandler?.(
				{
					prompt: "Improve toolModeOverride behavior in extension.ts",
					references: [],
				} as unknown as vscode.ChatRequest,
				{
					history: [{ prompt: "Use config and active file context" } as unknown as vscode.ChatRequestTurn],
				} as unknown as vscode.ChatContext,
				{
					markdown: () => {},
					progress: () => {},
					button: () => {},
					anchor: () => {},
					filetree: () => {},
					push: () => {},
				} as unknown as vscode.ChatResponseStream,
				new vscode.CancellationTokenSource().token
			);

			assert.ok(capturedRequestMessages && capturedRequestMessages.length > 0);
			const lastMessage = capturedRequestMessages?.[capturedRequestMessages.length - 1];
			assert.ok(lastMessage, "Expected captured fallback request message");
			const promptText = (lastMessage?.content ?? [])
				.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ""))
				.join("\n");
			assert.ok(promptText.includes("## Task"));
			assert.ok(promptText.includes("## References"));
			assert.ok(promptText.includes("## Workflow State"));
			assert.ok(promptText.includes("## Tool Results"));
			assert.ok(promptText.includes("## Edit Intent"));
			assert.ok(promptText.includes("Relevant workspace context (ranked):"));
			assert.ok(promptText.includes("Nearby code snippets:"));
			assert.ok(promptText.includes("Symbol context (definitions and references):"));
			assert.ok(promptText.includes("File relationships:"));
			assert.ok(promptText.includes("src/extension.ts"));
			assert.ok(promptText.includes("toolModeOverride"));
			assert.ok(promptText.includes("References:"));
		} finally {
			if (originalActiveTextEditorDescriptor) {
				Object.defineProperty(vscode.window, "activeTextEditor", originalActiveTextEditorDescriptor);
			}
			vscode.commands.executeCommand = originalExecuteCommand;
		}
	});

	test("loop-step creates checkpoint and enables approval gate", async () => {
		const markdowns: string[] = [];

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([["litellm.hasShownWelcome", true]]);
		activate(createMockContext(state));

		await fallbackParticipantHandler?.(
			{ prompt: "/loop-start Build release", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: (value: string) => markdowns.push(value),
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		await fallbackParticipantHandler?.(
			{ prompt: "/loop-step Create changelog", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: (value: string) => markdowns.push(value),
				progress: (value: unknown) => markdowns.push(String(value ?? "")),
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		const workflowState = state.get("litellm.fallbackWorkflowState") as
			| { loopEnabled?: boolean; pendingApproval?: boolean; checkpoints?: unknown[] }
			| undefined;
		assert.ok(workflowState?.loopEnabled);
		assert.equal(workflowState?.pendingApproval, true);
		assert.ok((workflowState?.checkpoints?.length ?? 0) >= 1);
		assert.ok(markdowns.some((value) => value.includes("Approval required before next /loop-step")));
	});

	test("approval gate blocks next loop-step until approval and rollback can restore checkpoint", async () => {
		const markdowns: string[] = [];

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([["litellm.hasShownWelcome", true]]);
		activate(createMockContext(state));

		const token = new vscode.CancellationTokenSource().token;
		const stream = {
			markdown: (value: string) => markdowns.push(value),
			progress: (value: unknown) => markdowns.push(String(value ?? "")),
			button: () => {},
			anchor: () => {},
			filetree: () => {},
			push: () => {},
		} as unknown as vscode.ChatResponseStream;

		await fallbackParticipantHandler?.(
			{ prompt: "/loop-start Ship release", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			token
		);
		await fallbackParticipantHandler?.(
			{ prompt: "/loop-step Step one", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			token
		);

		const firstState = state.get("litellm.fallbackWorkflowState") as { checkpoints: Array<{ id: string }> };
		const firstCheckpointId = firstState.checkpoints[0].id;

		await fallbackParticipantHandler?.(
			{ prompt: "/loop-step Step two", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			token
		);

		const blockedState = state.get("litellm.fallbackWorkflowState") as { checkpoints: unknown[] };
		assert.equal(blockedState.checkpoints.length, 1);
		assert.ok(markdowns.some((value) => value.includes("Approval gate is active")));

		await fallbackParticipantHandler?.(
			{ prompt: "/loop-approve", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			token
		);

		await fallbackParticipantHandler?.(
			{ prompt: "/loop-step Step two", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			token
		);

		const secondState = state.get("litellm.fallbackWorkflowState") as { checkpoints: unknown[] };
		assert.equal(secondState.checkpoints.length, 2);

		await fallbackParticipantHandler?.(
			{ prompt: `/loop-rollback ${firstCheckpointId}`, references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			token
		);

		const rolledBackState = state.get("litellm.fallbackWorkflowState") as {
			checkpoints: unknown[];
			pendingApproval: boolean;
		};
		assert.equal(rolledBackState.checkpoints.length, 1);
		assert.equal(rolledBackState.pendingApproval, false);
	});

	test("fallback stages structured edits for review instead of auto-applying", async () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const utilsModule = require("../utils") as {
			applyCodeEdit: (code: string, filePath?: string, range?: vscode.Range, language?: string) => Promise<vscode.Uri>;
			applyStructuredEdit: (edit: {
				id: string;
				path: string;
				intent: "create" | "replace";
				content?: string;
				language?: string;
			}) => Promise<vscode.Uri>;
		};
		const originalApplyCodeEdit = utilsModule.applyCodeEdit;
		const originalApplyStructuredEdit = utilsModule.applyStructuredEdit;

		const markdowns: string[] = [];
		const buttons: string[] = [];
		const applyCalls: Array<{ code: string; filePath?: string; language?: string }> = [];
		const structuredApplyCalls: Array<{ path: string; intent: "create" | "replace"; content?: string }> = [];

		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model: vscode.LanguageModelChatInformation,
			messages: readonly vscode.LanguageModelChatRequestMessage[],
			_options: vscode.ProvideLanguageModelChatResponseOptions,
			progress: vscode.Progress<vscode.LanguageModelResponsePart>
		) {
			capturedRequestMessages = messages;
			progress.report(
				new vscode.LanguageModelTextPart(
					'```litellm-edit\n{"edits":[{"path":"src/auto-apply-target.ts","intent":"replace","language":"ts","content":"export const autoApplyTarget = true;"},{"path":"src/new-file.ts","intent":"create","language":"ts","content":"export const newFile = true;"}]}\n```'
				)
			);
		};

		vscode.workspace.getConfiguration = ((section?: string) => {
			if (section === "litellm-vscode-chat") {
				return {
					get: (key: string, defaultValue?: unknown) => {
						if (key === "autoApplyCodeEdits") {
							return true;
						}
						return defaultValue;
					},
					update: async () => {},
				} as unknown as vscode.WorkspaceConfiguration;
			}
			return originalGetConfiguration(section);
		}) as unknown as typeof vscode.workspace.getConfiguration;

		utilsModule.applyCodeEdit = (async (code: string, filePath?: string, _range?: vscode.Range, language?: string) => {
			applyCalls.push({ code, filePath, language });
			return vscode.Uri.file(filePath ?? "f:/Vscode/litellm-chat-for-vscode/Suggested Edit.txt");
		}) as typeof utilsModule.applyCodeEdit;

		utilsModule.applyStructuredEdit = (async (edit) => {
			structuredApplyCalls.push({ path: edit.path, intent: edit.intent, content: edit.content });
			return vscode.Uri.file(`f:/Vscode/litellm-chat-for-vscode/${edit.path}`);
		}) as typeof utilsModule.applyStructuredEdit;

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x")) {
				return "Dismiss" as never;
			}
			if (message.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		assert.ok(fallbackParticipantHandler, "Expected fallback participant handler to be captured");
		await fallbackParticipantHandler?.(
			{
				prompt: "Please apply this update",
				references: [],
			} as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: (value: string) => markdowns.push(value),
				progress: () => {},
				button: (command: vscode.Command) => buttons.push(command.title),
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		await Promise.resolve();
		await Promise.resolve();

		const batch = state.get("litellm.pendingEditBatch") as
			| { edits: Array<{ path: string; status: string; id: string; intent: "create" | "replace" }> }
			| undefined;
		assert.ok(batch, "Expected staged edit batch to be saved");
		assert.equal(batch?.edits.length, 2);
		assert.ok(batch?.edits.every((edit) => edit.status === "pending"));
		assert.ok(markdowns.some((value) => value.includes("Staged edits: 2 files")));
		assert.ok(buttons.includes("Apply Staged Edits"));
		assert.ok(buttons.includes("Discard Staged Edits"));
		assert.ok(buttons.some((title) => title.includes("Preview src/auto-apply-target.ts")));
		assert.equal(applyCalls.length, 0, "Preview/apply should not run during staging");
		assert.equal(structuredApplyCalls.length, 0, "Structured edits should not auto-apply during staging");

		const previewCommand = commandHandlers.get("litellm.previewPendingEdit");
		assert.ok(previewCommand, "Expected preview command to be registered");
		await previewCommand?.(batch?.edits[0].id);
		assert.ok(applyCalls.some((call) => !call.filePath && call.code.includes("autoApplyTarget")));

		const acceptCommand = commandHandlers.get("litellm.acceptPendingEdit");
		const rejectCommand = commandHandlers.get("litellm.rejectPendingEdit");
		assert.ok(acceptCommand && rejectCommand, "Expected accept/reject commands to be registered");
		await acceptCommand?.(batch?.edits[0].id);
		await rejectCommand?.(batch?.edits[1].id);

		const applyBatchCommand = commandHandlers.get("litellm.applyStagedEdits");
		assert.ok(applyBatchCommand, "Expected apply staged edits command to be registered");
		await applyBatchCommand?.();

		assert.ok(
			structuredApplyCalls.some((call) => call.path.replace(/\\/g, "/").endsWith("src/auto-apply-target.ts")),
			`Expected accepted staged edit to be applied, got: ${JSON.stringify(structuredApplyCalls)}`
		);
		assert.ok(structuredApplyCalls.some((call) => call.intent === "replace"));
		assert.ok(structuredApplyCalls.some((call) => call.content?.includes("autoApplyTarget")));
		assert.equal(
			structuredApplyCalls.some((call) => call.path.replace(/\\/g, "/").endsWith("src/new-file.ts")),
			false,
			"Rejected staged edits should not be batch-applied"
		);

		utilsModule.applyCodeEdit = originalApplyCodeEdit;
		utilsModule.applyStructuredEdit = originalApplyStructuredEdit;
	});

	test("path-required policy blocks untargeted code-block auto-apply", async () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const utilsModule = require("../utils") as {
			applyCodeEdit: (code: string, filePath?: string, range?: vscode.Range, language?: string) => Promise<vscode.Uri>;
		};
		const originalApplyCodeEdit = utilsModule.applyCodeEdit;
		const applyCalls: Array<{ code: string; filePath?: string }> = [];

		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model,
			messages,
			_options,
			progress
		) {
			capturedRequestMessages = messages;
			progress.report(new vscode.LanguageModelTextPart("```ts\nexport const unsafeWrite = true;\n```"));
		};

		vscode.workspace.getConfiguration = ((section?: string) => {
			if (section === "litellm-vscode-chat") {
				return {
					get: (key: string, defaultValue?: unknown) => {
						if (key === "autoApplyCodeEdits") {
							return true;
						}
						if (key === "fallbackEditPolicy.pathRequired") {
							return true;
						}
						return defaultValue;
					},
					update: async () => {},
				} as unknown as vscode.WorkspaceConfiguration;
			}
			return originalGetConfiguration(section);
		}) as unknown as typeof vscode.workspace.getConfiguration;

		utilsModule.applyCodeEdit = (async (code: string, filePath?: string) => {
			applyCalls.push({ code, filePath });
			return vscode.Uri.file(filePath ?? "f:/Vscode/litellm-chat-for-vscode/unsafe.ts");
		}) as typeof utilsModule.applyCodeEdit;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		await fallbackParticipantHandler?.(
			{ prompt: "Return a code block", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: () => {},
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		await Promise.resolve();
		assert.equal(applyCalls.length, 0, "Untargeted code-block edit should be blocked when pathRequired=true");
		utilsModule.applyCodeEdit = originalApplyCodeEdit;
	});

	test("workspace-only and max-files-per-response policies reject staged structured edits", async () => {
		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model,
			messages,
			_options,
			progress
		) {
			capturedRequestMessages = messages;
			progress.report(
				new vscode.LanguageModelTextPart(
					'```litellm-edit\n{"edits":[{"path":"C:/outside.ts","intent":"replace","content":"outside"},{"path":"src/inside.ts","intent":"replace","content":"inside"}]}\n```'
				)
			);
		};

		vscode.workspace.getConfiguration = ((section?: string) => {
			if (section === "litellm-vscode-chat") {
				return {
					get: (key: string, defaultValue?: unknown) => {
						if (key === "fallbackEditPolicy.workspaceOnly") {
							return true;
						}
						if (key === "fallbackEditPolicy.maxFilesPerResponse") {
							return 1;
						}
						return defaultValue;
					},
					update: async () => {},
				} as unknown as vscode.WorkspaceConfiguration;
			}
			return originalGetConfiguration(section);
		}) as unknown as typeof vscode.workspace.getConfiguration;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		await fallbackParticipantHandler?.(
			{ prompt: "Stage two edits", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: () => {},
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		const batch = state.get("litellm.pendingEditBatch") as
			| { edits: Array<{ status: string; error?: string }> }
			| undefined;
		assert.ok(batch);
		assert.equal(batch?.edits.length, 2);
		assert.ok(batch?.edits.every((edit) => edit.status === "rejected"));
		assert.ok(batch?.edits.every((edit) => edit.error?.includes("maxFilesPerResponse=1")));
	});

	test("same-file-only policy rejects staged edits outside active file", async () => {
		const originalActiveTextEditorDescriptor = Object.getOwnPropertyDescriptor(vscode.window, "activeTextEditor");

		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model,
			messages,
			_options,
			progress
		) {
			capturedRequestMessages = messages;
			progress.report(
				new vscode.LanguageModelTextPart(
					'```litellm-edit\n{"path":"src/other.ts","intent":"replace","content":"export const other = true;"}\n```'
				)
			);
		};

		Object.defineProperty(vscode.window, "activeTextEditor", {
			configurable: true,
			get: () =>
				({
					document: {
						uri: vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode/src/current.ts"),
					} as vscode.TextDocument,
				}) as vscode.TextEditor,
		});

		vscode.workspace.getConfiguration = ((section?: string) => {
			if (section === "litellm-vscode-chat") {
				return {
					get: (key: string, defaultValue?: unknown) => {
						if (key === "fallbackEditPolicy.sameFileOnly") {
							return true;
						}
						return defaultValue;
					},
					update: async () => {},
				} as unknown as vscode.WorkspaceConfiguration;
			}
			return originalGetConfiguration(section);
		}) as unknown as typeof vscode.workspace.getConfiguration;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		await fallbackParticipantHandler?.(
			{ prompt: "Stage one edit", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: () => {},
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		const batch = state.get("litellm.pendingEditBatch") as
			| { edits: Array<{ status: string; error?: string }> }
			| undefined;
		assert.ok(batch);
		assert.equal(batch?.edits[0].status, "rejected");
		assert.ok(batch?.edits[0].error?.includes("does not match the active file"));

		if (originalActiveTextEditorDescriptor) {
			Object.defineProperty(vscode.window, "activeTextEditor", originalActiveTextEditorDescriptor);
		}
	});

	test("fallback resolves code block edit target from single attached reference", async () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const utilsModule = require("../utils") as {
			applyCodeEdit: (code: string, filePath?: string, range?: vscode.Range, language?: string) => Promise<vscode.Uri>;
		};
		const originalApplyCodeEdit = utilsModule.applyCodeEdit;
		const applyCalls: Array<{ code: string; filePath?: string }> = [];

		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model,
			messages,
			_options,
			progress
		) {
			capturedRequestMessages = messages;
			// Code block with NO path — should be applied to the single attached reference
			progress.report(new vscode.LanguageModelTextPart("```ts\nconst improved = true;\n```"));
		};

		vscode.workspace.getConfiguration = ((section?: string) => {
			if (section === "litellm-vscode-chat") {
				return {
					get: (key: string, defaultValue?: unknown) => {
						if (key === "autoApplyCodeEdits") {
							return true;
						}
						return defaultValue;
					},
					update: async () => {},
				} as unknown as vscode.WorkspaceConfiguration;
			}
			return originalGetConfiguration(section);
		}) as unknown as typeof vscode.workspace.getConfiguration;

		utilsModule.applyCodeEdit = (async (code: string, filePath?: string) => {
			applyCalls.push({ code, filePath });
			return vscode.Uri.file(filePath ?? "f:/Vscode/litellm-chat-for-vscode/Suggested Edit.ts");
		}) as typeof utilsModule.applyCodeEdit;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		const referenceUri = vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode/src/extension.ts");

		await fallbackParticipantHandler?.(
			{
				prompt: "Improve this file",
				references: [{ id: "file1", value: referenceUri, modelDescription: "extension.ts" }],
			} as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: () => {},
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		await Promise.resolve();
		await Promise.resolve();

		assert.ok(
			applyCalls.some((call) => call.filePath && call.filePath.replace(/\\/g, "/").includes("src/extension.ts")),
			`Expected code block to be applied to the attached reference. Got: ${JSON.stringify(applyCalls)}`
		);

		utilsModule.applyCodeEdit = originalApplyCodeEdit;
	});

	test("fallback resolves structured edit path from context reference suffix match", async () => {
		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model,
			messages,
			_options,
			progress
		) {
			capturedRequestMessages = messages;
			// Model emits "src/utils.ts" but user has a deeper path "packages/core/src/utils.ts" attached
			progress.report(
				new vscode.LanguageModelTextPart(
					'```litellm-edit\n{"path":"src/utils.ts","intent":"replace","content":"export const resolved = true;"}\n```'
				)
			);
		};

		vscode.workspace.getConfiguration = ((section?: string) => {
			if (section === "litellm-vscode-chat") {
				return {
					get: (_key: string, defaultValue?: unknown) => defaultValue,
					update: async () => {},
				} as unknown as vscode.WorkspaceConfiguration;
			}
			return originalGetConfiguration(section);
		}) as unknown as typeof vscode.workspace.getConfiguration;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		// Reference at a deeper path that ends with "src/utils.ts" (suffix match case)
		const referenceUri = vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode/packages/core/src/utils.ts");

		await fallbackParticipantHandler?.(
			{
				prompt: "Update utils",
				references: [{ id: "file1", value: referenceUri, modelDescription: "utils.ts" }],
			} as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: () => {},
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		const batch = state.get("litellm.pendingEditBatch") as
			| { edits: Array<{ path: string; status: string }> }
			| undefined;
		assert.ok(batch, "Expected staged edit batch");
		assert.equal(batch?.edits.length, 1);
		// Core assertion: the path was resolved via the context reference (includes packages/core/src/utils.ts),
		// not the direct workspace-root join of src/utils.ts
		assert.ok(
			batch?.edits[0].path.replace(/\\/g, "/").toLowerCase().includes("packages/core/src/utils.ts"),
			`Expected path to be resolved via reference suffix match. Got: '${batch?.edits[0].path}'`
		);
	});

	test("/tool-mode required stores override and tool name", async () => {
		const markdowns: string[] = [];

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([["litellm.hasShownWelcome", true]]);
		activate(createMockContext(state));

		await fallbackParticipantHandler?.(
			{ prompt: "/tool-mode required list_dir", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: (value: string) => markdowns.push(value),
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		const workflowState = state.get("litellm.fallbackWorkflowState") as
			| { toolModeOverride?: string; requiredToolName?: string }
			| undefined;
		assert.equal(workflowState?.toolModeOverride, "required");
		assert.equal(workflowState?.requiredToolName, "list_dir");
		assert.ok(markdowns.some((value) => value.includes("required")));
	});

	test("/tool-mode none sends request without tools", async () => {
		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x") || message.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		const stream = {
			markdown: () => {},
			progress: () => {},
			button: () => {},
			anchor: () => {},
			filetree: () => {},
			push: () => {},
		} as unknown as vscode.ChatResponseStream;

		await fallbackParticipantHandler?.(
			{ prompt: "/tool-mode none", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			new vscode.CancellationTokenSource().token
		);

		await fallbackParticipantHandler?.(
			{ prompt: "Run a normal prompt", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			new vscode.CancellationTokenSource().token
		);

		assert.ok(capturedRequestOptions, "Expected request options to be captured");
		assert.equal(capturedRequestOptions?.tools?.length ?? 0, 0);
		assert.equal(capturedRequestOptions?.toolMode, vscode.LanguageModelChatToolMode.Auto);
	});

	test("/tool-mode required sends exactly one required tool", async () => {
		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x") || message.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		const stream = {
			markdown: () => {},
			progress: () => {},
			button: () => {},
			anchor: () => {},
			filetree: () => {},
			push: () => {},
		} as unknown as vscode.ChatResponseStream;

		await fallbackParticipantHandler?.(
			{ prompt: "/tool-mode required list_dir", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			new vscode.CancellationTokenSource().token
		);

		await fallbackParticipantHandler?.(
			{ prompt: "Run a normal prompt", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			new vscode.CancellationTokenSource().token
		);

		assert.ok(capturedRequestOptions, "Expected request options to be captured");
		assert.equal(capturedRequestOptions?.toolMode, vscode.LanguageModelChatToolMode.Required);
		assert.equal(capturedRequestOptions?.tools?.length, 1);
		assert.equal(capturedRequestOptions?.tools?.[0].name, "list_dir");
	});

	test("/model command updates selected fallback model", async () => {
		const markdowns: string[] = [];

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		await fallbackParticipantHandler?.(
			{ prompt: "/model claude-code-sonnet-4-6:cheapest", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: (value: string) => markdowns.push(value),
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		assert.equal(state.get("litellm.selectedChatModel"), "claude-code-sonnet-4-6:cheapest");
		assert.ok(markdowns.some((value) => value.includes("Fallback model set to")));
	});

	test("request-time controls override model options for fallback request", async () => {
		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x") || message.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		const stream = {
			markdown: () => {},
			progress: () => {},
			button: () => {},
			anchor: () => {},
			filetree: () => {},
			push: () => {},
		} as unknown as vscode.ChatResponseStream;

		await fallbackParticipantHandler?.(
			{ prompt: "/temperature 0.4", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			new vscode.CancellationTokenSource().token
		);
		await fallbackParticipantHandler?.(
			{ prompt: "/tokens 2048", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			new vscode.CancellationTokenSource().token
		);
		await fallbackParticipantHandler?.(
			{ prompt: "/stop END|DONE", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			new vscode.CancellationTokenSource().token
		);

		await fallbackParticipantHandler?.(
			{ prompt: "Run a normal prompt", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			stream,
			new vscode.CancellationTokenSource().token
		);

		assert.ok(capturedRequestOptions, "Expected request options to be captured");
		const modelOptions = (capturedRequestOptions?.modelOptions ?? {}) as Record<string, unknown>;
		assert.equal(modelOptions.temperature, 0.4);
		assert.equal(modelOptions.max_tokens, 2048);
		assert.deepEqual(modelOptions.stop, ["END", "DONE"]);
	});

	test("/edit-status shows pending edit summary and suggested actions", async () => {
		const markdowns: string[] = [];

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x") || message.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			[
				"litellm.pendingEditBatch",
				{
					id: "batch-1",
					createdAt: Date.now(),
					edits: [
						{
							id: "e1",
							path: "src/a.ts",
							intent: "replace",
							content: "export const a = 1;",
							status: "pending",
						},
					],
				},
			],
		]);
		activate(createMockContext(state));

		await fallbackParticipantHandler?.(
			{ prompt: "/edit-status", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: (value: string) => markdowns.push(value),
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		const rendered = markdowns.join("\n");
		assert.ok(rendered.includes("Staged edits:"));
		assert.ok(rendered.includes("Suggested next actions:"));
		assert.ok(rendered.includes("/edit-status"));
	});

	test("/tool-status includes recent history and suggested actions", async () => {
		const markdowns: string[] = [];

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			[
				"litellm.fallbackWorkflowState",
				{
					notes: [],
					loopEnabled: false,
					pendingApproval: false,
					checkpoints: [],
					toolCalls: [
						{
							id: "tc1",
							name: "read_file",
							arguments: {},
							status: "executed",
							createdAt: Date.now() - 1000,
							executedAt: Date.now() - 500,
							result: "line 1",
						},
					],
					updatedAt: Date.now(),
				},
			],
		]);
		activate(createMockContext(state));

		await fallbackParticipantHandler?.(
			{ prompt: "/tool-status", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: (value: string) => markdowns.push(value),
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		const rendered = markdowns.join("\n");
		assert.ok(rendered.includes("Summary:"));
		assert.ok(rendered.includes("Recent tool history:"));
		assert.ok(rendered.includes("Suggested next actions:"));
	});

	test("fallback telemetry increments approvalRejects on /tool-reject", async () => {
		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const now = Date.now();
		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			[
				"litellm.fallbackWorkflowState",
				{
					notes: [],
					loopEnabled: false,
					pendingApproval: false,
					checkpoints: [],
					toolCalls: [
						{
							id: "pending-tool-1",
							name: "read_file",
							arguments: { path: "src/extension.ts" },
							status: "pending",
							createdAt: now,
						},
					],
					pendingToolCallId: "pending-tool-1",
					updatedAt: now,
				},
			],
		]);
		activate(createMockContext(state));

		await fallbackParticipantHandler?.(
			{ prompt: "/tool-reject", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: () => {},
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		const telemetry = state.get("litellm.fallbackTelemetry") as { approvalRejects?: number } | undefined;
		assert.equal(telemetry?.approvalRejects, 1);
	});

	test("fallback packages image attachment context and capability warning for non-vision model", async () => {
		const markdowns: string[] = [];

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x") || message.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		await fallbackParticipantHandler?.(
			{
				prompt: "Analyze screenshot and suggest fix",
				references: [
					{
						id: "image-ref",
						value: vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode/assets/bug.png"),
						modelDescription: "Screenshot showing misaligned header",
					},
				],
			} as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: (value: string) => markdowns.push(value),
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		assert.ok(capturedRequestMessages && capturedRequestMessages.length > 0);
		const lastMessage = capturedRequestMessages?.[capturedRequestMessages.length - 1];
		const promptText = (lastMessage?.content ?? [])
			.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ""))
			.join("\n");
		assert.ok(promptText.includes("Attachment summary:"));
		assert.ok(promptText.includes("Images: 1"));
		assert.ok(promptText.includes("Capability note:"));
		assert.ok(promptText.includes("does not advertise image input"));
		assert.ok(markdowns.some((value) => value.includes("Attachment capability:")));
	});

	test("multi-file staged edits can be accepted and batch-applied", async () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const utilsModule = require("../utils") as {
			applyStructuredEdit: (edit: {
				id: string;
				path: string;
				intent: "create" | "replace";
				content?: string;
				language?: string;
			}) => Promise<vscode.Uri>;
		};
		const originalApplyStructuredEdit = utilsModule.applyStructuredEdit;
		const structuredApplyCalls: string[] = [];

		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model,
			messages,
			_options,
			progress
		) {
			capturedRequestMessages = messages;
			progress.report(
				new vscode.LanguageModelTextPart(
					'```litellm-edit\n{"edits":[{"path":"src/a.ts","intent":"replace","content":"export const a = 1;"},{"path":"src/b.ts","intent":"replace","content":"export const b = 2;"}]}\n```'
				)
			);
		};

		utilsModule.applyStructuredEdit = (async (edit) => {
			structuredApplyCalls.push(edit.path);
			return vscode.Uri.file(`f:/Vscode/litellm-chat-for-vscode/${edit.path}`);
		}) as typeof utilsModule.applyStructuredEdit;

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x") || message.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		await fallbackParticipantHandler?.(
			{ prompt: "Stage two file updates", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: () => {},
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		const batch = state.get("litellm.pendingEditBatch") as
			| { edits: Array<{ id: string; path: string; status: string }> }
			| undefined;
		assert.ok(batch && batch.edits.length === 2);

		const acceptCommand = commandHandlers.get("litellm.acceptPendingEdit");
		const applyBatchCommand = commandHandlers.get("litellm.applyStagedEdits");
		assert.ok(acceptCommand && applyBatchCommand);
		await acceptCommand?.(batch?.edits[0].id);
		await acceptCommand?.(batch?.edits[1].id);
		await applyBatchCommand?.();

		assert.equal(structuredApplyCalls.length, 2);
		assert.ok(structuredApplyCalls.some((path) => path.endsWith("src/a.ts")));
		assert.ok(structuredApplyCalls.some((path) => path.endsWith("src/b.ts")));

		utilsModule.applyStructuredEdit = originalApplyStructuredEdit;
	});

	test("malformed structured edit model output does not crash or stage invalid edits", async () => {
		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model,
			messages,
			_options,
			progress
		) {
			capturedRequestMessages = messages;
			progress.report(
				new vscode.LanguageModelTextPart(
					'```litellm-edit\n{"edits":[{"path":"src/a.ts","intent":"replace","content":"broken"}\n```'
				)
			);
		};

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x") || message.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		await fallbackParticipantHandler?.(
			{ prompt: "Parse malformed edit response", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: () => {},
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		const batch = state.get("litellm.pendingEditBatch") as { edits: unknown[] } | undefined;
		assert.equal(batch, undefined, "Malformed edit envelope should not stage pending edits");
	});

	test("path ambiguity with multiple matching references resolves deterministically to first context path", async () => {
		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model,
			messages,
			_options,
			progress
		) {
			capturedRequestMessages = messages;
			progress.report(
				new vscode.LanguageModelTextPart(
					'```litellm-edit\n{"path":"src/utils.ts","intent":"replace","content":"export const resolved = true;"}\n```'
				)
			);
		};

		vscode.workspace.getConfiguration = ((section?: string) => {
			if (section === "litellm-vscode-chat") {
				return {
					get: (_key: string, defaultValue?: unknown) => defaultValue,
					update: async () => {},
				} as unknown as vscode.WorkspaceConfiguration;
			}
			return originalGetConfiguration(section);
		}) as unknown as typeof vscode.workspace.getConfiguration;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
		]);
		activate(createMockContext(state));

		const refA = vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode/packages/a/src/utils.ts");
		const refB = vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode/packages/b/src/utils.ts");

		await fallbackParticipantHandler?.(
			{
				prompt: "Update utils implementation",
				references: [
					{ id: "a", value: refA, modelDescription: "a utils" },
					{ id: "b", value: refB, modelDescription: "b utils" },
				],
			} as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: () => {},
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		const batch = state.get("litellm.pendingEditBatch") as
			| { edits: Array<{ path: string; status: string }> }
			| undefined;
		assert.ok(batch && batch.edits.length === 1);
		assert.ok(
			batch?.edits[0].path.replace(/\\/g, "/").toLowerCase().includes("packages/a/src/utils.ts"),
			`Expected deterministic first-context resolution. Got '${batch?.edits[0].path}'`
		);
	});

	test("approval gate blocks loop-step without invoking model response", async () => {
		let modelCalls = 0;
		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model,
			_messages,
			_options,
			progress
		) {
			modelCalls++;
			progress.report(new vscode.LanguageModelTextPart("Should not run while approval gate is active."));
		};

		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const message = String(args[0] ?? "");
			if (message.includes("On VS Code 1.103.x")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			[
				"litellm.fallbackWorkflowState",
				{
					goal: "Guarded loop",
					notes: [],
					loopEnabled: true,
					pendingApproval: true,
					checkpoints: [],
					toolCalls: [],
					updatedAt: Date.now(),
				},
			],
		]);
		activate(createMockContext(state));

		await fallbackParticipantHandler?.(
			{ prompt: "/loop-step do work", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			{
				markdown: () => {},
				progress: () => {},
				button: () => {},
				anchor: () => {},
				filetree: () => {},
				push: () => {},
			} as unknown as vscode.ChatResponseStream,
			new vscode.CancellationTokenSource().token
		);

		assert.equal(modelCalls, 0, "Model response should not run while approval gate is active");
	});
});

suite("tool-loop commands", () => {
	// Reuse shared infrastructure from extension/fallback commands
	const commandHandlers2 = new Map<string, (...args: unknown[]) => unknown>();
	let fallbackHandler2:
		| ((
				request: vscode.ChatRequest,
				chatContext: vscode.ChatContext,
				stream: vscode.ChatResponseStream,
				token: vscode.CancellationToken
		  ) => Promise<vscode.ChatResult | void>)
		| undefined;
	let originalRegisterCommand2: typeof vscode.commands.registerCommand;
	let originalCreateOutputChannel2: typeof vscode.window.createOutputChannel;
	let originalCreateStatusBarItem2: typeof vscode.window.createStatusBarItem;
	let originalCreateChatParticipant2: typeof vscode.chat.createChatParticipant;
	let originalGetConfiguration2: typeof vscode.workspace.getConfiguration;
	let originalPrepareInfo2: LiteLLMChatModelProvider["prepareLanguageModelChatInformation"];
	let originalProvideResponse2: LiteLLMChatModelProvider["provideLanguageModelChatResponse"];
	let originalLmApi2: unknown;
	let originalGetExtension2: typeof vscode.extensions.getExtension;

	const createCtx2 = (store: Map<string, unknown>): vscode.ExtensionContext =>
		({
			subscriptions: [],
			workspaceState: {
				get: (_key: string, dv?: unknown) => dv,
				update: async () => {},
				keys: () => [],
			} as unknown as vscode.Memento,
			globalState: {
				get: <T>(key: string, dv?: T) => (store.has(key) ? (store.get(key) as T) : (dv as T)),
				update: async (key: string, value: unknown) => {
					store.set(key, value);
				},
				keys: () => Array.from(store.keys()),
				setKeysForSync: () => {},
			} as unknown as vscode.Memento,
			secrets: {
				get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
				store: async () => {},
				delete: async () => {},
				onDidChange: () => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage,
			extensionUri: vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode"),
			extensionPath: "f:/Vscode/litellm-chat-for-vscode",
			environmentVariableCollection: {} as unknown as vscode.GlobalEnvironmentVariableCollection,
			storageUri: undefined,
			storagePath: undefined,
			globalStorageUri: vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode/.global-storage"),
			globalStoragePath: "f:/Vscode/litellm-chat-for-vscode/.global-storage",
			logUri: vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode/.log"),
			logPath: "f:/Vscode/litellm-chat-for-vscode/.log",
			extensionMode: vscode.ExtensionMode.Test,
			extension: {} as vscode.Extension<unknown>,
			asAbsolutePath: (p: string) => `f:/Vscode/litellm-chat-for-vscode/${p}`,
			languageModelAccessInformation: {
				onDidChange: () => ({ dispose() {} }),
				canSendRequest: () => true,
			} as unknown as vscode.LanguageModelAccessInformation,
		}) as unknown as vscode.ExtensionContext;

	setup(() => {
		commandHandlers2.clear();
		fallbackHandler2 = undefined;
		originalRegisterCommand2 = vscode.commands.registerCommand;
		originalCreateOutputChannel2 = vscode.window.createOutputChannel;
		originalCreateStatusBarItem2 = vscode.window.createStatusBarItem;
		originalCreateChatParticipant2 = vscode.chat.createChatParticipant;
		originalGetConfiguration2 = vscode.workspace.getConfiguration;
		originalPrepareInfo2 = LiteLLMChatModelProvider.prototype.prepareLanguageModelChatInformation;
		originalProvideResponse2 = LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse;
		const lmApi = (vscode as unknown as { lm?: Record<string, unknown> }).lm;
		originalLmApi2 = lmApi?.registerLanguageModelChatProvider;
		originalGetExtension2 = vscode.extensions.getExtension;

		LiteLLMChatModelProvider.prototype.prepareLanguageModelChatInformation = async function () {
			return [
				{
					id: "claude-code-sonnet-4-6:cheapest",
					name: "Claude Sonnet",
					family: "litellm",
					version: "1.0.0",
					maxInputTokens: 200000,
					maxOutputTokens: 16000,
					capabilities: {},
				} as unknown as vscode.LanguageModelChatInformation,
			];
		};

		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model: vscode.LanguageModelChatInformation,
			_messages: readonly vscode.LanguageModelChatRequestMessage[],
			_options: vscode.ProvideLanguageModelChatResponseOptions,
			progress: vscode.Progress<vscode.LanguageModelResponsePart>
		) {
			progress.report(new vscode.LanguageModelTextPart("Done."));
		};

		vscode.commands.registerCommand = ((command: string, cb: (...args: unknown[]) => unknown) => {
			commandHandlers2.set(command, cb);
			return { dispose() {} };
		}) as unknown as typeof vscode.commands.registerCommand;

		vscode.window.createOutputChannel = (() => ({
			appendLine: () => {},
			show: () => {},
			dispose: () => {},
		})) as unknown as typeof vscode.window.createOutputChannel;

		vscode.window.createStatusBarItem = (() => ({
			text: "",
			tooltip: "",
			backgroundColor: undefined,
			command: undefined,
			show: () => {},
			dispose: () => {},
		})) as unknown as typeof vscode.window.createStatusBarItem;

		vscode.chat.createChatParticipant = ((_id: string, handler: unknown) => {
			fallbackHandler2 = handler as typeof fallbackHandler2;
			return { iconPath: undefined, onDidReceiveFeedback: { dispose() {} }, dispose: () => {} };
		}) as unknown as typeof vscode.chat.createChatParticipant;

		vscode.workspace.getConfiguration = ((section?: string) => {
			if (section === "litellm-vscode-chat") {
				return {
					get: (_key: string, dv?: unknown) => dv,
					update: async () => {},
				} as unknown as vscode.WorkspaceConfiguration;
			}
			return originalGetConfiguration2(section);
		}) as unknown as typeof vscode.workspace.getConfiguration;

		if (lmApi && typeof lmApi === "object") {
			lmApi.registerLanguageModelChatProvider = () => ({ dispose() {} });
		}

		vscode.extensions.getExtension = (() => ({
			packageJSON: { version: "test" },
		})) as unknown as typeof vscode.extensions.getExtension;
	});

	teardown(() => {
		vscode.commands.registerCommand = originalRegisterCommand2;
		vscode.window.createOutputChannel = originalCreateOutputChannel2;
		vscode.window.createStatusBarItem = originalCreateStatusBarItem2;
		vscode.chat.createChatParticipant = originalCreateChatParticipant2;
		vscode.workspace.getConfiguration = originalGetConfiguration2;
		LiteLLMChatModelProvider.prototype.prepareLanguageModelChatInformation = originalPrepareInfo2;
		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = originalProvideResponse2;
		const lmApi = (vscode as unknown as { lm?: Record<string, unknown> }).lm;
		if (lmApi && typeof lmApi === "object") {
			lmApi.registerLanguageModelChatProvider = originalLmApi2;
		}
		vscode.extensions.getExtension = originalGetExtension2;
	});

	const makeStream = (markdowns: string[], progresses: string[]) =>
		({
			markdown: (v: string) => markdowns.push(v),
			progress: (v: unknown) => progresses.push(String(v ?? "")),
			button: () => {},
			anchor: () => {},
			filetree: () => {},
			push: () => {},
		}) as unknown as vscode.ChatResponseStream;

	const stubInfoMessage = () => {
		vscode.window.showInformationMessage = (async (...args: unknown[]) => {
			const msg = String(args[0] ?? "");
			if (msg.includes("On VS Code 1.103.x") || msg.includes("fallback chat is ready")) {
				return "Dismiss" as never;
			}
			return undefined as never;
		}) as unknown as typeof vscode.window.showInformationMessage;
	};

	const stubExecCommand = () => {
		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			const handler = commandHandlers2.get(command);
			if (handler) {
				return await handler(...args);
			}
			return undefined;
		}) as unknown as typeof vscode.commands.executeCommand;
	};

	test("/tool-loop start saves state and reports configuration", async () => {
		stubInfoMessage();
		stubExecCommand();
		const state = new Map<string, unknown>([["litellm.hasShownWelcome", true]]);
		activate(createCtx2(state));

		const markdowns: string[] = [];
		await fallbackHandler2?.(
			{
				prompt: "/tool-loop start --steps 5 --retries 2 --checkpoint 3 Fix all tests",
				references: [],
			} as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			makeStream(markdowns, []),
			new vscode.CancellationTokenSource().token
		);

		const ws = state.get("litellm.fallbackWorkflowState") as Record<string, unknown> | undefined;
		assert.ok(ws, "Expected workflow state to be saved");
		assert.equal(ws?.toolLoopActive, true);
		assert.equal(ws?.toolLoopGoal, "Fix all tests");
		assert.equal(ws?.toolLoopStepCap, 5);
		assert.equal(ws?.toolLoopRetryLimit, 2);
		assert.equal(ws?.toolLoopCheckpointInterval, 3);
		assert.equal(ws?.toolLoopStepsRun, 0);
		assert.ok(markdowns.some((m) => m.includes("Tool loop started")));
		assert.ok(markdowns.some((m) => m.includes("Step cap") && m.includes("5")));
	});

	test("/tool-loop start without goal shows usage message", async () => {
		stubInfoMessage();
		stubExecCommand();
		const state = new Map<string, unknown>([["litellm.hasShownWelcome", true]]);
		activate(createCtx2(state));

		const markdowns: string[] = [];
		await fallbackHandler2?.(
			{ prompt: "/tool-loop start", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			makeStream(markdowns, []),
			new vscode.CancellationTokenSource().token
		);

		// No state should be saved
		assert.ok(markdowns.some((m) => m.includes("Provide a goal")));
	});

	test("/tool-loop stop emits exit summary and clears toolLoopActive", async () => {
		stubInfoMessage();
		stubExecCommand();
		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			[
				"litellm.fallbackWorkflowState",
				{
					notes: [],
					loopEnabled: false,
					pendingApproval: false,
					checkpoints: [],
					toolCalls: [],
					toolLoopActive: true,
					toolLoopGoal: "Refactor utils",
					toolLoopStepCap: 10,
					toolLoopStepsRun: 4,
					toolLoopConsecutiveFailures: 1,
					updatedAt: Date.now(),
				},
			],
		]);
		activate(createCtx2(state));

		const markdowns: string[] = [];
		await fallbackHandler2?.(
			{ prompt: "/tool-loop stop", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			makeStream(markdowns, []),
			new vscode.CancellationTokenSource().token
		);

		const ws = state.get("litellm.fallbackWorkflowState") as Record<string, unknown> | undefined;
		assert.ok(!ws?.toolLoopActive, "toolLoopActive should be false after stop");
		assert.ok(markdowns.some((m) => m.includes("Tool loop stopped")));
		assert.ok(markdowns.some((m) => m.includes('"reason": "stopped"')));
		assert.ok(markdowns.some((m) => m.includes('"stepsRun": 4')));
	});

	test("/tool-loop status shows current progress", async () => {
		stubInfoMessage();
		stubExecCommand();
		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			[
				"litellm.fallbackWorkflowState",
				{
					notes: [],
					loopEnabled: false,
					pendingApproval: false,
					checkpoints: [],
					toolCalls: [],
					toolLoopActive: true,
					toolLoopGoal: "Ship feature X",
					toolLoopStepCap: 8,
					toolLoopRetryLimit: 2,
					toolLoopCheckpointInterval: 4,
					toolLoopStepsRun: 3,
					toolLoopConsecutiveFailures: 0,
					updatedAt: Date.now(),
				},
			],
		]);
		activate(createCtx2(state));

		const markdowns: string[] = [];
		await fallbackHandler2?.(
			{ prompt: "/tool-loop status", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			makeStream(markdowns, []),
			new vscode.CancellationTokenSource().token
		);

		assert.ok(markdowns.some((m) => m.includes("Ship feature X")));
		assert.ok(markdowns.some((m) => m.includes("3/8")));
		assert.ok(markdowns.some((m) => m.includes("0/2")));
	});

	test("/tool-loop status with no active loop shows informational message", async () => {
		stubInfoMessage();
		stubExecCommand();
		const state = new Map<string, unknown>([["litellm.hasShownWelcome", true]]);
		activate(createCtx2(state));

		const markdowns: string[] = [];
		await fallbackHandler2?.(
			{ prompt: "/tool-loop status", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			makeStream(markdowns, []),
			new vscode.CancellationTokenSource().token
		);

		assert.ok(markdowns.some((m) => m.includes("No tool loop")));
	});

	test("tool loop auto-executes tool call and emits step result", async () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const utilsModule = require("../utils") as {
			executeFallbackTool: typeof import("../utils").executeFallbackTool;
			formatToolResult: typeof import("../utils").formatToolResult;
		};
		const originalExecute = utilsModule.executeFallbackTool;
		const execCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

		utilsModule.executeFallbackTool = (async (name: string, args: Record<string, unknown>) => {
			execCalls.push({ name, args });
			return { success: true, output: `Result of ${name}`, meta: { tool: name as "execute_command" } };
		}) as typeof utilsModule.executeFallbackTool;

		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model: vscode.LanguageModelChatInformation,
			_messages: readonly vscode.LanguageModelChatRequestMessage[],
			_options: vscode.ProvideLanguageModelChatResponseOptions,
			progress: vscode.Progress<vscode.LanguageModelResponsePart>
		) {
			// First call: emit a tool call; subsequent calls: emit only text (loop ends)
			if (execCalls.length === 0) {
				progress.report(new vscode.LanguageModelToolCallPart("tc-1", "execute_command", { command: "ls" }));
			} else {
				progress.report(new vscode.LanguageModelTextPart("All done."));
			}
		};

		stubInfoMessage();
		stubExecCommand();

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
			[
				"litellm.fallbackWorkflowState",
				{
					notes: [],
					loopEnabled: false,
					pendingApproval: false,
					checkpoints: [],
					toolCalls: [],
					toolLoopActive: true,
					toolLoopGoal: "List files",
					toolLoopStepCap: 5,
					toolLoopRetryLimit: 3,
					toolLoopCheckpointInterval: 0,
					toolLoopStepsRun: 0,
					toolLoopConsecutiveFailures: 0,
					updatedAt: Date.now(),
				},
			],
		]);
		activate(createCtx2(state));

		const markdowns: string[] = [];
		const progresses: string[] = [];
		await fallbackHandler2?.(
			{ prompt: "Start working", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			makeStream(markdowns, progresses),
			new vscode.CancellationTokenSource().token
		);

		assert.equal(execCalls.length, 1, "Tool should have been auto-executed once");
		assert.equal(execCalls[0].name, "execute_command");
		assert.ok(
			markdowns.some((m) => m.includes("Loop 1")),
			"Should show loop step marker"
		);
		assert.ok(
			markdowns.some((m) => m.includes("Tool loop ended") && m.includes("done")),
			"Should show loop-ended summary with reason=done"
		);

		const ws = state.get("litellm.fallbackWorkflowState") as Record<string, unknown> | undefined;
		assert.equal(ws?.toolLoopStepsRun, 1, "stepsRun should be updated in state");

		utilsModule.executeFallbackTool = originalExecute;
	});

	test("tool loop supports tool chaining across multiple model turns", async () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const utilsModule = require("../utils") as {
			executeFallbackTool: typeof import("../utils").executeFallbackTool;
		};
		const originalExecute = utilsModule.executeFallbackTool;

		const execCalls: string[] = [];
		utilsModule.executeFallbackTool = (async (name: string, args: Record<string, unknown>) => {
			execCalls.push(`${name}:${JSON.stringify(args)}`);
			return { success: true, output: `ok:${name}`, meta: { tool: name as "execute_command" } };
		}) as typeof utilsModule.executeFallbackTool;

		let modelCallCount = 0;
		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model: vscode.LanguageModelChatInformation,
			_messages: readonly vscode.LanguageModelChatRequestMessage[],
			_options: vscode.ProvideLanguageModelChatResponseOptions,
			progress: vscode.Progress<vscode.LanguageModelResponsePart>
		) {
			modelCallCount++;
			if (modelCallCount === 1) {
				progress.report(new vscode.LanguageModelToolCallPart("tc-1", "execute_command", { command: "step1" }));
				return;
			}
			if (modelCallCount === 2) {
				progress.report(new vscode.LanguageModelToolCallPart("tc-2", "execute_command", { command: "step2" }));
				return;
			}
			progress.report(new vscode.LanguageModelTextPart("Completed chained execution."));
		};

		stubInfoMessage();
		stubExecCommand();

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
			[
				"litellm.fallbackWorkflowState",
				{
					notes: [],
					loopEnabled: false,
					pendingApproval: false,
					checkpoints: [],
					toolCalls: [],
					toolLoopActive: true,
					toolLoopGoal: "Chain two commands",
					toolLoopStepCap: 5,
					toolLoopRetryLimit: 3,
					toolLoopCheckpointInterval: 0,
					toolLoopStepsRun: 0,
					toolLoopConsecutiveFailures: 0,
					updatedAt: Date.now(),
				},
			],
		]);
		activate(createCtx2(state));

		const markdowns: string[] = [];
		await fallbackHandler2?.(
			{ prompt: "Start chaining", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			makeStream(markdowns, []),
			new vscode.CancellationTokenSource().token
		);

		assert.equal(execCalls.length, 2, "Expected two chained tool executions");
		const ws = state.get("litellm.fallbackWorkflowState") as Record<string, unknown> | undefined;
		assert.equal(ws?.toolLoopStepsRun, 2, "Expected loop state to capture two executed steps");
		assert.ok(markdowns.some((m) => m.includes("Tool loop ended") && m.includes("done")));

		utilsModule.executeFallbackTool = originalExecute;
	});

	test("tool loop stops after step cap with reason=cap", async () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const utilsModule = require("../utils") as {
			executeFallbackTool: typeof import("../utils").executeFallbackTool;
		};
		const originalExecute = utilsModule.executeFallbackTool;

		let modelCallCount = 0;
		utilsModule.executeFallbackTool = (async (name: string) => ({
			success: true,
			output: `result of ${name}`,
			meta: { tool: name as "execute_command" },
		})) as typeof utilsModule.executeFallbackTool;

		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model: vscode.LanguageModelChatInformation,
			_messages: readonly vscode.LanguageModelChatRequestMessage[],
			_options: vscode.ProvideLanguageModelChatResponseOptions,
			progress: vscode.Progress<vscode.LanguageModelResponsePart>
		) {
			modelCallCount++;
			// Always emit a tool call — the loop should stop at cap
			progress.report(
				new vscode.LanguageModelToolCallPart(`tc-${modelCallCount}`, "execute_command", {
					command: `cmd${modelCallCount}`,
				})
			);
		};

		stubInfoMessage();
		stubExecCommand();

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
			[
				"litellm.fallbackWorkflowState",
				{
					notes: [],
					loopEnabled: false,
					pendingApproval: false,
					checkpoints: [],
					toolCalls: [],
					toolLoopActive: true,
					toolLoopGoal: "Infinite loop test",
					toolLoopStepCap: 2,
					toolLoopRetryLimit: 10,
					toolLoopCheckpointInterval: 0,
					toolLoopStepsRun: 0,
					toolLoopConsecutiveFailures: 0,
					updatedAt: Date.now(),
				},
			],
		]);
		activate(createCtx2(state));

		const markdowns: string[] = [];
		await fallbackHandler2?.(
			{ prompt: "Go", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			makeStream(markdowns, []),
			new vscode.CancellationTokenSource().token
		);

		const ws = state.get("litellm.fallbackWorkflowState") as Record<string, unknown> | undefined;
		assert.equal(ws?.toolLoopStepsRun, 2, "Should run exactly stepCap=2 steps");
		assert.ok(
			markdowns.some((m) => m.includes("Tool loop ended") && m.includes("cap")),
			"Should emit exit summary with reason=cap"
		);

		utilsModule.executeFallbackTool = originalExecute;
	});

	test("tool loop stops after retry limit exceeded with reason=retry-limit", async () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const utilsModule = require("../utils") as {
			executeFallbackTool: typeof import("../utils").executeFallbackTool;
		};
		const originalExecute = utilsModule.executeFallbackTool;

		let modelCallCount = 0;
		utilsModule.executeFallbackTool = (async (name: string) => ({
			success: false,
			output: "",
			error: `${name} always fails`,
			meta: { tool: name as "execute_command", exitCode: 1 },
		})) as typeof utilsModule.executeFallbackTool;

		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model: vscode.LanguageModelChatInformation,
			_messages: readonly vscode.LanguageModelChatRequestMessage[],
			_options: vscode.ProvideLanguageModelChatResponseOptions,
			progress: vscode.Progress<vscode.LanguageModelResponsePart>
		) {
			modelCallCount++;
			progress.report(
				new vscode.LanguageModelToolCallPart(`tc-fail-${modelCallCount}`, "execute_command", { command: "fail" })
			);
		};

		stubInfoMessage();
		stubExecCommand();

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
			[
				"litellm.fallbackWorkflowState",
				{
					notes: [],
					loopEnabled: false,
					pendingApproval: false,
					checkpoints: [],
					toolCalls: [],
					toolLoopActive: true,
					toolLoopGoal: "Will keep failing",
					toolLoopStepCap: 20,
					toolLoopRetryLimit: 2,
					toolLoopCheckpointInterval: 0,
					toolLoopStepsRun: 0,
					toolLoopConsecutiveFailures: 0,
					updatedAt: Date.now(),
				},
			],
		]);
		activate(createCtx2(state));

		const markdowns: string[] = [];
		await fallbackHandler2?.(
			{ prompt: "Go", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			makeStream(markdowns, []),
			new vscode.CancellationTokenSource().token
		);

		const ws = state.get("litellm.fallbackWorkflowState") as Record<string, unknown> | undefined;
		assert.equal(ws?.toolLoopConsecutiveFailures, 2, "Should record 2 consecutive failures");
		assert.ok(
			markdowns.some((m) => m.includes("Tool loop ended") && m.includes("retry-limit")),
			"Should emit exit summary with reason=retry-limit"
		);

		utilsModule.executeFallbackTool = originalExecute;
	});

	test("tool loop pauses at checkpoint interval and sets pendingApproval", async () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const utilsModule = require("../utils") as {
			executeFallbackTool: typeof import("../utils").executeFallbackTool;
		};
		const originalExecute = utilsModule.executeFallbackTool;

		let modelCallCount = 0;
		utilsModule.executeFallbackTool = (async (name: string) => ({
			success: true,
			output: `ok from ${name}`,
			meta: { tool: name as "execute_command" },
		})) as typeof utilsModule.executeFallbackTool;

		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model: vscode.LanguageModelChatInformation,
			_messages: readonly vscode.LanguageModelChatRequestMessage[],
			_options: vscode.ProvideLanguageModelChatResponseOptions,
			progress: vscode.Progress<vscode.LanguageModelResponsePart>
		) {
			modelCallCount++;
			// Always emit tool call; checkpoint at step 2 will cut it off
			progress.report(
				new vscode.LanguageModelToolCallPart(`tc-cp-${modelCallCount}`, "execute_command", { command: "work" })
			);
		};

		stubInfoMessage();
		stubExecCommand();

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
			[
				"litellm.fallbackWorkflowState",
				{
					notes: [],
					loopEnabled: false,
					pendingApproval: false,
					checkpoints: [],
					toolCalls: [],
					toolLoopActive: true,
					toolLoopGoal: "Checkpoint test",
					toolLoopStepCap: 10,
					toolLoopRetryLimit: 5,
					toolLoopCheckpointInterval: 2,
					toolLoopStepsRun: 0,
					toolLoopConsecutiveFailures: 0,
					updatedAt: Date.now(),
				},
			],
		]);
		activate(createCtx2(state));

		const markdowns: string[] = [];
		await fallbackHandler2?.(
			{ prompt: "Go", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			makeStream(markdowns, []),
			new vscode.CancellationTokenSource().token
		);

		const ws = state.get("litellm.fallbackWorkflowState") as Record<string, unknown> | undefined;
		assert.equal(ws?.toolLoopStepsRun, 2, "Should have run 2 steps before checkpoint pause");
		assert.equal(ws?.pendingApproval, true, "Should set pendingApproval=true at checkpoint");
		assert.ok(
			markdowns.some((m) => m.includes("Tool loop ended") && m.includes("checkpoint")),
			"Should emit summary with reason=checkpoint"
		);
		assert.ok(
			markdowns.some((m) => m.includes("/tool-loop resume")),
			"Should suggest /tool-loop resume"
		);

		utilsModule.executeFallbackTool = originalExecute;
	});

	test("/tool-loop resume re-activates loop and triggers model call with promptOverride", async () => {
		stubInfoMessage();
		stubExecCommand();

		const state = new Map<string, unknown>([
			["litellm.hasShownWelcome", true],
			["litellm.selectedChatModel", "claude-code-sonnet-4-6:cheapest"],
			[
				"litellm.fallbackWorkflowState",
				{
					notes: [],
					loopEnabled: false,
					pendingApproval: true,
					checkpoints: [],
					toolCalls: [],
					toolLoopActive: false,
					toolLoopGoal: "Build the feature",
					toolLoopStepCap: 10,
					toolLoopRetryLimit: 3,
					toolLoopCheckpointInterval: 2,
					toolLoopStepsRun: 2,
					toolLoopConsecutiveFailures: 0,
					updatedAt: Date.now(),
				},
			],
		]);
		activate(createCtx2(state));

		let capturedResumeMessages: readonly vscode.LanguageModelChatRequestMessage[] | undefined;
		LiteLLMChatModelProvider.prototype.provideLanguageModelChatResponse = async function (
			_model: vscode.LanguageModelChatInformation,
			messages: readonly vscode.LanguageModelChatRequestMessage[],
			_options: vscode.ProvideLanguageModelChatResponseOptions,
			progress: vscode.Progress<vscode.LanguageModelResponsePart>
		) {
			capturedResumeMessages = messages;
			progress.report(new vscode.LanguageModelTextPart("Resuming."));
		};

		const markdowns: string[] = [];
		await fallbackHandler2?.(
			{ prompt: "/tool-loop resume", references: [] } as unknown as vscode.ChatRequest,
			{ history: [] } as unknown as vscode.ChatContext,
			makeStream(markdowns, []),
			new vscode.CancellationTokenSource().token
		);

		const ws = state.get("litellm.fallbackWorkflowState") as Record<string, unknown> | undefined;
		assert.equal(ws?.toolLoopActive, true, "toolLoopActive should be restored");
		assert.equal(ws?.pendingApproval, false, "pendingApproval should be cleared");
		assert.ok(capturedResumeMessages, "Model should have been called");
		// The prompt should contain the resume context
		const lastMsg = capturedResumeMessages?.[capturedResumeMessages.length - 1];
		const msgText =
			lastMsg && "content" in lastMsg
				? (lastMsg.content as readonly unknown[])
						.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ""))
						.join("")
				: "";
		assert.ok(msgText.includes("Build the feature"), "Resume prompt should contain loop goal");
	});
});

suite("utils/fallback tool execution", () => {
	test("list_dir and search_files return workspace matches", async () => {
		const rootPath = "f:/Vscode/litellm-chat-for-vscode";
		const listResult = await executeFallbackTool("list_dir", { path: rootPath });
		assert.equal(listResult.success, true);
		assert.ok(listResult.output.includes("package.json"));

		const searchResult = await executeFallbackTool("search_files", { pattern: "src/*.ts", maxResults: 20 });
		assert.equal(searchResult.success, true);
		assert.ok(typeof searchResult.output === "string");
	});

	test("read_range returns numbered lines", async () => {
		const result = await executeFallbackTool("read_range", {
			path: "f:/Vscode/litellm-chat-for-vscode/package.json",
			startLine: 1,
			endLine: 3,
		});
		assert.equal(result.success, true);
		assert.ok(result.output.includes("1:"));
	});

	test("grep_workspace validates required query", async () => {
		const result = await executeFallbackTool("grep_workspace", {});
		assert.equal(result.success, false);
		assert.ok(result.error?.includes("Missing 'query'"));
	});

	test("apply_patch validates required patch input", async () => {
		const result = await executeFallbackTool("apply_patch", {});
		assert.equal(result.success, false);
		assert.ok(result.error?.includes("Missing 'patch'"));
	});

	test("diagnostics returns filtered diagnostics output", async () => {
		const originalGetDiagnostics = vscode.languages.getDiagnostics;
		const testUri = vscode.Uri.file("f:/Vscode/litellm-chat-for-vscode/src/extension.ts");
		const diagnostic = new vscode.Diagnostic(
			new vscode.Range(0, 0, 0, 10),
			"Sample diagnostic",
			vscode.DiagnosticSeverity.Warning
		);

		(vscode.languages as unknown as { getDiagnostics: typeof vscode.languages.getDiagnostics }).getDiagnostics = ((
			uri?: vscode.Uri
		) => {
			if (uri) {
				return [diagnostic];
			}
			return [[testUri, [diagnostic]]];
		}) as typeof vscode.languages.getDiagnostics;

		const result = await executeFallbackTool("diagnostics", { path: "src/extension.ts", severity: "warning" });
		assert.equal(result.success, true);
		assert.ok(result.output.includes("Sample diagnostic"));
		assert.ok(result.output.includes("warning"));

		(vscode.languages as unknown as { getDiagnostics: typeof vscode.languages.getDiagnostics }).getDiagnostics =
			originalGetDiagnostics;
	});

	test("symbol tools use VS Code provider commands", async () => {
		const originalExecuteCommand = vscode.commands.executeCommand;

		vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
			if (command === "vscode.executeDocumentSymbolProvider") {
				return [
					new vscode.DocumentSymbol(
						"activate",
						"",
						vscode.SymbolKind.Function,
						new vscode.Range(0, 0, 0, 8),
						new vscode.Range(0, 0, 0, 8)
					),
				] as unknown;
			}
			if (command === "vscode.executeReferenceProvider") {
				const uri = args[0] as vscode.Uri;
				return [new vscode.Location(uri, new vscode.Range(5, 1, 5, 9))] as unknown;
			}
			return await originalExecuteCommand(command, ...args);
		}) as typeof vscode.commands.executeCommand;

		const symbolResult = await executeFallbackTool("symbol_lookup", {
			path: "f:/Vscode/litellm-chat-for-vscode/src/extension.ts",
			symbol: "activate",
		});
		assert.equal(symbolResult.success, true);
		assert.ok(symbolResult.output.includes("activate"));

		const refsResult = await executeFallbackTool("symbol_references", {
			path: "f:/Vscode/litellm-chat-for-vscode/src/extension.ts",
			symbol: "activate",
		});
		assert.equal(refsResult.success, true);
		assert.ok(typeof refsResult.output === "string");

		vscode.commands.executeCommand = originalExecuteCommand;
	});
});

suite("utils/tool result formatting", () => {
	test("formatToolResult includes file path and line count for read_file", () => {
		const result = formatToolResult({
			success: true,
			output: "const x = 1;",
			meta: { tool: "read_file", filePath: "src/utils.ts", lineCount: 142 },
		});
		assert.ok(result.includes("[read_file]"), "Should include tool name");
		assert.ok(result.includes("src/utils.ts"), "Should include file path");
		assert.ok(result.includes("142 lines"), "Should include line count");
		assert.ok(result.includes("const x = 1;"), "Should include output content");
	});

	test("formatToolResult includes exit code for execute_command", () => {
		const result = formatToolResult({
			success: true,
			output: "build complete",
			meta: { tool: "execute_command", exitCode: 0 },
		});
		assert.ok(result.includes("[execute_command]"), "Should include tool name");
		assert.ok(result.includes("exit code: 0"), "Should include exit code");
	});

	test("formatToolResult shows stderr section separately from stdout", () => {
		const result = formatToolResult({
			success: false,
			output: "",
			error: "Command failed (exit code: 1)",
			meta: { tool: "execute_command", exitCode: 1, stderr: "error: bad argument" },
		});
		assert.ok(result.includes("Error:"), "Should include Error label");
		assert.ok(result.includes("Command failed"), "Should include error message");
	});

	test("formatToolResult shows truncation notice when output was cut", () => {
		const result = formatToolResult({
			success: true,
			output: "x".repeat(100),
			meta: { tool: "execute_command", truncated: true, originalLength: 10000 },
		});
		assert.ok(result.includes("truncated") || result.includes("10000"), "Should mention truncation");
	});

	test("formatToolResult shows pass/fail counts for run_tests", () => {
		const result = formatToolResult({
			success: true,
			output: "all tests passed",
			meta: { tool: "run_tests", exitCode: 0, passed: 42, failed: 0 },
		});
		assert.ok(result.includes("42 passed"), "Should include passed count");
	});

	test("formatToolResult handles failed run_tests with counts", () => {
		const result = formatToolResult({
			success: false,
			output: "3 tests failed",
			error: "Tests failed (exit code: 1)",
			meta: { tool: "run_tests", exitCode: 1, passed: 10, failed: 3 },
		});
		assert.ok(result.includes("10 passed") || result.includes("3 failed"), "Should include test counts");
	});

	test("formatToolResult handles error-only result with no meta", () => {
		const result = formatToolResult({
			success: false,
			output: "",
			error: "Unknown tool: foo",
		});
		assert.ok(result.includes("Error:"), "Should include Error label");
		assert.ok(result.includes("Unknown tool"), "Should include error text");
	});

	test("formatToolResult shows stderr before stdout when both present", () => {
		const result = formatToolResult({
			success: true,
			output: "built ok",
			meta: { tool: "execute_command", exitCode: 0, stderr: "warning: deprecated" },
		});
		const stderrIdx = result.indexOf("stderr:");
		const stdoutIdx = result.indexOf("stdout:");
		assert.ok(stderrIdx !== -1, "Should include stderr label");
		assert.ok(stdoutIdx !== -1, "Should include stdout label");
		assert.ok(stderrIdx < stdoutIdx, "stderr should appear before stdout");
	});
});
