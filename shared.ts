// ===========================================================================
// Shared types, provider templates, config utilities, and provider registration
// Used by both subs.ts and route.ts for independent operation.
// ===========================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getModels, type Api, type Model } from "@earendil-works/pi-ai";
import {
	anthropicOAuthProvider,
	loginAnthropic,
	refreshAnthropicToken,
	openaiCodexOAuthProvider,
	loginOpenAICodex,
	refreshOpenAICodexToken,
	githubCopilotOAuthProvider,
	loginGitHubCopilot,
	refreshGitHubCopilotToken,
	getGitHubCopilotBaseUrl,
	normalizeDomain,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";
import { type SelectItem } from "@earendil-works/pi-tui";

// ===========================================================================
// Stub OAuth providers for google-gemini-cli and google-antigravity
// ===========================================================================

function apiKeyOAuthProvider(providerName: string, displayName: string): OAuthProviderInterface {
	return {
		id: providerName,
		name: displayName,
		async login(): Promise<OAuthCredentials> {
			throw new Error(`${displayName} uses API key, not OAuth.`);
		},
		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			return credentials;
		},
		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},
	};
}

const geminiCliOAuthProvider: OAuthProviderInterface = apiKeyOAuthProvider("google-gemini-cli", "Google Cloud Code Assist");
const loginGeminiCli = (_onAuth: any, _onProgress: any, _onManualCodeInput: any): Promise<OAuthCredentials & { projectId?: string }> =>
	Promise.resolve({ access: "", refresh: "", expires: Date.now() + 365 * 24 * 60 * 60 * 1000, projectId: "" });
const refreshGoogleCloudToken = (_refresh: string, _projectId: string): Promise<OAuthCredentials & { projectId: string }> =>
	Promise.resolve({ access: "", refresh: "", expires: Date.now() + 365 * 24 * 60 * 60 * 1000, projectId: _projectId });
const antigravityOAuthProvider: OAuthProviderInterface = apiKeyOAuthProvider("google-antigravity", "Antigravity");
const loginAntigravity = (_onAuth: any, _onProgress: any, _onManualCodeInput: any): Promise<OAuthCredentials & { projectId?: string }> =>
	Promise.resolve({ access: "", refresh: "", expires: Date.now() + 365 * 24 * 60 * 60 * 1000, projectId: "" });
const refreshAntigravityToken = (_refresh: string, _projectId: string): Promise<OAuthCredentials & { projectId: string }> =>
	Promise.resolve({ access: "", refresh: "", expires: Date.now() + 365 * 24 * 60 * 60 * 1000, projectId: _projectId });

// ===========================================================================
// Types
// ===========================================================================

type CopilotCredentials = OAuthCredentials & { enterpriseUrl?: string };
type GeminiCredentials = OAuthCredentials & { projectId?: string };

interface ProviderTemplate {
	displayName: string;
	builtinOAuth: OAuthProviderInterface;
	usesCallbackServer?: boolean;
	useOAuth?: boolean;
	models?: Model<Api>[];
	sourceProvider?: string;
	buildOAuth(index: number): Omit<OAuthProviderInterface, "id">;
	buildModifyModels?(providerName: string): OAuthProviderInterface["modifyModels"];
}

export interface SubEntry { provider: string; index: number; label?: string; }

export interface MultiPassConfig {
  subscriptions: SubEntry[];
}

export interface ProjectConfig {
  allowedSubs?: string[];
}

export interface EffectiveConfig {
  subscriptions: SubEntry[];
  allowedProviderNames?: string[];
  projectConfigPath?: string;
}

// ===========================================================================
// Helpers
// ===========================================================================

function buildApiKeyOAuthProvider(
	index: number,
	displayName: string,
	prompt: string,
	requiredMessage: string,
): Omit<OAuthProviderInterface, "id"> {
	return {
		name: `${displayName} #${index}`,
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const apiKey = await callbacks.onPrompt({
				message: `${prompt} for subscription #${index}:`,
			});
			if (!apiKey?.trim()) {
				throw new Error(requiredMessage);
			}
			return {
				access: apiKey.trim(),
				refresh: "",
				expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
			};
		},
		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			return credentials;
		},
		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},
	};
}

