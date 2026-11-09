// The subscription image tools (generate_image, edit_image, inspect_image) as native Durable tools. Their code is the
// shipped subscription-images module, copied by the installer into `capabilities/subscription-images/` beside this
// program and pinned with it, so a later ship of that module never changes a running install. An absent, unloadable
// or incompatible copy never stops the agent: it starts without the tools and says why. The installer refuses such a
// copy before it switches an install in, using the same check.

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
	defineExtension,
	defineTool,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";

/** Where the installed copy of the image module sits, relative to this program. */
export const IMAGE_MODULE_DIR = fileURLToPath(new URL("../capabilities/subscription-images/", import.meta.url));
/** The image tools that never write or call the broker; approvals pass them like read. */
export const READ_ONLY_IMAGE_TOOLS: ReadonlySet<string> = new Set(["inspect_image"]);
const EXTENSION_NAME = "subscription-images";

type RunImageTool = (
	name: string,
	args: unknown,
	cwd: string,
	signal?: AbortSignal,
) => Promise<{ content: ToolExecutionResult["output"]; details: unknown }>;

/**
 * The image tools extension, always under the same name so stored conversations resolve it after a restart. When the
 * copy cannot give working tools, the extension has none, `missing` says why, and the agent starts anyway.
 */
export async function loadImageTools(defaultCwd: string, dir = IMAGE_MODULE_DIR) {
	const empty = defineExtension({ name: EXTENSION_NAME });
	const built = await buildImageTools(dir, defaultCwd);
	if (typeof built === "string") return { extension: empty, empty, missing: built };
	return { extension: defineExtension({ name: EXTENSION_NAME, tools: built }), empty, missing: undefined };
}

/** Undefined when the copy at `dir` gives working image tools; otherwise why not. The installer refuses on a reason. */
export async function imageModuleProblem(dir: string): Promise<string | undefined> {
	const built = await buildImageTools(dir, dir);
	return typeof built === "string" ? built : undefined;
}

// Loading, checking the exported contract and building the tools sit inside one boundary: whatever the copy does wrong
// becomes a reason, never a thrown error at start. A failure while an image tool runs stays that tool call's failure.
async function buildImageTools(dir: string, defaultCwd: string): Promise<ToolRegistration[] | string> {
	const files = ["shared.mjs", "effects.mjs"].map((name) => `${dir}${dir.endsWith("/") ? "" : "/"}${name}`);
	const absent = files.filter((file) => !existsSync(file));
	if (absent.length > 0) return `image tools unavailable: no installed copy at ${absent.join(", ")}`;
	let exports: Record<string, unknown>;
	try {
		// A dynamic import on purpose: the copy lives outside this program's source and its absence must not stop the start.
		const [policy, effects] = await Promise.all(files.map((file) => import(pathToFileURL(file).href)));
		exports = { ...policy, ...effects };
	} catch (error) {
		return `image tools unavailable: the copy at ${dir} did not load (${message(error)})`;
	}
	try {
		return toolsOf(exports, defaultCwd);
	} catch (error) {
		return `image tools unavailable: the copy at ${dir} does not provide usable image tools (${message(error)})`;
	}
}

/** The image tools the pinned module must provide, no more and no fewer. */
export const IMAGE_TOOL_NAMES: readonly string[] = ["generate_image", "edit_image", "inspect_image"];

function toolsOf(exports: Record<string, unknown>, defaultCwd: string): ToolRegistration[] {
	const descriptions = exports.imageToolDescriptions;
	const parameters = exports.imageToolParameters;
	const run = exports.runImageTool;
	if (!isRecord(descriptions)) throw new Error("imageToolDescriptions is not an object");
	if (!isRecord(parameters)) throw new Error("imageToolParameters is not an object");
	if (typeof run !== "function") throw new Error("runImageTool is not a function");
	const names = Object.keys(descriptions);
	// The capability is exactly these three tools: a copy that lacks one would silently drop generating or editing,
	// and an extra name is a module this program was not written for.
	const missing = IMAGE_TOOL_NAMES.filter((name) => !names.includes(name));
	if (missing.length > 0) throw new Error(`the copy lacks ${missing.join(", ")}`);
	const extra = names.filter((name) => !IMAGE_TOOL_NAMES.includes(name));
	if (extra.length > 0) throw new Error(`the copy declares tools this program does not know: ${extra.join(", ")}`);
	return names.map((name) => {
		const description = descriptions[name];
		const schema = parameters[name];
		if (typeof description !== "string" || description.length === 0) throw new Error(`${name} has no description`);
		if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) throw new Error(`${name} has no object parameter schema`);
		return defineTool({
			name,
			description,
			// The module's parameters are TypeBox JSON Schema, which Durable accepts as plain JSON Schema.
			parameters: schema,
			execute: async (input: unknown, api: ToolExecutionApi, context: Context) => {
				const response = await (run as RunImageTool)(name, input, api.env?.cwd ?? defaultCwd, context.abortSignal);
				return { output: response.content, details: JSON.parse(JSON.stringify(response.details ?? null)) as JsonValue };
			},
		} as never);
	});
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
