// The subscription image tools (generate_image, edit_image, inspect_image) as native Durable tools. Their code is the
// shipped subscription-images module, copied by the installer into `capabilities/subscription-images/` beside this
// program and pinned with it, so a later ship of that module never changes a running install. The agent starts
// without the tools when the copy is absent; the installer, not a live thread, is where a missing copy is refused.

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context, JsonValue } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";

/** Where the installed copy of the image module sits, relative to this program. */
const IMAGE_MODULE_DIR = fileURLToPath(new URL("../capabilities/subscription-images/", import.meta.url));
/** The image tools that never write or call the broker; approvals pass them like read. */
export const READ_ONLY_IMAGE_TOOLS: ReadonlySet<string> = new Set(["inspect_image"]);
const EXTENSION_NAME = "subscription-images";

type ImageModule = {
	imageToolDescriptions: Record<string, string>;
	imageToolParameters: Record<string, object>;
	runImageTool(
		name: string,
		args: unknown,
		cwd: string,
		signal?: AbortSignal,
	): Promise<{ content: ToolExecutionResult["output"]; details: unknown }>;
};

/**
 * The image tools extension. Always installed under the same name, so stored conversations resolve it after a
 * restart; with no module copy it has no tools and `missing` says why.
 */
export async function loadImageTools(defaultCwd: string) {
	const module = await importModule(IMAGE_MODULE_DIR);
	if (typeof module === "string") return { extension: defineExtension({ name: EXTENSION_NAME }), missing: module };
	const tools = Object.keys(module.imageToolDescriptions).map((name) =>
		defineTool({
			name,
			description: module.imageToolDescriptions[name],
			parameters: module.imageToolParameters[name],
			execute: async (input: unknown, api: ToolExecutionApi, context: Context) => {
				const response = await module.runImageTool(name, input, api.env?.cwd ?? defaultCwd, context.abortSignal);
				return { output: response.content, details: JSON.parse(JSON.stringify(response.details)) as JsonValue };
			},
			// The module's parameters are TypeBox JSON Schema, which Durable accepts as plain JSON Schema.
		} as never),
	);
	return { extension: defineExtension({ name: EXTENSION_NAME, tools }), missing: undefined };
}

// A dynamic import on purpose: the copy lives outside this program's source and its absence must not stop the start.
async function importModule(dir: string): Promise<ImageModule | string> {
	const files = ["shared.mjs", "effects.mjs"].map((name) => `${dir}${name}`);
	const absent = files.filter((file) => !existsSync(file));
	if (absent.length > 0) return `image tools unavailable: no installed copy at ${absent.join(", ")}`;
	try {
		const [policy, effects] = await Promise.all(files.map((file) => import(pathToFileURL(file).href)));
		return { ...policy, ...effects } as ImageModule;
	} catch (error) {
		return `image tools unavailable: the copy at ${dir} did not load (${error instanceof Error ? error.message : String(error)})`;
	}
}