function providerModel(
	provider: string,
	id: string,
	name: string,
	api: Api,
	baseUrl: string,
	reasoning: boolean,
	input: ("text" | "image")[] = ["text"],
	contextWindow = 128000,
	maxTokens = 4096,
): Model<Api> {
	return {
		id,
		name,
		provider,
		api,
		baseUrl,
		reasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

// ===========================================================================
// Provider templates — all supported providers
// ===========================================================================

export const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = {
	anthropic: {
		displayName: "Anthropic (Claude Pro/Max)",
		builtinOAuth: anthropicOAuthProvider,
		buildOAuth(index: number) {
			return {
				name: `Anthropic #${index}`,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginAnthropic({
						onAuth: callbacks.onAuth,
						onPrompt: callbacks.onPrompt,
						onProgress: callbacks.onProgress,
						onManualCodeInput: callbacks.onManualCodeInput,
					});
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					return refreshAnthropicToken(credentials.refresh);
				},
				getApiKey(credentials: OAuthCredentials): string {
					return credentials.access;
				},
			};
		},
	},

	"openai-codex": {
		displayName: "ChatGPT Plus/Pro (Codex)",
		builtinOAuth: openaiCodexOAuthProvider,
		usesCallbackServer: true,
		buildOAuth(index: number) {
			return {
				name: `ChatGPT Codex #${index}`,
				usesCallbackServer: true,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginOpenAICodex({
						onAuth: callbacks.onAuth,
						onPrompt: callbacks.onPrompt,
						onProgress: callbacks.onProgress,
						onManualCodeInput: callbacks.onManualCodeInput,
					});
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					return refreshOpenAICodexToken(credentials.refresh);
				},
				getApiKey(credentials: OAuthCredentials): string {
					return credentials.access;
				},
			};
		},
	},

	"github-copilot": {
		displayName: "GitHub Copilot",
		builtinOAuth: githubCopilotOAuthProvider,
		buildOAuth(index: number) {
			return {
				name: `GitHub Copilot #${index}`,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginGitHubCopilot({
						onAuth: (url: string, instructions?: string) =>
							callbacks.onAuth({ url, instructions }),
						onPrompt: callbacks.onPrompt,
						onProgress: callbacks.onProgress,
						signal: callbacks.signal,
					});
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					const creds = credentials as CopilotCredentials;
					return refreshGitHubCopilotToken(creds.refresh, creds.enterpriseUrl);
				},
				getApiKey(credentials: OAuthCredentials): string {
					return credentials.access;
				},
			};
		},
		buildModifyModels(providerName: string) {
			return (models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] => {
				const creds = credentials as CopilotCredentials;
				const domain = creds.enterpriseUrl
					? (normalizeDomain(creds.enterpriseUrl) ?? undefined)
					: undefined;
				const baseUrl = getGitHubCopilotBaseUrl(creds.access, domain);
				return models.map((m) =>
					m.provider === providerName ? { ...m, baseUrl } : m,
				);
			};
		},
	},

	"google-gemini-cli": {
		displayName: "Google Cloud Code Assist",
		builtinOAuth: geminiCliOAuthProvider,
		usesCallbackServer: true,
		buildOAuth(index: number) {
			return {
				name: `Google Cloud Code Assist #${index}`,
				usesCallbackServer: true,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginGeminiCli(
						callbacks.onAuth,
						callbacks.onProgress,
						callbacks.onManualCodeInput,
					);
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					const creds = credentials as GeminiCredentials;
					if (!creds.projectId) throw new Error("Missing projectId");
					return refreshGoogleCloudToken(creds.refresh, creds.projectId);
				},
				getApiKey(credentials: OAuthCredentials): string {
					const creds = credentials as GeminiCredentials;
					return JSON.stringify({ token: creds.access, projectId: creds.projectId });
				},
			};
		},
	},

	"google-antigravity": {
		displayName: "Antigravity",
		builtinOAuth: antigravityOAuthProvider,
		usesCallbackServer: true,
		buildOAuth(index: number) {
			return {
				name: `Antigravity #${index}`,
				usesCallbackServer: true,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginAntigravity(
						callbacks.onAuth,
						callbacks.onProgress,
						callbacks.onManualCodeInput,
					);
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					const creds = credentials as GeminiCredentials;
					if (!creds.projectId) throw new Error("Missing projectId");
					return refreshAntigravityToken(creds.refresh, creds.projectId);
				},
				getApiKey(credentials: OAuthCredentials): string {
					const creds = credentials as GeminiCredentials;
					return JSON.stringify({ token: creds.access, projectId: creds.projectId });
				},
			};
		},
	},

	"nvidia": {
		displayName: "NVIDIA (NVIDIA AI Foundry / NIM)",
		useOAuth: false,
		models: [
			{ id: "nvidia-default", name: "NVIDIA Default", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 32768, maxTokens: 4096 },
			{ id: "deepseek-ai/deepseek-v4-flash", name: "deepseek-ai/deepseek-v4-flash", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: true, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 262000, maxTokens: 16384 },
			{ id: "deepseek-ai/deepseek-v4-pro", name: "deepseek-ai/deepseek-v4-pro", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 262000, maxTokens: 16384 },
			{ id: "moonshotai/kimi-k2.6", name: "moonshotai/kimi-k2.6", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 262000, maxTokens: 16384 },
			{ id: "stepfun-ai/step-3.5-flash", name: "stepfun-ai/step-3.5-flash", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: true, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 262000, maxTokens: 16384 },
			{ id: "mistralai/mistral-medium-3.5-128b", name: "mistralai/mistral-medium-3.5-128b", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 262000, maxTokens: 16384 },
			{ id: "google/gemma-4-31b-it", name: "google/gemma-4-31b-it", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: true, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 262000, maxTokens: 16384 },
			{ id: "minimaxai/minimax-m3", name: "minimaxai/minimax-m3", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 262000, maxTokens: 16384 },
			{ id: "minimaxai/minimax-m2.7", name: "minimaxai/minimax-m2.7", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 262000, maxTokens: 16384 },
			{ id: "nvidia/nemotron-3-ultra-550b-a55b", name: "nvidia/nemotron-3-ultra-550b-a55b", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: true, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 262000, maxTokens: 16384 },
		],
		builtinOAuth: {
			id: "nvidia", name: "NVIDIA",
			async login(): Promise<OAuthCredentials> { throw new Error("NVIDIA uses API key, not OAuth."); },
			async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> { return credentials; },
			getApiKey(credentials: OAuthCredentials): string { return credentials.access; },
		},
		buildOAuth(index: number) {
			return {
				name: `NVIDIA #${index}`,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					const apiKey = await callbacks.onPrompt({ message: `Enter NVIDIA API key for subscription #${index}:` });
					if (!apiKey?.trim()) throw new Error("NVIDIA API key is required.");
					return { access: apiKey.trim(), refresh: "", expires: Date.now() + 365 * 24 * 60 * 60 * 1000 };
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> { return credentials; },
				getApiKey(credentials: OAuthCredentials): string { return credentials.access; },
			};
		},
	},

	"morph-llm": {
		displayName: "Morph LLM",
		useOAuth: false,
		models: [
			{ id: "morph-qwen35-397b", name: "Morph Qwen 3.5 397B", api: "openai-completions", baseUrl: "https://api.morphllm.com/v1", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0 }, contextWindow: 262144, maxTokens: 4096 },
			{ id: "morph-qwen36-27b", name: "Morph Qwen 3.6 27B", api: "openai-completions", baseUrl: "https://api.morphllm.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 131072, maxTokens: 4094 },
			{ id: "morph-minimax27-230b", name: "Morph MiniMax M2.7", api: "openai-completions", baseUrl: "https://api.morphllm.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 200000, maxTokens: 4094 },
			{ id: "morph-dsv4flash", name: "Morph DeepSeek V4 Flash Beta", api: "openai-completions", baseUrl: "https://api.morphllm.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 131072, maxTokens: 4094 },
			{ id: "morph-v3-fast", name: "Morph V3 Fast", api: "openai-completions", baseUrl: "https://api.morphllm.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 131072, maxTokens: 4094 },
		],
		builtinOAuth: {
			id: "morph-llm", name: "Morph LLM",
			async login(): Promise<OAuthCredentials> { throw new Error("Morph LLM uses API key, not OAuth."); },
			async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> { return credentials; },
			getApiKey(credentials: OAuthCredentials): string { return credentials.access; },
		},
		buildOAuth(index: number) {
			return {
				name: `Morph LLM #${index}`,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					const apiKey = await callbacks.onPrompt({ message: `Enter Morph LLM API key for subscription #${index}:` });
					if (!apiKey?.trim()) throw new Error("Morph LLM API key is required.");
					return { access: apiKey.trim(), refresh: "", expires: Date.now() + 365 * 24 * 60 * 60 * 1000 };
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> { return credentials; },
				getApiKey(credentials: OAuthCredentials): string { return credentials.access; },
			};
		},
	},

	"siliconflow": {
		displayName: "SiliconFlow",
		useOAuth: false,
		models: [
			{ id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1", api: "openai-completions", baseUrl: "https://api.siliconflow.com/v1", reasoning: true, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 131072, maxTokens: 8192 },
			{ id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3", api: "openai-completions", baseUrl: "https://api.siliconflow.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 131072, maxTokens: 8192 },
			{ id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen 2.5 72B Instruct", api: "openai-completions", baseUrl: "https://api.siliconflow.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 131072, maxTokens: 8192 },
			{ id: "Qwen/QwQ-32B", name: "QwQ 32B", api: "openai-completions", baseUrl: "https://api.siliconflow.com/v1", reasoning: true, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 131072, maxTokens: 8192 },
			{ id: "nex-agi/Nex-N2-Pro", name: "Nex N2 Pro", api: "openai-completions", baseUrl: "https://api.siliconflow.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 262144, maxTokens: 8192 },
		],
		builtinOAuth: {
			id: "siliconflow", name: "SiliconFlow",
			async login(): Promise<OAuthCredentials> { throw new Error("SiliconFlow uses API key, not OAuth."); },
			async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> { return credentials; },
			getApiKey(credentials: OAuthCredentials): string { return credentials.access; },
		},
		buildOAuth(index: number) {
			return {
				name: `SiliconFlow #${index}`,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					const apiKey = await callbacks.onPrompt({ message: `Enter SiliconFlow API key for subscription #${index}:` });
					if (!apiKey?.trim()) throw new Error("SiliconFlow API key is required.");
					return { access: apiKey.trim(), refresh: "", expires: Date.now() + 365 * 24 * 60 * 60 * 1000 };
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> { return credentials; },
				getApiKey(credentials: OAuthCredentials): string { return credentials.access; },
			};
		},
	},

	openrouter: {
		displayName: "OpenRouter",
		useOAuth: false,
		models: [
			providerModel("openrouter", "openai/gpt-5", "OpenAI GPT-5", "openai-completions", "https://openrouter.ai/api/v1", false, ["text", "image"], 400000, 128000),
			providerModel("openrouter", "openai/gpt-5-mini", "OpenAI GPT-5 Mini", "openai-completions", "https://openrouter.ai/api/v1", false, ["text", "image"], 400000, 128000),
			providerModel("openrouter", "anthropic/claude-opus-4.1", "Anthropic Claude Opus 4.1", "openai-completions", "https://openrouter.ai/api/v1", true, ["text", "image"], 400000, 64000),
			providerModel("openrouter", "anthropic/claude-sonnet-4.5", "Anthropic Claude Sonnet 4.5", "openai-completions", "https://openrouter.ai/api/v1", true, ["text", "image"], 400000, 64000),
			providerModel("openrouter", "google/gemini-2.5-pro", "Google Gemini 2.5 Pro", "openai-completions", "https://openrouter.ai/api/v1", true, ["text", "image"], 2097152, 65536),
			providerModel("openrouter", "qwen/qwen3.5-397b-a17b", "Qwen 3.5 397B A17B", "openai-completions", "https://openrouter.ai/api/v1", true, ["text"], 262144, 65536),
		],
		builtinOAuth: apiKeyOAuthProvider("openrouter", "OpenRouter"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "OpenRouter", "Enter OpenRouter API key", "OpenRouter API key is required.");
		},
	},

	"cloudflare-ai-gateway": {
		displayName: "Cloudflare AI Gateway",
		useOAuth: false,
		models: [
			providerModel("cloudflare-ai-gateway", "claude-3.5-sonnet", "Claude Sonnet 3.5 v2", "anthropic-messages", "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic", false, ["text", "image"], 200000, 8192),
			providerModel("cloudflare-ai-gateway", "claude-3.5-haiku", "Claude Haiku 3.5 (latest)", "anthropic-messages", "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic", false, ["text", "image"], 200000, 8192),
			providerModel("cloudflare-ai-gateway", "claude-sonnet-4", "Claude Sonnet 4 (latest)", "anthropic-messages", "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic", true, ["text", "image"], 200000, 64000),
			providerModel("cloudflare-ai-gateway", "gpt-4o", "GPT-4o", "openai-completions", "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai/v1", false, ["text", "image"], 128000, 16384),
			providerModel("cloudflare-ai-gateway", "gpt-4.1", "GPT-4.1", "openai-completions", "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai/v1", false, ["text", "image"], 1047576, 32768),
		],
		builtinOAuth: apiKeyOAuthProvider("cloudflare-ai-gateway", "Cloudflare AI Gateway"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "Cloudflare AI Gateway", "Enter Cloudflare AI Gateway API key", "Cloudflare AI Gateway API key is required.");
		},
	},

	huggingface: {
		displayName: "Hugging Face Inference Router",
		useOAuth: false,
		models: [
			providerModel("huggingface", "MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7", "openai-completions", "https://router.huggingface.co/v1", true, ["text"], 204800, 131072),
			providerModel("huggingface", "Qwen/Qwen3-235B-A22B-Thinking-2507", "Qwen3 235B Thinking 2507", "openai-completions", "https://router.huggingface.co/v1", true, ["text"], 262144, 131072),
			providerModel("huggingface", "Qwen/Qwen3-Coder-480B-A35B-Instruct", "Qwen3 Coder 480B Instruct", "openai-completions", "https://router.huggingface.co/v1", false, ["text"], 262144, 66536),
			providerModel("huggingface", "deepseek-ai/DeepSeek-V4-Pro", "DeepSeek V4 Pro", "openai-completions", "https://router.huggingface.co/v1", false, ["text"], 262144, 65536),
			providerModel("huggingface", "moonshotai/Kimi-K2.6", "Kimi K2.6", "openai-completions", "https://router.huggingface.co/v1", false, ["text"], 262144, 65536),
		],
		builtinOAuth: apiKeyOAuthProvider("huggingface", "Hugging Face Inference Router"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "Hugging Face Inference Router", "Enter Hugging Face API key", "Hugging Face API key is required.");
		},
	},

	mistral: {
		displayName: "Mistral AI",
		useOAuth: false,
		models: [
			providerModel("mistral", "mistral-large-latest", "Mistral Large Latest", "mistral-conversations", "https://api.mistral.ai", true, ["text", "image"], 256000, 128000),
			providerModel("mistral", "mistral-small-latest", "Mistral Small Latest", "mistral-conversations", "https://api.mistral.ai", false, ["text"], 256000, 128000),
			providerModel("mistral", "pixtral-large-latest", "Pixtral Large Latest", "mistral-conversations", "https://api.mistral.ai", true, ["text", "image"], 256000, 128000),
			providerModel("mistral", "codestral-latest", "Codestral Latest", "mistral-conversations", "https://api.mistral.ai", false, ["text"], 256000, 4096),
			providerModel("mistral", "devstral-latest", "Devstral Latest", "mistral-conversations", "https://api.mistral.ai", false, ["text"], 262144, 262144),
		],
		builtinOAuth: apiKeyOAuthProvider("mistral", "Mistral AI"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "Mistral AI", "Enter Mistral AI API key", "Mistral AI API key is required.");
		},
	},

	together: {
		displayName: "Together AI",
		useOAuth: false,
		models: [
			providerModel("together", "Qwen/Qwen3.5-397B-A17B", "Qwen 3.5 397B A17B", "openai-completions", "https://api.together.xyz/v1", true, ["text"], 262144, 65536),
			providerModel("together", "Qwen/Qwen3-235B-A22B-Instruct-2507-tput", "Qwen3 235B Instruct 2507 Tput", "openai-completions", "https://api.together.xyz/v1", true, ["text"], 262144, 65536),
			providerModel("together", "deepseek-ai/DeepSeek-V4-Pro", "DeepSeek V4 Pro", "openai-completions", "https://api.together.xyz/v1", false, ["text"], 262144, 65536),
			providerModel("together", "moonshotai/Kimi-K2.6", "Kimi K2.6", "openai-completions", "https://api.together.xyz/v1", false, ["text"], 262144, 65536),
			providerModel("together", "openai/gpt-oss-120b", "OpenAI GPT-OSS 120B", "openai-completions", "https://api.together.xyz/v1", true, ["text"], 200000, 65536),
		],
		builtinOAuth: apiKeyOAuthProvider("together", "Together AI"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "Together AI", "Enter Together AI API key", "Together AI API key is required.");
		},
	},

	cohere: {
		displayName: "Cohere",
		useOAuth: false,
		models: [
			providerModel("cohere", "command-a", "Command A", "openai-completions", "https://api.cohere.com/compat/v1", false, ["text"], 256000, 8000),
			providerModel("cohere", "command-r-plus-08-2024", "Command R+ (08-2024)", "openai-completions", "https://api.cohere.com/compat/v1", false, ["text"], 128000, 4000),
			providerModel("cohere", "command-r-08-2024", "Command R (08-2024)", "openai-completions", "https://api.cohere.com/compat/v1", false, ["text"], 128000, 4000),
		],
		builtinOAuth: apiKeyOAuthProvider("cohere", "Cohere"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "Cohere", "Enter Cohere API key", "Cohere API key is required.");
		},
	},

	opencode: {
		displayName: "OpenCode Zen",
		useOAuth: false,
		builtinOAuth: apiKeyOAuthProvider("opencode", "OpenCode Zen"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "OpenCode Zen", "Enter OpenCode Zen API key", "OpenCode Zen API key is required.");
		},
	},

	"opencode-go": {
		displayName: "OpenCode Go",
		useOAuth: false,
		builtinOAuth: apiKeyOAuthProvider("opencode-go", "OpenCode Go"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "OpenCode Go", "Enter OpenCode Go API key", "OpenCode Go API key is required.");
		},
	},

	cerebras: {
		displayName: "Cerebras",
		useOAuth: false,
		builtinOAuth: apiKeyOAuthProvider("cerebras", "Cerebras"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "Cerebras", "Enter Cerebras API key", "Cerebras API key is required.");
		},
	},

	deepseek: {
		displayName: "DeepSeek",
		useOAuth: false,
		builtinOAuth: apiKeyOAuthProvider("deepseek", "DeepSeek"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "DeepSeek", "Enter DeepSeek API key", "DeepSeek API key is required.");
		},
	},

	fireworks: {
		displayName: "Fireworks AI",
		useOAuth: false,
		builtinOAuth: apiKeyOAuthProvider("fireworks", "Fireworks AI"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "Fireworks AI", "Enter Fireworks AI API key", "Fireworks AI API key is required.");
		},
	},

	groq: {
		displayName: "Groq",
		useOAuth: false,
		builtinOAuth: apiKeyOAuthProvider("groq", "Groq"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "Groq", "Enter Groq API key", "Groq API key is required.");
		},
	},

	minimax: {
		displayName: "MiniMax",
		useOAuth: false,
		builtinOAuth: apiKeyOAuthProvider("minimax", "MiniMax"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "MiniMax", "Enter MiniMax API key", "MiniMax API key is required.");
		},
	},

	moonshotai: {
		displayName: "Moonshot AI (Kimi)",
		useOAuth: false,
		builtinOAuth: apiKeyOAuthProvider("moonshotai", "Moonshot AI"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "Moonshot AI", "Enter Moonshot AI API key", "Moonshot AI API key is required.");
		},
	},

	openai: {
		displayName: "OpenAI",
		useOAuth: false,
		builtinOAuth: apiKeyOAuthProvider("openai", "OpenAI"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "OpenAI", "Enter OpenAI API key", "OpenAI API key is required.");
		},
	},

	xai: {
		displayName: "xAI (Grok)",
		useOAuth: false,
		builtinOAuth: apiKeyOAuthProvider("xai", "xAI"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "xAI", "Enter xAI API key", "xAI API key is required.");
		},
	},

	xiaomi: {
		displayName: "Xiaomi",
		useOAuth: false,
		builtinOAuth: apiKeyOAuthProvider("xiaomi", "Xiaomi"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "Xiaomi", "Enter Xiaomi API key", "Xiaomi API key is required.");
		},
	},

	zai: {
		displayName: "ZAI (Zhipu AI)",
		useOAuth: false,
		builtinOAuth: apiKeyOAuthProvider("zai", "ZAI"),
		buildOAuth(index: number) {
			return buildApiKeyOAuthProvider(index, "ZAI", "Enter ZAI API key", "ZAI API key is required.");
		},
	},
};

