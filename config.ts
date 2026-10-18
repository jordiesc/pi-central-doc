/**
 * Configuration for the pi-central-doc extension.
 *
 * Sources, lowest priority first:
 *   1. Built-in defaults (below)
 *   2. Global config:  ~/.pi/agent/pi-central-doc.json
 *   3. Project config: <cwd>/.pi/pi-central-doc.json
 *   4. CLI flags registered by the extension:
 *        --pi-central-doc-dir <path>
 *        --pi-central-doc-model <model>
 *        --pi-central-doc-thinking <level>
 *        --pi-central-doc-tools <a,b,c>
 *        --no-pi-central-doc
 *        --no-pi-central-doc-publish
 *        --pi-central-doc-publish-model <model>
 *        --pi-central-doc-publish-tools <a,b,c>
 *
 * Relative paths in the global config resolve against the home directory and in a
 * project config against the project root. `~` and `$VAR`/`${VAR}` are expanded.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_FILE_NAME = "pi-central-doc.json";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingSetting = (typeof THINKING_LEVELS)[number];

export interface CentralDocConfig {
	/** Register the tool at all. Set false to keep the extension loaded but inert. */
	enabled: boolean;
	/** Root of the central documentation repository. */
	docsDir: string;
	/** Entry-point file inside docsDir, used in the agent instructions. */
	entryFile: string;
	/** `provider/model-id` for the research session. Omitted/null = inherit the calling session's model. */
	model?: string;
	thinkingLevel: ThinkingSetting;
	/** Built-in tools the research session may use. Default is read-only. */
	tools: string[];
	/** Hard timeout for one research run. */
	timeoutMs: number;
	/** Cap for the model-facing answer. Full answer stays in tool details. */
	maxAnswerBytes: number;
	/** Replaces the built-in research system prompt when set. */
	systemPrompt?: string;
	/** Extra `pi` CLI arguments appended verbatim. Escape hatch; may weaken the defaults. */
	extraPiArgs: string[];
	/** Settings for the `/pi-central-doc-publish` command. */
	publish: PublishConfig;
}

export interface PublishConfig {
	/** Allow `/pi-central-doc-publish` to write into the documentation root. */
	enabled: boolean;
	/** `provider/model-id` for the publishing session. Omitted/null = inherit the calling session's model. */
	model?: string;
	/** Thinking level for the publishing session. Omitted = inherit the research level. */
	thinkingLevel?: ThinkingSetting;
	/** Tools the publishing session may use. Needs write access, unlike the research defaults. */
	tools: string[];
	/** Tools used by `--dry-run`, which must not be able to write. */
	dryRunTools: string[];
	/** Hard timeout for one publish run; publishing edits several files. */
	timeoutMs: number;
	/** Validator command run in the docs root after a real publish. Empty disables it. */
	validator: string[];
	/** Replaces the built-in publishing system prompt when set. */
	systemPrompt?: string;
	/** Ask for confirmation before running a publish that writes. */
	requireConfirmation: boolean;
}

export interface ConfigWarning {
	source: string;
	message: string;
}

export interface LoadedConfig {
	config: CentralDocConfig;
	warnings: ConfigWarning[];
	globalPath: string;
	projectPath: string;
}

export interface FlagOverrides {
	docsDir?: string;
	model?: string;
	thinking?: string;
	tools?: string;
	disabled?: boolean;
	publishDisabled?: boolean;
	publishModel?: string;
	publishTools?: string;
}

