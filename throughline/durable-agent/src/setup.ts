// The coding agent's parts the program reuses as libraries: its model runtime and logins, settings, skills, project
// context files and system prompt sections. Pi 1.1's own durable program used the same parts the same way.
// The coding agent's session loop, agent core, JSONL session files, RPC mode and extension bus are not used.

import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	type EnvTarget,
	type Extension,
	type HarnessSettings,
	type ModelRef,
	type PromptInput,
	type Registry,
	section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { getAgentDir } from "../../../packages/coding-agent/dist/config.js";
import { applyHttpProxySettings, configureHttpDispatcher } from "../../../packages/coding-agent/dist/core/http-dispatcher.js";
import { findInitialModel, resolveCliModel } from "../../../packages/coding-agent/dist/core/model-resolver.js";
import { ModelRuntime } from "../../../packages/coding-agent/dist/core/model-runtime.js";
import { loadProjectContextFiles } from "../../../packages/coding-agent/dist/core/resource-loader.js";
import { SettingsManager } from "../../../packages/coding-agent/dist/core/settings-manager.js";
import { loadSkills, type Skill } from "../../../packages/coding-agent/dist/core/skills.js";
import { buildSystemPromptSections } from "../../../packages/coding-agent/dist/core/system-prompt.js";
import { bashToolSystemPromptContribution } from "../../../packages/coding-agent/dist/core/tools/bash.js";
import { editToolSystemPromptContribution } from "../../../packages/coding-agent/dist/core/tools/edit.js";
import { readToolSystemPromptContribution } from "../../../packages/coding-agent/dist/core/tools/read.js";
import { writeToolSystemPromptContribution } from "../../../packages/coding-agent/dist/core/tools/write.js";

export { ModelRuntime, SettingsManager };

/** pi's HTTP setup: proxy, idle timeouts, and one undici for fetch. Without it, some provider streams break off. */
export function configureHttp(settings: SettingsManager): void {
	applyHttpProxySettings(settings.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settings.getHttpIdleTimeoutMs());
}

/**
 * Harness settings read at every use from pi's settings. Automatic compaction stays off (the factory design keeps
 * it off and uses a manual compact); everything else follows pi's own settings file.
 */
export function harnessSettings(settings: SettingsManager): HarnessSettings {
	return {
		get stream() {
			const provider = settings.getProviderRetrySettings();
			const idle = settings.getHttpIdleTimeoutMs();
			return {
				timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
				maxRetryDelayMs: provider.maxRetryDelayMs,
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
			};
		},
		compaction: { enabled: false },
		get retry() {
			return settings.getRetrySettings();
		},
		get steeringMode() {
			return settings.getSteeringMode();
		},
		get followUpMode() {
			return settings.getFollowUpMode();
		},
	};
}

const CONTRIBUTIONS = {
	read: readToolSystemPromptContribution,
	bash: bashToolSystemPromptContribution,
	edit: editToolSystemPromptContribution,
	write: writeToolSystemPromptContribution,
} as const;

/** pi's section order; `buildSystemPromptSections()` omits the ones without content. */
const KEYS = ["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"] as const;
const PI_PROMPT_NAME = "pi-prompt";

/**
 * pi's system prompt as one Durable extension: the sections of `buildSystemPromptSections()` for the request's tools
 * and the conversation's directory. Context files and skills load once per directory, as pi does at startup.
 */
export function createPiPrompt(settings: SettingsManager, fallbackCwd: string) {
	const resources = new Map<string, { contextFiles: { path: string; content: string }[]; skills: Skill[] }>();
	const load = (cwd: string) => {
		let found = resources.get(cwd);
		if (found === undefined) {
			const agentDir = getAgentDir();
			found = {
				contextFiles: loadProjectContextFiles({ cwd, agentDir }),
				skills: loadSkills({ cwd, agentDir, skillPaths: settings.getSkillPaths(), includeDefaults: true }).skills,
			};
			resources.set(cwd, found);
		}
		return found;
	};
	const built = new WeakMap<PromptInput, Record<string, string>>();
	const build = (input: PromptInput): Record<string, string> => {
		let sections = built.get(input);
		if (sections === undefined) {
			const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
			const selectedTools = input.agent.tools.map((tool) => tool.name);
			const toolSnippets: Record<string, string> = {};
			const toolGuidelines: Record<string, string[]> = {};
			for (const name of selectedTools) {
				const contribution = CONTRIBUTIONS[name as keyof typeof CONTRIBUTIONS];
				if (contribution === undefined) continue;
				toolSnippets[name] = contribution.snippet;
				toolGuidelines[name] = [...contribution.guidelines];
			}
			sections = buildSystemPromptSections({ cwd, selectedTools, toolSnippets, toolGuidelines, ...load(cwd) });
			built.set(input, sections);
		}
		return sections;
	};
	return defineExtension({
		name: PI_PROMPT_NAME,
		// The built sections carry their own tags.
		sections: KEYS.map((key) => section(key, (input) => build(input)[key], { tag: false })),
	});
}

/**
 * The extensions every start installs, in the same order. Pi Durable resolves stored extension names against this
 * registry, so a restart must install exactly these again ("After a restart, install the same extensions again").
 */
export function createAgentRegistry(
	settings: SettingsManager,
	cwd: string,
	extra: { first?: readonly Extension[]; after?: readonly Extension[] } = {},
): Registry {
	const registry = createRegistry();
	for (const extension of extra.first ?? []) registry.install(extension);
	registry.install(CodingTools);
	registry.install(createPiPrompt(settings, cwd));
	for (const extension of extra.after ?? []) registry.install(extension);
	return registry;
}

/** One execution environment per directory, shared by every conversation in it. */
export class ExecutionEnvs {
	readonly #defaultCwd: string;
	readonly #envs = new Map<string, NodeExecutionEnv>();

	constructor(defaultCwd: string) {
		this.#defaultCwd = defaultCwd;
	}

	readonly env = ({ cwd = this.#defaultCwd }: EnvTarget): NodeExecutionEnv => {
		let env = this.#envs.get(cwd);
		if (env === undefined) {
			env = new NodeExecutionEnv({ cwd });
			this.#envs.set(cwd, env);
		}
		return env;
	};

	async cleanup(context: Context): Promise<void> {
		const envs = [...this.#envs.values()];
		this.#envs.clear();
		for (const env of envs) await env.cleanup(context);
	}
}

/** The model a new root conversation starts with: an explicit `provider/model`, or pi's default resolution. */
export async function initialModel(
	settings: SettingsManager,
	models: ModelRuntime,
	cli: string | undefined,
): Promise<{ model?: ModelRef; thinkingLevel?: ModelThinkingLevel }> {
	if (cli !== undefined) {
		const resolved = resolveCliModel({ cliModel: cli, modelRuntime: models });
		if (resolved.error !== undefined || resolved.model === undefined) {
			throw new Error(`MODEL_NOT_RESOLVED: ${resolved.error ?? cli}`);
		}
		// A model named without a level takes pi's default thinking level, as the coding agent does.
		const thinkingLevel = resolved.thinkingLevel ?? settings.getDefaultThinkingLevel();
		return {
			model: { provider: resolved.model.provider, modelId: resolved.model.id },
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		};
	}
	const found = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: settings.getDefaultProvider(),
		defaultModelId: settings.getDefaultModel(),
		defaultThinkingLevel: settings.getDefaultThinkingLevel(),
		modelRuntime: models,
	});
	return found.model === undefined
		? {}
		: { model: { provider: found.model.provider, modelId: found.model.id }, thinkingLevel: found.thinkingLevel };
}