// ===========================================================================
// Config utilities
// ===========================================================================

export function parseEnvConfig(): SubEntry[] { return []; }

export function mergeConfigs(fileConfig: MultiPassConfig, envEntries: SubEntry[]): SubEntry[] {
  return [...fileConfig.subscriptions, ...envEntries];
}

export function normalizeEntries(entries: SubEntry[]): SubEntry[] { return entries; }

export function subProviderName(entry: SubEntry): string { return `${entry.provider}-${entry.index}`; }

export function authConfigPath(): string { return join(getAgentDir(), "auth.json"); }

function subDisplayName(entry: SubEntry): string {
  const tmpl = PROVIDER_TEMPLATES[entry.provider];
  const base = tmpl?.displayName || entry.provider;
  return entry.label ? `${entry.label} — ${base} #${entry.index}` : `${base} #${entry.index}`;
}

export function getBaseProvider(providerName: string): string | undefined {
  if (PROVIDER_TEMPLATES[providerName]) return providerName;
  const m = providerName.match(/^(.+)-\d+$/);
  return m && PROVIDER_TEMPLATES[m[1]] ? m[1] : undefined;
}

function getProviderDisplayName(providerName: string, subs: SubEntry[]): string {
  const sub = subs.find((e) => subProviderName(e) === providerName);
  if (sub) return subDisplayName(sub);
  return PROVIDER_TEMPLATES[providerName]?.displayName || providerName;
}