export const DEFAULT_SYSTEM_PROMPT = `You are a documentation research agent for a central documentation hub: an INDEX.md entry point, one folder per system, YAML frontmatter (title/description/tags/related) on every document, and a glossary.md for acronyms.

Your working directory IS the documentation root. Answer the question from its contents only.

Method:
1. Read the entry file (INDEX.md) first unless the question already names a system folder or document.
2. Use glossary.md to resolve acronyms and system names before searching.
3. Use grep/find to locate the relevant system folder, then read the documents themselves — read them fully instead of guessing from filenames.
4. Follow \`related:\` frontmatter links and in-document cross-references to gather complete context.
5. Trust the documentation over your own priors. Reproduce exact names, paths, hosts, protocols, table/column names, and limits when the docs state them.

Answer format:
- A direct answer in 1-3 sentences first.
- Then supporting details as short bullets or a table.
- Then a \`Sources\` section with every document you used, as relative paths plus the section heading (for example \`omd/sli-orders.md § Order lifecycle\`).
- Call out contradictions or obvious gaps explicitly.

Rules:
- Never invent facts, paths, APIs, or identifiers. If the documentation does not answer the question, say what is missing and list the files and searches you tried.
- Do not modify any file.
- Keep the answer under roughly 800 words unless the question requires more.`;

const DEFAULTS: CentralDocConfig = {
	enabled: true,
	docsDir: join(homedir(), "repos", "github", "doc-system"),
	entryFile: "INDEX.md",
	thinkingLevel: "low",
	tools: ["read", "grep", "find", "ls"],
	timeoutMs: 180_000,
	maxAnswerBytes: 40_000,
	extraPiArgs: [],
	publish: {
		enabled: true,
		tools: ["read", "grep", "find", "ls", "write", "edit"],
		dryRunTools: ["read", "grep", "find", "ls"],
		timeoutMs: 600_000,
		validator: ["python3", "scripts/check-docs.py"],
		requireConfirmation: true,
	},
};

type RawConfig = Record<string, unknown>;

function isRecord(value: unknown): value is RawConfig {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandPath(value: string, baseDir: string): string {
	const expanded = value
		.replace(/^~(?=$|[\\/])/, homedir())
		.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, braced, bare) => process.env[braced ?? bare] ?? match);
	return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
	if (!raw) return undefined;
	const tools = raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function readConfigFile(filePath: string, warnings: ConfigWarning[]): RawConfig | undefined {
	if (!existsSync(filePath)) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch (error) {
		warnings.push({ source: filePath, message: `Cannot parse JSON: ${(error as Error).message}` });
		return undefined;
	}

	if (!isRecord(parsed)) {
		warnings.push({ source: filePath, message: "Expected a JSON object at the top level." });
		return undefined;
	}
	return parsed;
}

function applyFile(config: CentralDocConfig, raw: RawConfig, source: string, baseDir: string, warnings: ConfigWarning[]): void {
	const warn = (message: string) => warnings.push({ source, message });

	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
		else warn("`enabled` must be a boolean.");
	}

	if (raw.docsDir !== undefined) {
		if (typeof raw.docsDir === "string" && raw.docsDir.trim()) config.docsDir = expandPath(raw.docsDir.trim(), baseDir);
		else warn("`docsDir` must be a non-empty string.");
	}

	if (raw.entryFile !== undefined) {
		if (typeof raw.entryFile === "string" && raw.entryFile.trim()) config.entryFile = raw.entryFile.trim();
		else warn("`entryFile` must be a non-empty string.");
	}

	if (raw.model !== undefined) {
		if (raw.model === null) config.model = undefined;
		else if (typeof raw.model === "string") config.model = raw.model.trim() || undefined;
		else warn("`model` must be a string like \"provider/model-id\" or null (inherit caller).");
	}

	if (raw.thinkingLevel !== undefined) {
		const level = typeof raw.thinkingLevel === "string" ? raw.thinkingLevel.trim() : undefined;
		if (level && (THINKING_LEVELS as readonly string[]).includes(level)) config.thinkingLevel = level as ThinkingSetting;
		else warn(`\`thinkingLevel\` must be one of: ${THINKING_LEVELS.join(", ")}.`);
	}

	if (raw.tools !== undefined) {
		const tools = parseToolList(raw.tools);
		if (tools) config.tools = tools;
		else warn("`tools` must be an array of tool names or a comma-separated string.");
	}

	if (raw.timeoutMs !== undefined) {
		if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) {
			config.timeoutMs = Math.round(raw.timeoutMs);
		} else warn("`timeoutMs` must be a positive number.");
	}

	if (raw.maxAnswerBytes !== undefined) {
		if (typeof raw.maxAnswerBytes === "number" && Number.isFinite(raw.maxAnswerBytes) && raw.maxAnswerBytes >= 1000) {
			config.maxAnswerBytes = Math.round(raw.maxAnswerBytes);
		} else warn("`maxAnswerBytes` must be a number >= 1000.");
	}

	if (raw.systemPrompt !== undefined) {
		if (typeof raw.systemPrompt === "string" && raw.systemPrompt.trim()) config.systemPrompt = raw.systemPrompt;
		else warn("`systemPrompt` must be a non-empty string (or omit it to use the built-in prompt).");
	}

	if (raw.extraPiArgs !== undefined) {
		const args = parseToolList(raw.extraPiArgs);
		if (args) config.extraPiArgs = args;
		else warn("`extraPiArgs` must be an array of strings.");
	}

	if (raw.publish !== undefined) applyPublish(config.publish, raw.publish, warn);
}

