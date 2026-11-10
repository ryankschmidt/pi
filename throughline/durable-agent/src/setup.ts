// The coding agent's parts the program reuses as libraries, through its public package entry only: model runtime and
// logins, settings, skills and project context files. The system prompt is the program's own: it describes this
// program and Durable's own tools, not interactive pi. The coding agent's session loop, agent core, JSONL session
// files, RPC mode and extension bus are not used.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	formatSkillsForPrompt,
	getAgentDir,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
	loadProjectContextFiles,
	loadSkills,
	ModelRuntime,
	resolveCliModel,
	SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
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
import { createConversationSnapshotExtension, SNAPSHOT_TOOL } from "./conversation-snapshot.ts";

export { ModelRuntime, SettingsManager };

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

/** What the prompt and the skill commands read for one working folder: its context files and skills. */
export type FolderResources = { contextFiles: { path: string; content: string }[]; skills: Skill[] };

/**
 * Skills pinned inside the installed program (show-me, copied by the installer from Ship Warden's shipped copy), so the
 * skill commands ThroughLine's menu offers are listed for the model without an edit to pi's settings. A pinned skill wins over any skill
 * of the same name in pi's default, project or configured skills: the install checked these bytes, the others it never saw.
 */
export const PINNED_SKILLS_DIR = fileURLToPath(new URL("../capabilities/skills/", import.meta.url));
/** The pinned show-me folder; when it carries its tool, commands the agent runs find it through SHOW_ME_HOME (show-me.md). */
const PINNED_SHOW_ME = join(PINNED_SKILLS_DIR, "show-me");
if (existsSync(join(PINNED_SHOW_ME, "dist/cli.js"))) process.env.SHOW_ME_HOME = PINNED_SHOW_ME;

/**
 * Pi's resources for the program: the global APPEND_SYSTEM.md, read once, and each folder's context files and skills,
 * loaded once per folder as pi does at startup. The prompt and skill-command submission share one copy.
 */
export class AgentResources {
	readonly #settings: SettingsManager;
	readonly #fallbackCwd: string;
	readonly #folders = new Map<string, FolderResources>();
	#append: string | undefined | null = null;

	constructor(settings: SettingsManager, fallbackCwd: string) {
		this.#settings = settings;
		this.#fallbackCwd = fallbackCwd;
	}

	/** The working folder a request's prompt is built for. */
	cwdOf(input: PromptInput): string {
		return input.env?.cwd ?? input.agent.cwd ?? this.#fallbackCwd;
	}

