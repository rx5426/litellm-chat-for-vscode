import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "./provider";
import { buildPromptWithReferences, extractCodeBlocks, applyCodeEdit } from "./utils";

const LITELLM_VENDOR = "litellm";
const LITELLM_CHAT_PARTICIPANT_ID = "rx5426.litellm-chat";
const LITELLM_SELECTED_CHAT_MODEL_KEY = "litellm.selectedChatModel";

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

	const fallbackParticipant = vscode.chat.createChatParticipant(
		LITELLM_CHAT_PARTICIPANT_ID,
		async (request, chatContext, stream, token) => {
			try {
				stream.progress("Resolving LiteLLM model...");
				const selectedModel = await selectLiteLLMChatModel(true);
				if (!selectedModel) {
					return {
						errorDetails: {
							message:
								"No LiteLLM model is available. Run 'LiteLLM: Test Connection' or 'LiteLLM: Select Chat Model' first.",
						},
					};
				}

				const messages: vscode.LanguageModelChatRequestMessage[] = [];
				for (const turn of chatContext.history) {
					if (turn instanceof vscode.ChatRequestTurn) {
						messages.push(
							vscode.LanguageModelChatMessage.User(
								await buildPromptWithReferences(turn.prompt, turn.references)
							)
						);
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
				messages.push(
					vscode.LanguageModelChatMessage.User(
						await buildPromptWithReferences(request.prompt, request.references)
					)
				);

				// Check if automatic code edits are enabled
				const autoApplyEdits = vscode.workspace
					.getConfiguration("litellm-vscode-chat")
					.get<boolean>("autoApplyCodeEdits", false);

				// Track applied edits for notification
				let appliedEditsCount = 0;

				await provider.provideLanguageModelChatResponse(
					selectedModel,
					messages,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{
						report: (part) => {
							if (part instanceof vscode.LanguageModelTextPart) {
								const text = part.value;
								stream.markdown(text);

								// Extract and offer code blocks for application
								const blocks = extractCodeBlocks(text);
								if (blocks.length > 0 && autoApplyEdits) {
									stream.progress(
										`Auto-applying ${blocks.length} code block${blocks.length > 1 ? "s" : ""}...`
									);
								}

								for (const block of blocks) {
									if (autoApplyEdits) {
										// Automatically apply to untitled editor
										applyCodeEdit(block.code)
											.then((uri) => {
												appliedEditsCount++;
												stream.progress(
													`✓ Applied ${block.language} code to new editor (${appliedEditsCount}/${blocks.length})`
												);
											})
											.catch((error) => {
												const errorMsg = error instanceof Error ? error.message : String(error);
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
											arguments: [{ code: block.code, language: block.language, blockId: block.id }],
										});
									}
								}
							} else if (part instanceof vscode.LanguageModelToolCallPart) {
								stream.progress(`Tool request emitted by ${selectedModel.id}: ${part.name}`);
							}
						},
					},
					token
				);

				return {
					metadata: {
						modelId: selectedModel.id,
						mode: "fallback-chat-participant",
					},
				};
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
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
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
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
			await vscode.window
				.showInformationMessage(
					"LiteLLM fallback chat is ready. In Chat, type @litellm to send messages through LiteLLM.",
					"Copy Mention"
				)
				.then((choice) => {
					if (choice === "Copy Mention") {
						void vscode.env.clipboard.writeText("@litellm ");
					}
				});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.showModels", async () => {
			await showLiteLLMModels();
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
				await vscode.window.showInformationMessage(
					`Auto-apply code edits ${status} for fallback chat (@litellm).`
				);
				outputChannel.appendLine(
					`[${new Date().toISOString()}] Auto-apply code edits ${status} by user.`
				);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				await vscode.window.showErrorMessage(`Failed to toggle auto-apply code edits: ${errorMsg}`);
				outputChannel.appendLine(
					`[${new Date().toISOString()}] Failed to toggle auto-apply code edits: ${errorMsg}`
				);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"litellm.applyCodeEdit",
			async (editRequest?: { code: string; language: string; blockId: string }) => {
				if (!editRequest || !editRequest.code) {
					await vscode.window.showErrorMessage("No code edit provided.");
					return;
				}

				const activeEditor = vscode.window.activeTextEditor;
				const currentFile = activeEditor?.document.uri.fsPath;

				try {
					// If there's an active editor in a workspace file, ask user about replacement
					if (currentFile && vscode.workspace.workspaceFolders?.length) {
						const choice = await vscode.window.showQuickPick(
							[
								{
									label: "Replace current file",
									description: currentFile,
									value: "replace",
								},
								{
									label: "Open in new untitled editor",
									value: "new",
								},
							],
							{ title: "Apply Code Edit" }
						);

						if (!choice) return;

						const uri =
							choice.value === "replace"
								? await applyCodeEdit(editRequest.code, currentFile)
								: await applyCodeEdit(editRequest.code);

						await vscode.window.showInformationMessage(
							`Code edit applied: ${uri.fsPath || uri.scheme}`
						);
					} else {
						// No active editor, create untitled
						const uri = await applyCodeEdit(editRequest.code);
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
				"Open Fallback Chat"
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
}

export function deactivate() {}