export const RATE_LIMIT_PATTERNS = [
  /usage.?limit/i,
  /rate.?limit/i,
  /limit.*reached/i,
  /too many requests/i,
  /overloaded/i,
  /capacity/i,
  /429/,
  /quota/i,
];

export function isRateLimitError(msg: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(msg));
}

function globalConfigPath(): string { return join(getAgentDir(), "multi-pass.json"); }
function projectConfigPath(cwd: string): string { return join(cwd, ".pi", "multi-pass.json"); }

function emptyMultiPassConfig(): MultiPassConfig {
  return { subscriptions: [] };
}

function normalizeMultiPassConfig(raw: unknown): MultiPassConfig {
  const parsed = typeof raw === "object" && raw ? (raw as Partial<MultiPassConfig>) : {};
  return {
    subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
  };
}

export function loadGlobalConfig(): MultiPassConfig {
  const path = globalConfigPath();
  if (!existsSync(path)) return emptyMultiPassConfig();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return normalizeMultiPassConfig(raw);
  } catch {
    return emptyMultiPassConfig();
  }
}

export function saveGlobalConfig(cfg: MultiPassConfig): void {
  const path = globalConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), "utf-8");
}

function normalizeProjectConfig(raw: unknown): ProjectConfig {
  const parsed = typeof raw === "object" && raw ? (raw as Partial<ProjectConfig>) : {};
  const out: ProjectConfig = {};
  if (Array.isArray(parsed.allowedSubs)) out.allowedSubs = parsed.allowedSubs;
  return out;
}

