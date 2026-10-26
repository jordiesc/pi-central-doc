/**
 * pi-central-doc (tool: central_doc) — delegate documentation questions to a
 * dedicated research session.
 *
 * The model calls `central_doc` when it needs facts from the central documentation
 * hub. The extension spawns a separate `pi` process with a configurable model,
 * rooted at a configurable documentation folder, and restricted (by default) to
 * read-only tools. The research session returns a cited answer; the parent
 * session's context only grows by that answer.
 *
 * Configuration: see config.ts and README.md next to this file.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	DEFAULT_SYSTEM_PROMPT,
	type CentralDocConfig,
	type FlagOverrides,
	type LoadedConfig,
	describeConfig,
	loadConfig,
} from "./config.ts";
import {
	PUBLISH_SYSTEM_PROMPT,
	PUBLISH_USAGE,
	buildPublishPrompt,
	formatPublishReport,
	INLINE_SOURCE_BYTES,
	gitChanges,
	parsePublishArgs,
	readFileSource,
	readSessionSource,
	runValidator,
	writeTempSource,
} from "./publish.ts";

const MAX_SOURCES = 20;
const MAX_STEPS = 40;
const MAX_STDERR_BYTES = 4_000;

const CentralDocParams = Type.Object({
	question: Type.String({
		description: "What you need to know from the documentation, as a complete, self-contained question.",
	}),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional hints: documentation files or folders (relative to the docs root) worth checking first, e.g. [\"omd/\", \"glossary.md\"].",
		}),
	),
	excerptsOnly: Type.Optional(
		Type.Boolean({
			description:
				"When true, prefer short verbatim excerpts with file paths over a synthesized answer. Default: false.",
		}),
	),
});

interface ResearchStep {
	tool: string;
	summary: string;
}

interface CentralDocDetails {
	question: string;
	docsDir: string;
	model?: string;
	ok: boolean;
	exitCode: number;
	stopReason?: string;
	error?: string;
	timedOut: boolean;
	sources: string[];
	steps: ResearchStep[];
	usage: Usage;
	turns: number;
	durationMs: number;
	truncated: boolean;
	warnings: string[];
}

interface ResearchOutcome {
	ok: boolean;
	answer: string;
	error?: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	timedOut: boolean;
	aborted: boolean;
	sources: string[];
	steps: ResearchStep[];
	usage: Usage;
	turns: number;
	durationMs: number;
	truncated: boolean;
	stderr: string;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(target: Usage, source: Usage | undefined): void {
	if (!source) return;
	target.input += source.input || 0;
	target.output += source.output || 0;
	target.cacheRead += source.cacheRead || 0;
	target.cacheWrite += source.cacheWrite || 0;
	target.totalTokens += source.totalTokens || 0;
	target.cost.input += source.cost?.input || 0;
	target.cost.output += source.cost?.output || 0;
	target.cost.cacheRead += source.cost?.cacheRead || 0;
	target.cost.cacheWrite += source.cost?.cacheWrite || 0;
	target.cost.total += source.cost?.total || 0;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsage(usage: Usage, model?: string, turns?: number): string {
	const parts: string[] = [];
	if (turns) parts.push(`${turns} turn${turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
	let slice = text.slice(0, maxBytes);
	while (Buffer.byteLength(slice, "utf8") > maxBytes) slice = slice.slice(0, -1);
	const omitted = Buffer.byteLength(text, "utf8") - Buffer.byteLength(slice, "utf8");
	return { text: `${slice}\n\n[truncated: ${omitted} bytes omitted; the complete answer is kept in the tool call details]`, truncated: true };
}

function shortenPath(value: string, baseDir: string): string {
	const home = os.homedir();
	if (value.startsWith(baseDir + path.sep)) return value.slice(baseDir.length + 1);
	if (value.startsWith(home)) return `~${value.slice(home.length)}`;
	return value;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function buildPrompt(config: CentralDocConfig, question: string, paths: string[] | undefined, excerptsOnly: boolean | undefined): string {
	const sections = [`Question: ${question.trim()}`];

	const hints = (paths ?? []).map((item) => item.trim()).filter(Boolean);
	if (hints.length > 0) {
		sections.push(`Start with these locations (relative to the documentation root, best effort): ${hints.join(", ")}`);
	}

	if (excerptsOnly) {
		sections.push(
			"Prefer short verbatim excerpts with their file paths and headings over a synthesized answer.",
		);
	}

	sections.push(
		`Your working directory is the documentation root; start from ${config.entryFile} when you need orientation.`,
	);
	return sections.join("\n\n");
}

interface ChildInvocation {
	model?: string;
	thinkingLevel: string;
	tools: string[];
	extraPiArgs?: string[];
}

function buildArgs(options: ChildInvocation, systemPromptPath: string | undefined): string[] {
	const args = ["--mode", "json", "-p", "--no-session"];

	// The documentation folder is often a git repository. Do not load its project
	// extensions or MCP servers into the child session.
	args.push("--no-extensions", "--no-mcp");

	if (options.tools.length > 0) args.push("--tools", options.tools.join(","));
	if (options.model) args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
	if (options.extraPiArgs && options.extraPiArgs.length > 0) args.push(...options.extraPiArgs);

	return args;
}

function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function collectFromToolCall(steps: ResearchStep[], sources: Set<string>, name: string, args: Record<string, unknown>): void {
	let summary = name;
	if (name === "read") {
		const file = (args.file_path ?? args.path) as string | undefined;
		if (file) {
			sources.add(file);
			summary = `read ${file}`;
		}
	} else if (name === "grep") {
		const pattern = (args.pattern as string | undefined) ?? "";
		const where = (args.path as string | undefined) ?? ".";
		summary = `grep /${pattern}/ in ${where}`;
	} else if (name === "find") {
		const where = (args.path as string | undefined) ?? ".";
		const pattern = (args.pattern as string | undefined) ?? "*";
		summary = `find ${pattern} in ${where}`;
	} else if (name === "ls") {
		const where = (args.path as string | undefined) ?? ".";
		summary = `ls ${where}`;
	} else {
		const encoded = JSON.stringify(args);
		summary = `${name} ${encoded.length > 120 ? `${encoded.slice(0, 120)}...` : encoded}`;
	}
	if (steps.length < MAX_STEPS) steps.push({ tool: name, summary });
}

async function writeSystemPrompt(prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-central-doc-"));
	const filePath = path.join(dir, "system-prompt.md");
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir, filePath };
}

async function saveSubagentModel(configPath: string, model: string | null | undefined): Promise<void> {
	await withFileMutationQueue(configPath, async () => {
		let config: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(await fs.promises.readFile(configPath, "utf-8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error("expected a JSON object");
			}
			config = parsed as Record<string, unknown>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(`Cannot update ${configPath}: ${(error as Error).message}`);
			}
		}

		const hasOverride = Object.prototype.hasOwnProperty.call(config, "subagentModel");
		if (model === undefined && !hasOverride) return;
		if (model === undefined) delete config.subagentModel;
		else config.subagentModel = model;

		const parentDir = path.dirname(configPath);
		await fs.promises.mkdir(parentDir, { recursive: true });
		const tempDir = await fs.promises.mkdtemp(path.join(parentDir, ".pi-central-doc-config-"));
		try {
			const tempPath = path.join(tempDir, path.basename(configPath));
			await fs.promises.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
				encoding: "utf-8",
				mode: 0o600,
			});
			await fs.promises.rename(tempPath, configPath);
		} finally {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		}
	});
}

function resolveModel(config: CentralDocConfig, ctx: ExtensionContext): string | undefined {
	if (config.subagentModel !== undefined) {
		if (config.subagentModel) return config.subagentModel;
		return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	}
	if (config.model) return config.model;
	if (ctx.model) return `${ctx.model.provider}/${ctx.model.id}`;
	return undefined;
}

interface SessionRunOptions {
	cwd: string;
	model?: string;
	thinkingLevel: string;
	tools: string[];
	timeoutMs: number;
	systemPrompt: string;
	prompt: string;
	extraPiArgs?: string[];
	signal?: AbortSignal;
	onProgress?: (partial: string, sources: string[], steps: ResearchStep[]) => void;
}

/** Runs one child `pi` session in JSON mode and collects its answer, steps and usage. */
async function runSession(options: SessionRunOptions): Promise<ResearchOutcome> {
	const startedAt = Date.now();
	const messages: Message[] = [];
	const steps: ResearchStep[] = [];
	const sources = new Set<string>();
	const usage = emptyUsage();

	let stderr = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let timedOut = false;
	let aborted = false;
	let exitCode = 1;

	let tmpDir: string | undefined;
	try {
		const tmp = await writeSystemPrompt(options.systemPrompt);
		tmpDir = tmp.dir;

		const args = buildArgs(options, tmp.filePath);
		args.push(options.prompt);

		const invocation = getPiInvocation(args);

		exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			let killTimer: NodeJS.Timeout | undefined;
			const kill = () => {
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => {
					// `proc.killed` only reports that a signal was sent, so inspect the exit state.
					if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
				}, 5_000);
			};

			const timeout = setTimeout(() => {
				timedOut = true;
				kill();
			}, options.timeoutMs);

			const onAbort = () => {
				aborted = true;
				kill();
			};
			if (options.signal) {
				if (options.signal.aborted) onAbort();
				else options.signal.addEventListener("abort", onAbort, { once: true });
			}

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const message = event.message as Message;
					messages.push(message);

					if (message.role === "assistant") {
						const reported = (message as { usage?: Usage }).usage;
						addUsage(usage, reported);
						const reason = (message as { stopReason?: string }).stopReason;
						if (reason) stopReason = reason;
						const failure = (message as { errorMessage?: string }).errorMessage;
						if (failure) errorMessage = failure;

						for (const part of message.content) {
							if (part.type === "toolCall") {
								collectFromToolCall(steps, sources, part.name, part.arguments as Record<string, unknown>);
							}
						}

						if (options.onProgress) {
							options.onProgress(getFinalAssistantText(messages), [...sources], [...steps]);
						}
					}
					return;
				}

				// Some tool results arrive as their own entries in JSON mode.
				if (event.type === "tool_result_end" && event.message) {
					const message = event.message as Message;
					messages.push(message);
					if (options.onProgress) options.onProgress(getFinalAssistantText(messages), [...sources], [...steps]);
				}
			};

			proc.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (chunk: Buffer) => {
				if (Buffer.byteLength(stderr, "utf8") < 64_000) stderr += chunk.toString();
			});

			proc.on("error", (error) => {
				errorMessage = error.message;
				resolve(1);
			});

			proc.on("close", (code) => {
				clearTimeout(timeout);
				if (killTimer) clearTimeout(killTimer);
				if (options.signal) options.signal.removeEventListener("abort", onAbort);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});
		});
	} catch (error) {
		errorMessage = (error as Error).message;
		exitCode = 1;
	} finally {
		if (tmpDir) {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}

	const answer = getFinalAssistantText(messages);
	const turns = messages.filter((message) => message.role === "assistant").length;
	const failed = timedOut || aborted || exitCode !== 0 || stopReason === "error" || stopReason === "aborted";
	const error = timedOut
		? `timed out after ${options.timeoutMs} ms`
		: aborted
			? "aborted by the calling session"
			: failed
				? errorMessage || truncateBytes(stderr.trim(), MAX_STDERR_BYTES).text || stopReason || `pi exited with code ${exitCode}`
				: answer
					? undefined
					: "the research session finished without producing an answer";

	return {
		ok: !failed && Boolean(answer),
		answer,
		error,
		exitCode,
		stopReason,
		errorMessage,
		model: options.model,
		timedOut,
		aborted,
		sources: [...sources].slice(0, MAX_SOURCES),
		steps,
		usage,
		turns,
		durationMs: Date.now() - startedAt,
		truncated: false,
		stderr: stderr.trim(),
	};
}