function applyPublish(publish: PublishConfig, raw: unknown, warn: (message: string) => void): void {
	if (!isRecord(raw)) {
		warn("`publish` must be an object.");
		return;
	}

	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") publish.enabled = raw.enabled;
		else warn("`publish.enabled` must be a boolean.");
	}

	if (raw.model !== undefined) {
		if (raw.model === null) publish.model = undefined;
		else if (typeof raw.model === "string") publish.model = raw.model.trim() || undefined;
		else warn("`publish.model` must be a string like \"provider/model-id\" or null (inherit caller).");
	}

	if (raw.thinkingLevel !== undefined) {
		const level = typeof raw.thinkingLevel === "string" ? raw.thinkingLevel.trim() : undefined;
		if (level && (THINKING_LEVELS as readonly string[]).includes(level)) publish.thinkingLevel = level as ThinkingSetting;
		else warn(`\`publish.thinkingLevel\` must be one of: ${THINKING_LEVELS.join(", ")}.`);
	}

	if (raw.tools !== undefined) {
		const tools = parseToolList(raw.tools);
		if (tools) publish.tools = tools;
		else warn("`publish.tools` must be an array of tool names or a comma-separated string.");
	}

	if (raw.dryRunTools !== undefined) {
		const tools = parseToolList(raw.dryRunTools);
		if (tools) publish.dryRunTools = tools;
		else warn("`publish.dryRunTools` must be an array of tool names or a comma-separated string.");
	}

	if (raw.timeoutMs !== undefined) {
		if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) {
			publish.timeoutMs = Math.round(raw.timeoutMs);
		} else warn("`publish.timeoutMs` must be a positive number.");
	}

	if (raw.validator !== undefined) {
		if (raw.validator === null) publish.validator = [];
		else if (typeof raw.validator === "string") {
			const command = raw.validator.trim().split(/\s+/).filter(Boolean);
			if (command.length > 0) publish.validator = command;
			else warn("`publish.validator` must not be an empty string; use null to disable it.");
		} else {
			const command = parseToolList(raw.validator);
			if (command) publish.validator = command;
			else warn("`publish.validator` must be an array of strings, a command string, or null to disable it.");
		}
	}

	if (raw.systemPrompt !== undefined) {
		if (typeof raw.systemPrompt === "string" && raw.systemPrompt.trim()) publish.systemPrompt = raw.systemPrompt;
		else warn("`publish.systemPrompt` must be a non-empty string (or omit it to use the built-in prompt).");
	}

	if (raw.requireConfirmation !== undefined) {
		if (typeof raw.requireConfirmation === "boolean") publish.requireConfirmation = raw.requireConfirmation;
		else warn("`publish.requireConfirmation` must be a boolean.");
	}
}