function loadProjectConfig(cwd: string): ProjectConfig | undefined {
  const path = projectConfigPath(cwd);
  if (!existsSync(path)) return undefined;
  try { return normalizeProjectConfig(JSON.parse(readFileSync(path, "utf-8"))); } catch { return undefined; }
}

export function loadEffectiveConfig(cwd: string): EffectiveConfig {
  const global = loadGlobalConfig();
  const envEntries = parseEnvConfig();
  const mergedSubs = normalizeEntries(mergeConfigs(global, envEntries));
  const project = loadProjectConfig(cwd);
  if (!project) {
    return { subscriptions: mergedSubs };
  }
  const allowedNames = project.allowedSubs?.length ? new Set(project.allowedSubs) : undefined;
  const subs = allowedNames
    ? mergedSubs.filter((s) => allowedNames.has(subProviderName(s)))
    : mergedSubs;
  return { subscriptions: subs, allowedProviderNames: project.allowedSubs, projectConfigPath: projectConfigPath(cwd) };
}

// ===========================================================================
// Model helpers
// ===========================================================================

function stripJsonCommentsAndTrailingCommas(input: string): string {
  return input
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
}

function loadModelsJsonProviderModels(providerName: string): Model<Api>[] {
  try {
    const path = join(getAgentDir(), "models.json");
    const raw = readFileSync(path, "utf-8");
    const cleaned = stripJsonCommentsAndTrailingCommas(raw);
    const parsed = JSON.parse(cleaned) as { providers?: Record<string, { models?: any[] }> };
    const models = parsed.providers?.[providerName]?.models ?? [];
    return models.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      api: m.api,
      provider: providerName as any,
      baseUrl: m.baseUrl || "",
      reasoning: !!m.reasoning,
      input: m.input || ["text"],
      cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow || 0,
      maxTokens: m.maxTokens || 0,
      headers: m.headers,
      compat: m.compat,
    } as Model<Api>));
  } catch { return []; }
}