function runResearch(
	config: CentralDocConfig,
	model: string | undefined,
	question: string,
	paths: string[] | undefined,
	excerptsOnly: boolean | undefined,
	signal: AbortSignal | undefined,
	onProgress: ((partial: string, sources: string[], steps: ResearchStep[]) => void) | undefined,
): Promise<ResearchOutcome> {
	return runSession({
		cwd: config.docsDir,
		model,
		thinkingLevel: config.thinkingLevel,
		tools: config.tools,
		timeoutMs: config.timeoutMs,
		systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
		prompt: buildPrompt(config, question, paths, excerptsOnly),
		extraPiArgs: config.extraPiArgs,
		signal,
		onProgress,
	});
}

function makeDetails(
	loaded: LoadedConfig,
	question: string,
	model: string | undefined,
	outcome: ResearchOutcome,
): CentralDocDetails {
	return {
		question,
		docsDir: loaded.config.docsDir,
		model,
		ok: outcome.ok,
		exitCode: outcome.exitCode,
		stopReason: outcome.stopReason,
		error: outcome.error,
		timedOut: outcome.timedOut,
		sources: outcome.sources,
		steps: outcome.steps,
		usage: outcome.usage,
		turns: outcome.turns,
		durationMs: outcome.durationMs,
		truncated: outcome.truncated,
		warnings: loaded.warnings.map((warning) => `${warning.source}: ${warning.message}`),
	};
}

