// extensions/replace-tool.ts
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type ReplaceArgs = {
	path: string;
	search: string;
	replace: string;
	isRegex?: boolean;
};

function normalizeArgs(args: unknown): ReplaceArgs {
	if (!args || typeof args !== "object") {
		return { path: "", search: "", replace: "" };
	}
	const input = args as Record<string, unknown>;
	return {
		path: typeof input.path === "string"
			? input.path
			: typeof input.file === "string"
				? input.file
				: typeof input.filePath === "string"
					? input.filePath
					: "",
		search: typeof input.search === "string"
			? input.search
			: typeof input.old === "string"
				? input.old
				: typeof input.oldText === "string"
					? input.oldText
					: typeof input.pattern === "string"
						? input.pattern
						: "",
		replace: typeof input.replace === "string"
			? input.replace
			: typeof input.replacement === "string"
				? input.replacement
				: typeof input.newText === "string"
					? input.newText
					: "",
		isRegex: typeof input.isRegex === "boolean"
			? input.isRegex
			: typeof input.regex === "boolean"
				? input.regex
				: false,
	};
}

function resolveWithinCwd(rawPath: string, cwd: string): string {
	const cleanPath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	const absolutePath = isAbsolute(cleanPath) ? resolve(cleanPath) : resolve(cwd, cleanPath);
	const cwdWithSep = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`;
	if (absolutePath !== cwd && !absolutePath.startsWith(cwdWithSep)) {
		throw new Error(`Path must stay inside the current working directory: ${rawPath}`);
	}
	return absolutePath;
}

function findFirstReplacement(content: string, args: Required<ReplaceArgs>) {
	if (args.search.length === 0) {
		throw new Error("search must not be empty");
	}

	if (args.isRegex) {
		const regex = new RegExp(args.search, "u");
		const match = content.match(regex);
		if (!match || match.index === undefined) {
			return undefined;
		}
		const oldText = match[0];
		return {
			oldText,
			newText: content.replace(regex, args.replace),
		};
	}

	const index = content.indexOf(args.search);
	if (index === -1) return undefined;
	return {
		oldText: args.search,
		newText: `${content.slice(0, index)}${args.replace}${content.slice(index + args.search.length)}`,
	};
}

export default function replaceTool(pi: ExtensionAPI) {
	const tool: ToolDefinition = {
		name: "replace",
		label: "Replace text in a file",
		description: "Replace the first literal text or regex match in a local file. Use this for small, precise edits such as changing one config value, function name, string, or code snippet.",
		promptSnippet: "replace(path, search, replace, isRegex?) → file edited",
		promptGuidelines: [
			"Use replace when the user asks to modify a specific piece of code or configuration inside a file.",
			"Use replace only for small targeted edits; use write for creating whole files or large rewrites.",
			"The replace tool replaces only the first match unless the user explicitly asks for a different replacement strategy.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to modify, relative to the current working directory." }),
			search: Type.String({ description: "The literal text or JavaScript RegExp pattern to look for." }),
			replace: Type.String({ description: "Replacement text. In regex mode, use JavaScript replacement references like $1, $2, $&, and $`." }),
			isRegex: Type.Optional(Type.Boolean({ description: "Treat search as a JavaScript RegExp pattern without delimiters.", default: false })),
		}),
		executionMode: "sequential",
		prepareArguments(args) {
			return normalizeArgs(args) as any;
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Replace cancelled." }], details: { path: params.path, success: false, cancelled: true } };
			}

			const absolutePath = resolveWithinCwd(params.path, ctx.cwd);

			onUpdate?.({
				content: [{ type: "text", text: `Replacing in ${params.path}…` }],
				details: { path: params.path, isRegex: params.isRegex ?? false },
			});

			return withFileMutationQueue(absolutePath, async () => {
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Replace cancelled." }], details: { path: params.path, success: false, cancelled: true } };
				}

				const current = await readFile(absolutePath, "utf8");
				const replacement = findFirstReplacement(current, {
					path: params.path,
					search: params.search,
					replace: params.replace,
					isRegex: params.isRegex ?? false,
				});

				if (!replacement) {
					return {
						content: [{ type: "text", text: `No match found for ${params.isRegex ? "regex" : "text"} "${params.search}" in ${params.path}.` }],
						details: { path: params.path, success: false },
					};
				}

				await writeFile(absolutePath, replacement.newText, "utf8");

				return {
					content: [{ type: "text", text: `Replaced first occurrence in ${params.path}.` }],
					details: {
						path: params.path,
						success: true,
						isRegex: params.isRegex ?? false,
						oldText: replacement.oldText,
						newText: replacement.newText,
					},
				};
			});
		},
		renderCall(args, theme, _context) {
			let txt = theme.fg("toolTitle", theme.bold("replace "));
			txt += theme.fg("accent", `"${args.search}"`);
			txt += theme.fg("muted", ` in ${args.path}`);
			if (args.isRegex) txt += theme.fg("dim", " --regex");
			return new Text(txt, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Replacing..."), 0, 0);
			const details = result.details as { success?: boolean; oldText?: string; newText?: string };
			if (!details?.success) {
				return new Text(theme.fg("warning", "Replace failed"), 0, 0);
			}
			let txt = theme.fg("success", "Replaced first occurrence");
			if (expanded && details.oldText !== undefined && details.newText !== undefined) {
				txt += `\n${theme.fg("dim", `from: ${details.oldText}`)}`;
				txt += `\n${theme.fg("dim", `to:   ${details.newText}`)}`;
			}
			return new Text(txt, 0, 0);
		},
	};

	pi.registerTool(tool);
}