function getRegistryModelsForProvider(ctx: ExtensionContext | ExtensionCommandContext | undefined, provider: string): Model<Api>[] {
  if (!ctx) return [];
  return ctx.modelRegistry.getAll().filter((m) => m.provider === provider) as Model<Api>[];
}

function cloneModels(originalProvider: string, index: number, ctx?: ExtensionContext | ExtensionCommandContext, aliasProvider?: string) {
  const registry = [...getRegistryModelsForProvider(ctx, originalProvider), ...(aliasProvider ? getRegistryModelsForProvider(ctx, aliasProvider) : [])];
  const modelsJson = [...loadModelsJsonProviderModels(originalProvider), ...(aliasProvider ? loadModelsJsonProviderModels(aliasProvider) : [])];
  const system = [...getModels(originalProvider as any), ...(aliasProvider ? getModels(aliasProvider as any) : [])];
  const all = Array.from(new Map([...registry, ...modelsJson, ...system].map((m) => [m.id, m])).values()) as Model<Api>[];
  return all.map((m) => ({
    ...m,
    name: `${m.name} #${index}`,
  }));
}

// ===========================================================================
// Provider registration
// ===========================================================================

export function registerSub(pi: ExtensionAPI, entry: SubEntry, ctx?: ExtensionContext) {
  console.log('[registerSub] called for:', entry.provider, 'index:', entry.index);
  const template = PROVIDER_TEMPLATES[entry.provider];
  if (!template) return;
  const name = subProviderName(entry);
  // Skip if already registered by system (prevents overriding in newer pi versions)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((ctx as any)?.modelRegistry?.registeredProviders?.has(name)) {
    console.log('[registerSub] skipping', name, '- already registered');
    return;
  }
  const oauth = template.buildOAuth(entry.index);
  const modifyModels = template.buildModifyModels?.(name);
  const sourceProvider = template.sourceProvider ?? entry.provider;
  const aliasProvider = sourceProvider === entry.provider ? undefined : entry.provider;

  const registryModels = [...getRegistryModelsForProvider(ctx, sourceProvider), ...(aliasProvider ? getRegistryModelsForProvider(ctx, aliasProvider) : [])];
  const jsonModels = [...loadModelsJsonProviderModels(sourceProvider), ...(aliasProvider ? loadModelsJsonProviderModels(aliasProvider) : [])];
  const builtinModels = [...getModels(sourceProvider as any), ...(aliasProvider ? getModels(aliasProvider as any) : [])];
  const templateModels = template.models || [];
  const baseModels = Array.from(new Map([...registryModels, ...jsonModels, ...builtinModels].map((m) => [m.id, m])).values());
  const baseArr = [...baseModels] as Model<Api>[];
  const baseUrl = baseArr[0]?.baseUrl || templateModels[0]?.baseUrl || "";
  const api = baseArr[0]?.api || templateModels[0]?.api;
  const cloned = baseArr.length > 0 ? cloneModels(sourceProvider, entry.index, ctx, aliasProvider) : [];
  const models = Array.from(new Map([...cloned, ...templateModels].map((m) => [m.id, m])).values()) as Iterable<Model<Api>>;

  console.log('[registerSub] registering provider:', name, 'models:', models?.length || 'unknown');
  pi.registerProvider(name, {
    baseUrl,
    api,
    ...(template.useOAuth !== false ? { oauth: modifyModels ? { ...oauth, modifyModels } : oauth } : { apiKey: "placeholder" }),
    models: [...models],
  });
}