function applyFlags(config: CentralDocConfig, flags: FlagOverrides, cwd: string, warnings: ConfigWarning[]): void {
	// CLI flags are explicit, so an empty string is an error rather than "unset".
	const warn = (message: string) => warnings.push({ source: "cli flags", message });

	if (flags.disabled) config.enabled = false;
	if (flags.publishDisabled) config.publish.enabled = false;

	if (flags.publishModel !== undefined) {
		if (flags.publishModel.trim()) config.publish.model = flags.publishModel.trim();
		else warn("--pi-central-doc-publish-model requires a model.");
	}

	if (flags.publishTools !== undefined) {
		const tools = parseToolList(flags.publishTools);
		if (tools) config.publish.tools = tools;
		else warn("--pi-central-doc-publish-tools requires a comma-separated list of tool names.");
	}

	if (flags.docsDir !== undefined) {
		if (flags.docsDir.trim()) config.docsDir = expandPath(flags.docsDir.trim(), cwd);
		else warn("--pi-central-doc-dir requires a path.");
	}

	if (flags.model !== undefined) {
		if (flags.model.trim()) config.model = flags.model.trim();
		else warn("--pi-central-doc-model requires a model.");
	}

	if (flags.thinking !== undefined) {
		const level = flags.thinking.trim();
		if ((THINKING_LEVELS as readonly string[]).includes(level)) config.thinkingLevel = level as ThinkingSetting;
		else warn(`--pi-central-doc-thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
	}

	if (flags.tools !== undefined) {
		const tools = parseToolList(flags.tools);
		if (tools) config.tools = tools;
		else warn("--pi-central-doc-tools requires a comma-separated list of tool names.");
	}
}

export function loadConfig(cwd: string, flags: FlagOverrides = {}): LoadedConfig {
	const config: CentralDocConfig = {
		...DEFAULTS,
		tools: [...DEFAULTS.tools],
		extraPiArgs: [...DEFAULTS.extraPiArgs],
		publish: {
			...DEFAULTS.publish,
			tools: [...DEFAULTS.publish.tools],
			dryRunTools: [...DEFAULTS.publish.dryRunTools],
			validator: [...DEFAULTS.publish.validator],
		},
	};
	const warnings: ConfigWarning[] = [];
	const globalPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const projectPath = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);

	for (const [filePath, baseDir] of [
		[globalPath, homedir()] as const,
		[projectPath, cwd] as const,
	]) {
		const raw = readConfigFile(filePath, warnings);
		if (raw) applyFile(config, raw, filePath, baseDir, warnings);
	}

	applyFlags(config, flags, cwd, warnings);

	return { config, warnings, globalPath, projectPath };
}

export function describeConfig(loaded: LoadedConfig): string {
	const { config, warnings, globalPath, projectPath } = loaded;
	const rows = [
		`enabled:        ${config.enabled}`,
		`docsDir:        ${config.docsDir}${existsSync(config.docsDir) ? "" : "  (missing!)"}`,
		`entryFile:      ${config.entryFile}`,
		`model:          ${config.model ?? "(inherit calling session)"}`,
		`thinkingLevel:  ${config.thinkingLevel}`,
		`tools:          ${config.tools.join(", ")}`,
		`timeoutMs:      ${config.timeoutMs}`,
		`maxAnswerBytes: ${config.maxAnswerBytes}`,
		`systemPrompt:   ${config.systemPrompt ? "custom" : "built-in"}`,
		`extraPiArgs:    ${config.extraPiArgs.length ? config.extraPiArgs.join(" ") : "(none)"}`,
		`global config:  ${existsSync(globalPath) ? globalPath : `${globalPath} (absent)`}`,
		`project config: ${existsSync(projectPath) ? projectPath : `${projectPath} (absent)`}`,
		"",
		`publish:        ${config.publish.enabled ? "enabled" : "disabled"}`,
		`publish model:  ${config.publish.model ?? config.model ?? "(inherit calling session)"}`,
		`publish think:  ${config.publish.thinkingLevel ?? config.thinkingLevel}`,
		`publish tools:  ${config.publish.tools.join(", ")}`,
		`dry-run tools:  ${config.publish.dryRunTools.join(", ")}`,
		`publish timeout:${config.publish.timeoutMs}`,
		`validator:      ${config.publish.validator.length ? config.publish.validator.join(" ") : "(disabled)"}`,
	];
	if (warnings.length > 0) {
		rows.push("", "warnings:", ...warnings.map((warning) => `- ${warning.source}: ${warning.message}`));
	}
	return rows.join("\n");
}