	/** Context files and skills of a working folder; the program's own folder when none is given. */
	folder(cwd: string = this.#fallbackCwd): FolderResources {
		let found = this.#folders.get(cwd);
		if (found === undefined) {
			const agentDir = getAgentDir();
			// Pi's loader keeps the first skill of a name, so the pinned ones are loaded on their own and replace same-named others.
			const pinned = existsSync(PINNED_SKILLS_DIR)
				? loadSkills({ cwd, agentDir, skillPaths: [PINNED_SKILLS_DIR], includeDefaults: false }).skills
				: [];
			const pinnedNames = new Set(pinned.map((skill) => skill.name));
			const others = loadSkills({ cwd, agentDir, skillPaths: this.#settings.getSkillPaths(), includeDefaults: true }).skills;
			found = {
				contextFiles: loadProjectContextFiles({ cwd, agentDir }),
				skills: [...others.filter((skill) => !pinnedNames.has(skill.name)), ...pinned],
			};
			this.#folders.set(cwd, found);
		}
		return found;
	}

	/**
	 * The global `APPEND_SYSTEM.md` in pi's agent folder, or undefined. A project's own APPEND_SYSTEM.md is not read:
	 * stock pi reads it only for projects the user trusted, and the program has no trust prompt.
	 */
	append(): string | undefined {
		if (this.#append === null) {
			const file = join(getAgentDir(), "APPEND_SYSTEM.md");
			const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
			this.#append = text.length > 0 ? text : undefined;
		}
		return this.#append;
	}
}

// Durable's own coding tools (`CodingTools`), described in this program's words; their schemas are Durable's
// (for example edit takes `edits[].oldText`).
const TOOL_LINES: Record<string, { line: string; rules: string[] }> = {
	read: { line: "Read file contents", rules: ["Use read to examine files instead of cat or sed."] },
	bash: { line: "Execute bash commands (ls, grep, find, etc.)", rules: [] },
	edit: {
		line: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		rules: [
			"Use edit for targeted changes. Batch changes to one file in a single call.",
			"Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
		],
	},
	write: { line: "Create or overwrite files", rules: ["Use write only for new files or complete rewrites."] },
};
const PREAMBLE =
	"You are a coding agent run by ThroughLine's Pi Durable agent program. Help users inspect files, run commands, and modify code.";
const PI_PROMPT_NAME = "pi-prompt";

// Durable agents work on the Pi harness, Pi Durable and this program, so they keep stock pi's pointer to current
// documentation, scoped to this program instead of interactive pi.
const DURABLE_PACKAGE_DIR = (() => {
	let directory = dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-durable"));
	while (!existsSync(join(directory, "package.json")) && dirname(directory) !== directory) directory = dirname(directory);
	return directory;
})();
const DOCS = `Pi and Pi Durable documentation (read when working on the Pi harness, Pi Durable, their SDKs, extensions, skills, models or providers):
- Pi: ${getReadmePath()}; additional docs ${getDocsPath()}; examples ${getExamplesPath()} (extensions, custom tools, SDK)
- Pi Durable: ${join(DURABLE_PACKAGE_DIR, "README.md")}; specification and docs ${join(DURABLE_PACKAGE_DIR, "docs")}
- Resolve docs/... and examples/... under these folders, not the current working directory.
- Before changing the harness or Pi Durable, read the relevant docs and examples in full, following related cross-references.
- This agent runs on Pi Durable, not interactive pi: interactive pi's TUI, keybindings and themes do not apply to it.`;

// Skill commands are ordinary text: the user's message is stored as typed, and the model opens the named skill's file
// with read, so its body is a stored tool result of the run the message started. Stock pi's skill list leaves out
// command-only skills (disable-model-invocation), so they are listed here with the rule that reads them.
function commandsText(skills: readonly Skill[]): string {
	const commands = skills.filter((skill) => skill.disableModelInvocation);
	const lines = [
		"When the user's message begins with /<name> for a command listed below, or /skill:<name> for any listed skill or command, read that file with read before anything else and follow it. The rest of the message is its arguments; where the file says $ARGUMENTS, use that text.",
	];
	if (commands.length > 0) {
		lines.push("", "<available_commands>");
		for (const command of commands) {
			lines.push(
				"  <command>",
				`    <name>${escapeXml(command.name)}</name>`,
				`    <description>${escapeXml(command.description)}</description>`,
				`    <location>${escapeXml(command.filePath)}</location>`,
				"  </command>",
			);
		}
		lines.push("</available_commands>");
	}
	return commands.length > 0 || skills.length > 0 ? lines.join("\n") : "";
}

const escapeXml = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** The program's system prompt as one Durable extension: preamble, tools, rules, addendum, context, skills, folder. */
export function createPiPrompt(resources: AgentResources) {
	const ownTools = (input: PromptInput) => input.agent.tools.map((tool) => tool.name).filter((name) => name in TOOL_LINES);
	return defineExtension({
		name: PI_PROMPT_NAME,
		sections: [
			section("preamble", () => PREAMBLE, { tag: false }),
			section("tools", (input) => {
				const lines = ownTools(input).map((name) => `- ${name}: ${TOOL_LINES[name]?.line}`);
				return `${lines.length > 0 ? lines.join("\n") : "(none)"}\n\nAdditional tools may be available.`;
			}),
			section("rules", (input) => {
				const names = ownTools(input);
				const rules = [
					...(names.includes("bash") ? ["Use bash for file operations like ls, rg, find"] : []),
					...names.flatMap((name) => TOOL_LINES[name]?.rules ?? []),
					"Be concise in your responses",
					"Show file paths clearly when working with files",
				];
				return rules.map((rule) => `- ${rule}`).join("\n");
			}),
			section("docs", () => DOCS),
			section("addendum", () => resources.append()),
			section("project_context", (input) => {
				const files = resources.folder(resources.cwdOf(input)).contextFiles;
				if (files.length === 0) return undefined;
				return [
					"Project-specific instructions and guidelines:",
					...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
				].join("\n\n");
			}),
			section("skills", (input) => {
				const skills = resources.folder(resources.cwdOf(input)).skills;
				const text = [formatSkillsForPrompt(skills, "read").trim(), commandsText(skills)].filter((part) => part.length > 0).join("\n\n");
				return text.length > 0 ? text : undefined;
			}),
			section(
				"transcript",
				() => `Where a skill asks for this conversation's transcript, call ${SNAPSHOT_TOOL} and use the path it returns.`,
			),
			section("cwd", (input) => resources.cwdOf(input).replace(/\\/g, "/")),
		],
	});
}

/**
 * The extensions every start installs, in the same order. Pi Durable resolves stored extension names against this
 * registry, so a restart must install exactly these again ("After a restart, install the same extensions again").
 */
export function createAgentRegistry(
	resources: AgentResources,
	storeDir: string,
	extra: { first?: readonly Extension[]; after?: readonly Extension[] } = {},
): Registry {
	const registry = createRegistry();
	for (const extension of extra.first ?? []) registry.install(extension);
	registry.install(CodingTools);
	registry.install(createPiPrompt(resources));
	registry.install(createConversationSnapshotExtension(storeDir));
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

/**
 * The model a new root conversation starts with: an explicit `provider/model`, else pi's default provider and model.
 * With neither, or a default that does not resolve, it starts with no model and ThroughLine's first configure sets
 * one; it never picks another model that happens to have a login.
 */
export function initialModel(
	settings: SettingsManager,
	models: ModelRuntime,
	cli: string | undefined,
): { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } {
	const resolved =
		cli !== undefined
			? resolveCliModel({ cliModel: cli, modelRuntime: models })
			: resolveCliModel({ cliProvider: settings.getDefaultProvider(), cliModel: settings.getDefaultModel(), modelRuntime: models });
	if (resolved.error !== undefined || resolved.model === undefined) {
		if (cli !== undefined) throw new Error(`MODEL_NOT_RESOLVED: ${resolved.error ?? cli}`);
		return {};
	}
	// The resolver turns an unknown id under a known provider into a custom model. Right for an explicit --model;
	// for a saved default it means a model that no longer exists, so wait for ThroughLine's configure instead.
	if (cli === undefined && models.getModel(resolved.model.provider, resolved.model.id) === undefined) return {};
	// A model named without a level takes pi's default thinking level, as the coding agent does.
	const thinkingLevel = resolved.thinkingLevel ?? settings.getDefaultThinkingLevel();
	return {
		model: { provider: resolved.model.provider, modelId: resolved.model.id },
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
	};
}