function formatAnswer(loaded: LoadedConfig, outcome: ResearchOutcome): { text: string; truncated: boolean } {
	const sources = outcome.sources
		.map((source) => shortenPath(path.resolve(loaded.config.docsDir, source), loaded.config.docsDir))
		.filter((source, index, all) => all.indexOf(source) === index)
		.slice(0, MAX_SOURCES);

	const footer = sources.length > 0 ? `\n\n---\nDocs consulted: ${sources.join(", ")}` : "";
	return truncateBytes(`${outcome.answer}${footer}`, loaded.config.maxAnswerBytes);
}

function resolveFlags(pi: ExtensionAPI): FlagOverrides {
	return {
		docsDir: pi.getFlag("pi-central-doc-dir") as string | undefined,
		model: pi.getFlag("pi-central-doc-model") as string | undefined,
		thinking: pi.getFlag("pi-central-doc-thinking") as string | undefined,
		tools: pi.getFlag("pi-central-doc-tools") as string | undefined,
		disabled: pi.getFlag("no-pi-central-doc") === true,
		publishDisabled: pi.getFlag("no-pi-central-doc-publish") === true,
		publishModel: pi.getFlag("pi-central-doc-publish-model") as string | undefined,
		publishTools: pi.getFlag("pi-central-doc-publish-tools") as string | undefined,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("pi-central-doc-dir", {
		description: "Documentation root used by the central_doc tool",
		type: "string",
	});
	pi.registerFlag("pi-central-doc-model", {
		description: "Model (provider/model-id) used by the central_doc research session",
		type: "string",
	});
	pi.registerFlag("pi-central-doc-thinking", {
		description: "Thinking level for the central_doc research session",
		type: "string",
	});
	pi.registerFlag("pi-central-doc-tools", {
		description: "Comma-separated tools available to the central_doc research session",
		type: "string",
	});
	pi.registerFlag("no-pi-central-doc", {
		description: "Disable the central_doc tool for this session",
		type: "boolean",
	});
	pi.registerFlag("no-pi-central-doc-publish", {
		description: "Disable the /pi-central-doc-publish command for this session",
		type: "boolean",
	});
	pi.registerFlag("pi-central-doc-publish-model", {
		description: "Model (provider/model-id) used by the /pi-central-doc-publish session",
		type: "string",
	});
	pi.registerFlag("pi-central-doc-publish-tools", {
		description: "Comma-separated tools available to the /pi-central-doc-publish session",
		type: "string",
	});

	pi.registerTool({
		name: "central_doc",
		label: "Central Doc",
		description: [
			"Ask the central documentation hub a question and get a cited answer.",
			"Use it instead of reading the documentation repository yourself whenever the task depends on documented systems,",
			"their architecture, APIs, data models, integrations, or runbooks.",
			"It runs a separate research session rooted in the documentation repository and returns only the answer and its sources.",
		].join(" "),
		promptSnippet:
			"Search the central documentation hub for authoritative facts about documented systems (architecture, APIs, data models, runbooks).",
		promptGuidelines: [
			"Use central_doc when the task depends on facts from the central documentation hub, including whenever a documented system name (for example OMD, CCP, NADIN, RVS, TEIO, GSB) or its acronyms appear.",
			"Prefer central_doc over reading the documentation repository directly; it returns a cited answer without loading whole documents into this context.",
			"Do not guess documented facts: if central_doc reports that the docs do not cover something, say so instead of filling the gap from memory.",
		],
		parameters: CentralDocParams,
		annotations: { readOnlyHint: true, openWorldHint: false },

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const loaded = loadConfig(ctx.cwd, resolveFlags(pi));
			const { config } = loaded;
			const question = params.question.trim();
			const model = resolveModel(config, ctx);

			const fail = (message: string, outcome?: Partial<ResearchOutcome>): ReturnType<typeof failingResult> => {
				const base: ResearchOutcome = {
					ok: false,
					answer: "",
					error: message,
					exitCode: 1,
					timedOut: false,
					aborted: false,
					sources: [],
					steps: [],
					usage: emptyUsage(),
					turns: 0,
					durationMs: 0,
					truncated: false,
					stderr: "",
					...outcome,
				};
				return failingResult(loaded, question, model, base);
			};

			if (!config.enabled) {
				return fail("central_doc is disabled for this session (--no-pi-central-doc or \"enabled\": false).");
			}

			if (!question) {
				return fail("central_doc requires a non-empty `question`.");
			}

			if (!config.tools.length) {
				return fail("No tools are configured for the research session (\"tools\" is empty).");
			}

			if (!fs.existsSync(config.docsDir) || !fs.statSync(config.docsDir).isDirectory()) {
				return fail(
					`Documentation root not found: ${config.docsDir}. Set "docsDir" in a pi-central-doc.json config file or pass --pi-central-doc-dir.`,
				);
			}

			const outcome = await runResearch(
				config,
				model,
				question,
				params.paths,
				params.excerptsOnly,
				signal,
				onUpdate
					? (partial, sources, steps) => {
							onUpdate({
								content: [{ type: "text", text: partial || "(researching...)" }],
								details: makeDetails(loaded, question, model, {
									ok: true,
									answer: partial,
									exitCode: 0,
									timedOut: false,
									aborted: false,
									sources,
									steps,
									usage: emptyUsage(),
									turns: 0,
									durationMs: 0,
									truncated: false,
									stderr: "",
								}),
							});
						}
					: undefined,
			);

			if (!outcome.ok) {
				return failingResult(loaded, question, model, outcome);
			}

			const formatted = formatAnswer(loaded, outcome);
			outcome.truncated = formatted.truncated;

			return {
				content: [{ type: "text", text: formatted.text }],
				details: makeDetails(loaded, question, model, outcome),
				usage: outcome.usage,
			};
		},

		renderCall(args, theme, context) {
			const loaded = loadConfig(context.cwd, resolveFlags(pi));
			const question = typeof args.question === "string" ? args.question : "...";
			const preview = question.length > 100 ? `${question.slice(0, 100)}...` : question;
			const root = shortenPath(loaded.config.docsDir, context.cwd);
			const hint = args.paths?.length ? theme.fg("dim", ` [${args.paths.slice(0, 3).join(", ")}]`) : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("central_doc ")) + theme.fg("muted", `[${root}]`) + hint + `\n  ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as CentralDocDetails | undefined;
			const first = result.content[0];
			const body = first?.type === "text" ? first.text : "(no output)";

			if (!details) {
				return new Text(body, 0, 0);
			}

			const icon = details.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
			const header =
				icon +
				" " +
				theme.fg("toolTitle", theme.bold("central_doc ")) +
				theme.fg("accent", details.model ?? "(inherited model)") +
				theme.fg("dim", ` ${Math.round(details.durationMs / 1000)}s`);

			if (!expanded) {
				const lines = body.split("\n");
				const preview = lines.slice(0, 6).join("\n");
				let text = `${header}\n${theme.fg("toolOutput", preview)}`;
				if (lines.length > 6) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				const usage = formatUsage(details.usage, undefined, details.turns);
				if (usage) text += `\n${theme.fg("dim", usage)}`;
				return new Text(text, 0, 0);
			}

			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			container.addChild(new Text(theme.fg("muted", "Question: ") + theme.fg("dim", details.question), 0, 0));
			container.addChild(new Text(theme.fg("muted", `Root: ${details.docsDir}`), 0, 0));

			if (details.steps.length > 0) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Research ───"), 0, 0));
				for (const step of details.steps) {
					container.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("dim", step.summary), 0, 0));
				}
			}

			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Answer ───"), 0, 0));
			if (details.error && !details.ok) {
				container.addChild(new Text(theme.fg("error", details.error), 0, 0));
			}
			container.addChild(new Markdown(body.trim(), 0, 0, getMarkdownTheme()));

			const usage = formatUsage(details.usage, details.model, details.turns);
			if (usage) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usage), 0, 0));
			}
			for (const warning of details.warnings) {
				container.addChild(new Text(theme.fg("warning", `config warning: ${warning}`), 0, 0));
			}
			return container;
		},
	});

	pi.registerCommand("pi-central-doc", {
		description: "Show central_doc configuration, or run a one-off query: /pi-central-doc <question>",
		handler: async (args, ctx) => {
			const loaded = loadConfig(ctx.cwd, resolveFlags(pi));
			const question = args.trim();

			if (!question) {
				ctx.ui.notify(`central_doc configuration\n\n${describeConfig(loaded)}`, "info");
				return;
			}

			if (!loaded.config.enabled) {
				ctx.ui.notify("central_doc is disabled for this session.", "warning");
				return;
			}

			if (!fs.existsSync(loaded.config.docsDir)) {
				ctx.ui.notify(`Documentation root not found: ${loaded.config.docsDir}`, "error");
				return;
			}

			const model = resolveModel(loaded.config, ctx);
			const outcome = await runResearch(loaded.config, model, question, undefined, undefined, undefined, undefined);

			if (!outcome.ok) {
				ctx.ui.notify(`central_doc failed: ${outcome.error ?? "unknown error"}`, "error");
				return;
			}

			const answer = formatAnswer(loaded, outcome).text;
			ctx.ui.notify(answer.length > 4_000 ? `${answer.slice(0, 4_000)}\n…[truncated]` : answer, "info");
		},
	});

	pi.registerCommand("pi-central-doc-model", {
		description: "Set the persistent central_doc subagent model; no argument inherits each session's model",
		handler: async (args, ctx) => {
			const loaded = loadConfig(ctx.cwd, resolveFlags(pi));
			const selection = args.trim();
			const saveSelection = async (model: string | null | undefined, message: string) => {
				try {
					await saveSubagentModel(loaded.projectPath, model);
					ctx.ui.notify(`${message}\nSaved in ${loaded.projectPath}`, "info");
				} catch (error) {
					ctx.ui.notify(`Could not save the subagent model: ${(error as Error).message}`, "error");
				}
			};

			if (!selection || selection === "inherit") {
				const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "Pi's default model";
				await saveSelection(null, `central_doc will inherit each session's model (currently ${model}).`);
				return;
			}

			if (selection === "config") {
				await saveSelection(undefined, "Cleared the saved model choice; central_doc will use the configured model.");
				return;
			}

			if (selection === "select") {
				if (!ctx.hasUI) {
					ctx.ui.notify("Model selection requires an interactive UI. Pass a provider/model-id instead.", "warning");
					return;
				}

				const models = [...ctx.modelRegistry.getAvailable()].sort((a, b) =>
					`${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
				);
				const inheritLabel = `Inherit the session model (${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "current default"})`;
				const configLabel = "Use the configured model (clear saved choice)";
				const choices = [inheritLabel, configLabel, ...models.map((model) => `${model.provider}/${model.id}`)];
				const chosen = await ctx.ui.select("Central Doc subagent model", choices);
				if (!chosen) return;
				if (chosen === inheritLabel) {
					await saveSelection(null, "central_doc will inherit each session's model.");
				} else if (chosen === configLabel) {
					await saveSelection(undefined, "Cleared the saved model choice; central_doc will use the configured model.");
				} else {
					await saveSelection(chosen, `central_doc model set to ${chosen}.`);
				}
				return;
			}

			const availableModel = ctx.modelRegistry.getAvailable().find((model) => `${model.provider}/${model.id}` === selection);
			if (!availableModel) {
				ctx.ui.notify(
					`Model "${selection}" is not available. Use /pi-central-doc-model select to browse available models.`,
					"error",
				);
				return;
			}
			const model = `${availableModel.provider}/${availableModel.id}`;
			await saveSelection(model, `central_doc model set to ${model}.`);
		},
	});

	pi.registerMessageRenderer("pi-central-doc-publish", (message, { expanded }, theme) => {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const lines = content.split("\n");
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("publish → central docs")), 0, 0));
		container.addChild(new Markdown((expanded ? content : lines.slice(0, 10).join("\n")).trim(), 0, 0, getMarkdownTheme()));
		if (!expanded && lines.length > 10) {
			container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
		}
		return container;
	});

	pi.registerCommand("pi-central-doc-publish", {
		description: "Publish a markdown file or the last session output into the central documentation hub",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify(PUBLISH_USAGE, "info");
				return;
			}

			const parsed = parsePublishArgs(args);
			if (parsed.help) {
				ctx.ui.notify(PUBLISH_USAGE, "info");
				return;
			}
			if (parsed.error) {
				ctx.ui.notify(`${parsed.error}\n\n${PUBLISH_USAGE}`, "warning");
				return;
			}

			const loaded = loadConfig(ctx.cwd, resolveFlags(pi));
			const publish = loaded.config.publish;

			if (!publish.enabled) {
				ctx.ui.notify("Publishing is disabled (publish.enabled=false or --no-pi-central-doc-publish).", "warning");
				return;
			}
			if (!fs.existsSync(loaded.config.docsDir)) {
				ctx.ui.notify(`Documentation root not found: ${loaded.config.docsDir}`, "error");
				return;
			}

			const resolved = parsed.file
				? readFileSource(parsed.file, ctx.cwd)
				: readSessionSource(ctx.sessionManager, parsed.lastTurns ?? 1);
			if (!resolved.source) {
				ctx.ui.notify(resolved.error ?? "No source material to publish.", "error");
				return;
			}
			const source = resolved.source;

			if (!parsed.yes) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Refusing to publish without confirmation: pass --yes (or use --dry-run).", "warning");
					return;
				}
				const confirmed = await ctx.ui.confirm(
					parsed.dryRun ? "Dry-run this publish?" : "Publish into the documentation hub?",
					[
						`source:  ${source.label}`,
						`size:    ${source.bytes} bytes`,
						`root:    ${loaded.config.docsDir}`,
						parsed.system ? `system:  ${parsed.system}` : undefined,
						parsed.destination ? `target:  ${parsed.destination}` : undefined,
						parsed.dryRun ? "mode:    dry run (no files written)" : `tools:   ${publish.tools.join(", ")}`,
					]
						.filter(Boolean)
						.join("\n"),
				);
				if (!confirmed) {
					ctx.ui.notify("Publish cancelled.", "info");
					return;
				}
			}

			const model = publish.model ?? resolveModel(loaded.config, ctx);
			const tools = parsed.dryRun ? publish.dryRunTools : publish.tools;

			// The child writes files and the report is posted as a message, so do not
			// start while the main session is still streaming. Show feedback while we wait,
			// then update the status as the child reads, edits, and validates the docs.
			const statusPrefix = parsed.dryRun ? "publish dry run" : "publishing";
			ctx.ui.notify(`${parsed.dryRun ? "Dry run" : "Publish"} started for ${source.label}.`, "info");
			let tmpDir: string | undefined;
			try {
				ctx.ui.setStatus("pi-central-doc", `${statusPrefix} · waiting for session…`);
				await ctx.waitForIdle();
				ctx.ui.setStatus("pi-central-doc", `${statusPrefix} · starting publisher…`);

				let sourcePath: string | undefined;
				ctx.ui.setStatus("pi-central-doc", `${statusPrefix} · preparing source…`);
				if (Buffer.byteLength(source.content, "utf8") > INLINE_SOURCE_BYTES) {
					const tmp = await writeTempSource(source.content, source.name ?? "source.md");
					tmpDir = tmp.dir;
					sourcePath = tmp.file;
				}

				const prompt = buildPublishPrompt({
					source,
					sourcePath,
					system: parsed.system,
					title: parsed.title,
					tags: parsed.tags,
					destination: parsed.destination,
					note: parsed.note,
					dryRun: parsed.dryRun,
					today: new Date().toISOString().slice(0, 10),
				});

				const outcome = await runSession({
					cwd: loaded.config.docsDir,
					model,
					thinkingLevel: publish.thinkingLevel ?? loaded.config.thinkingLevel,
					tools,
					timeoutMs: publish.timeoutMs,
					systemPrompt: publish.systemPrompt ?? PUBLISH_SYSTEM_PROMPT,
					prompt,
					extraPiArgs: loaded.config.extraPiArgs,
					signal: ctx.signal,
					onProgress: (partial, _sources, steps) => {
						const latestStep = steps.at(-1);
						const stage = latestStep
							? `working: ${latestStep.summary}`
							: partial
								? "drafting document…"
								: "reading hub conventions…";
						ctx.ui.setStatus("pi-central-doc", `${statusPrefix} · ${stage}`);
					},
				});

				ctx.ui.setStatus("pi-central-doc", `${statusPrefix} · collecting changed files…`);
				const changes = parsed.dryRun ? undefined : await gitChanges(loaded.config.docsDir);
				if (!parsed.dryRun) ctx.ui.setStatus("pi-central-doc", `${statusPrefix} · running validator…`);
				const validation = parsed.dryRun ? undefined : await runValidator(loaded.config.docsDir, publish.validator);

				const validatorFailed = Boolean(validation && !validation.skipped && !validation.ok);
				const ok = outcome.ok && !validatorFailed;
				const report = formatPublishReport({
					source,
					docsDir: loaded.config.docsDir,
					dryRun: parsed.dryRun,
					ok,
					error: outcome.error ?? (validatorFailed ? "the documentation validator failed" : undefined),
					answer: outcome.answer,
					changes,
					validation,
					usageLine: formatUsage(outcome.usage, outcome.model, outcome.turns),
				});

				pi.sendMessage(
					{
						customType: "pi-central-doc-publish",
						content: truncateBytes(report, 24_000).text,
						display: true,
						details: {
							dryRun: parsed.dryRun,
							ok,
							source: source.label,
							docsDir: loaded.config.docsDir,
							model: outcome.model,
							changedFiles: changes?.files ?? [],
							validation,
							usage: outcome.usage,
						},
					},
					{},
				);

				const changed = changes?.files.length ?? 0;
				const validationNote = validation
					? validation.skipped
						? ""
						: validation.ok
							? ", validation passed"
							: ", VALIDATION FAILED"
					: "";
				ctx.ui.notify(
					ok
						? parsed.dryRun
							? "Dry run complete — see the proposed document and edits above."
							: `Published ${changed} file change${changed === 1 ? "" : "s"}${validationNote}. See the report above.`
						: `Publish failed: ${outcome.error ?? "the documentation validator failed"}. See the report above.`,
					ok ? "info" : "error",
				);
			} finally {
				ctx.ui.setStatus("pi-central-doc", undefined);
				if (tmpDir) {
					try {
						fs.rmSync(tmpDir, { recursive: true, force: true });
					} catch {
						/* best effort */
					}
				}
			}
		},
	});
}

function failingResult(
	loaded: LoadedConfig,
	question: string,
	model: string | undefined,
	outcome: ResearchOutcome,
): {
	content: { type: "text"; text: string }[];
	details: CentralDocDetails;
	usage: Usage;
	isError: true;
} {
	const hint = outcome.error ?? "unknown error";
	const warnings = loaded.warnings.map((warning) => `config warning: ${warning.source}: ${warning.message}`);
	return {
		content: [
			{
				type: "text",
				text: [
					`central_doc failed: ${hint}`,
					`(root: ${loaded.config.docsDir}; model: ${model ?? "inherited"})`,
					...warnings,
				].join("\n"),
			},
		],
		details: makeDetails(loaded, question, model, outcome),
		usage: outcome.usage,
		isError: true,
	};
}