// ===========================================================================
// UI helpers for provider/model selection
// ===========================================================================

function formatModelDescription(m: Model<Api>): string {
  const caps = m.input?.join(",") || "text";
  const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : "";
  return [caps, ctx].filter(Boolean).join(" | ");
}

export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_TEMPLATES);

function getAllProviderOptions(ctx: ExtensionCommandContext, config: MultiPassConfig): SelectItem[] {
  const seen = new Set<string>();
  const items: SelectItem[] = [];
  for (const p of SUPPORTED_PROVIDERS) {
    const key = p;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ value: key, label: key, description: PROVIDER_TEMPLATES[p]?.displayName || p + " (system)" });
  }
  for (const sub of config.subscriptions) {
    const name = subProviderName(sub);
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({ value: name, label: name, description: subDisplayName(sub) });
  }
  return items;
}

function getSelectableModelsForProvider(ctx: ExtensionCommandContext, providerName: string): string[] {
  const base = getBaseProvider(providerName) ?? providerName;
  const template = PROVIDER_TEMPLATES[base as keyof typeof PROVIDER_TEMPLATES];
  const source = template?.sourceProvider ?? base;
  const alias = source === base ? undefined : base;
  const registry = [...ctx.modelRegistry.getAll().filter((m) => m.provider === source || (alias && m.provider === alias))];
  const json = [...loadModelsJsonProviderModels(source)];
  const system = [...getModels(source as any)];
  const tmpl = template?.models || [];
  const all = Array.from(new Map([...registry, ...json, ...system, ...tmpl].map((m) => [m.id, m])).values());
  return [...all].map((m) => m.id);
}

// ===========================================================================
// Unified model switching
// ===========================================================================

/**
 * Get all model objects for a given provider name from the registry.
 */
export function getModelsForProvider(ctx: { modelRegistry: { getAll(): any[] } }, provider: string): any[] {
  return ctx.modelRegistry.getAll().filter((m: any) => m.provider === provider) as any[];
}

/**
 * Interactive: let user pick a model from a provider, then switch to it.
 * Returns true if switch succeeded.
 */
export async function pickAndSwitchModel(
  pi: { setModel(model: any): Promise<boolean> },
  ctx: { modelRegistry: { getAll(): any[] }; ui: { select(message: string, options: string[]): Promise<string | undefined>; notify(message: string, level: string): void; setStatus?(key: string, value: string): void } },
  provider: string,
): Promise<boolean> {
  const models = getModelsForProvider(ctx, provider);
  if (!models.length) {
    ctx.ui.notify(`No models for "${provider}".`, "info");
    return false;
  }
  const labels = models.map((m: any) => `${m.id}${m.reasoning ? " (reasoning)" : ""}`);
  const picked = await ctx.ui.select(`Models for ${provider}:`, labels);
  if (!picked) return false;
  const mi = labels.indexOf(picked);
  const target = mi >= 0 ? models[mi] : models[0];
  return doSwitchModel(pi, ctx, target);
}

/**
 * Programmatic: switch to a specific model by provider + modelId.
 * If no modelId, picks the first available model for that provider.
 */
export async function switchToModel(
  pi: { setModel(model: any): Promise<boolean> },
  ctx: { modelRegistry: { getAll(): any[] }; ui: { notify(message: string, level: string): void; setStatus?(key: string, value: string): void } },
  provider: string,
  modelId?: string,
  fallbackModelId?: string,
): Promise<boolean> {
  const models = getModelsForProvider(ctx, provider);
  if (!models.length) return false;
  const id = modelId || fallbackModelId || "";
  const target = id ? models.find((m: any) => m.id === id) || models[0] : models[0];
  return doSwitchModel(pi, ctx, target);
}

/** Execute the actual model switch. */
async function doSwitchModel(
  pi: { setModel(model: any): Promise<boolean> },
  ctx: { ui: { notify(message: string, level: string): void; setStatus?(key: string, value: string): void } },
  target: any,
): Promise<boolean> {
  const ok = await pi.setModel(target);
  if (ok) {
    ctx.ui.notify(`Switched to ${target.provider}/${target.id}`, "info");
    if (ctx.ui.setStatus) ctx.ui.setStatus("switch", target.provider);
  } else {
    ctx.ui.notify("Failed to switch model.", "error");
  }
  return ok;
}
