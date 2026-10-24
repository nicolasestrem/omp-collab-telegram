/**
 * Telegram Collab Link Extension
 *
 * On every interactive (TUI) main-agent session start, locate this session's own
 * Collab host, mint its join link, and deliver it to a configured Telegram chat so
 * the session can be joined/controlled from a phone.
 *
 * Behaviour:
 * - Only runs for `ctx.mode === "tui"`, `ctx.hasUI === true`, `ctx.agent.kind === "main"`.
 *   Print/RPC/JSON runs and subagents are ignored.
 * - Never blocks startup: all work is offloaded to a background promise, and the
 *   `session_start` handler returns synchronously.
 * - Every failure is warning-only; the session is never aborted or altered.
 *
 * Configuration: `<agentDir>/telegram-collab.env` with
 *   OMP_TELEGRAM_BOT_TOKEN=...
 *   OMP_TELEGRAM_CHAT_ID=...
 * where `<agentDir>` is `$PI_CODING_AGENT_DIR` or `~/.omp/agent`.
 *
 * Notes: this file intentionally imports only Node builtins. Extensions loaded from
 * `~/.omp/agent/extensions/` cannot resolve `@oh-my-pi/pi-coding-agent`, so no
 * package import (not even type-only) is used; the small surface this extension
 * touches is declared locally below.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Ignore a replayed `session_start` for the same session inside this window. */
const DEDUPE_WINDOW_MS = 30_000;
/** Collab relaunch backoff reaches 60s, so ~180s of polling covers slow starts. */
const POLL_INTERVAL_MS = 2_000;
const POLL_ATTEMPTS = 90;
const CMD_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 10_000;

/** Sessions whose link was successfully delivered, keyed by session id. */
const deliveredAt = new Map<string, number>();
/** Sessions with a delivery attempt in progress (prevents duplicate sends). */
const inFlight = new Set<string>();

interface Credentials {
	token: string;
	chatId: string;
}

interface HostInfo {
	instanceId: string;
	access: string;
}

interface LoggerLike {
	debug?(message: string, context?: Record<string, unknown>): void;
	info?(message: string, context?: Record<string, unknown>): void;
	warn?(message: string, context?: Record<string, unknown>): void;
}

interface UiLike {
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface ExtensionContextLike {
	mode: string;
	hasUI: boolean;
	agent?: { kind: "main" | "sub" };
	ui: UiLike;
	sessionManager?: { getSessionId(): string };
}

interface ExecResultLike {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

interface ExtensionApiLike {
	on(event: "session_start", handler: (event: unknown, ctx: ExtensionContextLike) => void): void;
	logger?: LoggerLike;
	exec(command: string, args: string[], options?: { timeout?: number }): Promise<ExecResultLike>;
}

interface RunArgs {
	pi: ExtensionApiLike;
	ctx: ExtensionContextLike;
	sessionId: string;
	envPath: string;
}

/** Parse a `KEY=VALUE` env file. Returns null when either required key is absent. */
async function readCredentials(envPath: string): Promise<Credentials | null> {
	let raw: string;
	try {
		raw = await readFile(envPath, "utf8");
	} catch {
		return null;
	}

	const vars = new Map<string, string>();
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const sep = trimmed.indexOf("=");
		if (sep <= 0) continue;
		vars.set(trimmed.slice(0, sep).trim(), trimmed.slice(sep + 1).trim());
	}

	const token = vars.get("OMP_TELEGRAM_BOT_TOKEN");
	const chatId = vars.get("OMP_TELEGRAM_CHAT_ID");
	if (!token || !chatId) return null;
	return { token, chatId };
}

/** Run an `omp` subcommand, returning stdout or null on any failure. */
async function execOmp(pi: ExtensionApiLike, args: string[]): Promise<string | null> {
	try {
		const result = await pi.exec("omp", args, { timeout: CMD_TIMEOUT_MS });
		if (result.code !== 0) {
			pi.logger?.debug?.("telegram-collab-link: omp command failed", {
				action: args[1] ?? null,
				code: result.code,
			});
			return null;
		}
		return result.stdout;
	} catch {
		pi.logger?.debug?.("telegram-collab-link: omp command failed", { action: args[1] ?? null, code: null });
		return null;
	}
}

/** Find this process's own host for `sessionId`; never falls back to another host. */
async function findHost(pi: ExtensionApiLike, sessionId: string): Promise<HostInfo | null> {
	const stdout = await execOmp(pi, ["collab", "list", "--json"]);
	if (stdout === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null || !("hosts" in parsed)) return null;
	const listed: unknown[] = Array.isArray(parsed.hosts) ? parsed.hosts : [];

	for (const candidate of listed) {
		if (typeof candidate !== "object" || candidate === null) continue;
		if (!("pid" in candidate) || !("sessionId" in candidate) || !("instanceId" in candidate)) continue;
		if (candidate.pid !== process.pid || candidate.sessionId !== sessionId) continue;
		if (typeof candidate.instanceId !== "string" || candidate.instanceId.length === 0) continue;

		const access =
			"access" in candidate && typeof candidate.access === "string" ? candidate.access : "";
		return { instanceId: candidate.instanceId, access };
	}

	return null;
}

/** Mint the join link for `host`. Returns null while the room is not yet linkable. */
async function mintLink(pi: ExtensionApiLike, host: HostInfo): Promise<string | null> {
	const args = ["collab", "link", host.instanceId];
	if (host.access === "view") args.push("--view");
	args.push("--json");

	const stdout = await execOmp(pi, args);
	if (stdout === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null || !("url" in parsed)) return null;
	return typeof parsed.url === "string" && parsed.url.length > 0 ? parsed.url : null;
}

/** Background worker: poll for the host, mint the link, send it once. Never throws. */
async function run({ pi, ctx, sessionId, envPath }: RunArgs): Promise<void> {
	const credentials = await readCredentials(envPath);
	if (!credentials) {
		ctx.ui.notify(`Collab link not sent: missing Telegram credentials in ${envPath}`, "warning");
		pi.logger?.warn?.("telegram-collab-link: credentials unavailable", { envPath });
		return;
	}

	let url: string | null = null;
	for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
		if (attempt > 0) await sleep(POLL_INTERVAL_MS);

		const host = await findHost(pi, sessionId);
		if (!host) continue;

		// `stale_generation` is expected if the room relaunched between list and link;
		// the next iteration's fresh list picks up the new generation.
		url = await mintLink(pi, host);
		if (url) break;
	}

	if (!url) {
		pi.logger?.warn?.("telegram-collab-link: no collab host for this session after 180s", { sessionId });
		return;
	}

	const text = `OMP session ready — join with control access:\n${url}`;
	let ok = false;
	let status: number | string = "network";
	let reportedOk: unknown = false;
	let errorCode: unknown = null;
	let messageId: unknown = null;

	try {
		const res = await fetch(`https://api.telegram.org/bot${credentials.token}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chat_id: credentials.chatId, text, disable_web_page_preview: true }),
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
		status = res.status;

		const reply: unknown = await res.json().catch(() => null);
		if (typeof reply === "object" && reply !== null) {
			if ("ok" in reply) reportedOk = reply.ok;
			if ("error_code" in reply) errorCode = reply.error_code;
			if ("result" in reply && typeof reply.result === "object" && reply.result !== null) {
				const result = reply.result;
				if ("message_id" in result) messageId = result.message_id;
			}
		}
		ok = res.ok && reportedOk === true;
	} catch {
		// Network failure or timeout: deliberately not retried, to avoid duplicate delivery.
		ok = false;
	}

	if (ok) {
		deliveredAt.set(sessionId, Date.now());
		pi.logger?.info?.("telegram-collab-link: delivered", {
			chatIdTail: String(credentials.chatId).slice(-4),
			messageId,
			sessionId,
		});
		return;
	}

	ctx.ui.notify("Telegram delivery of collab link failed — see logs; the session is unaffected", "warning");
	pi.logger?.warn?.("telegram-collab-link: delivery failed", { status, ok: reportedOk, code: errorCode });
}

export default function telegramCollabLink(pi: ExtensionApiLike): void {
	pi.on("session_start", (_event, ctx) => {
		try {
			// Filter synchronously so non-interactive and subagent sessions cost nothing.
			if (ctx.mode !== "tui" || ctx.hasUI !== true) return;
			if (ctx.agent?.kind !== "main") return;

			const sessionId = ctx.sessionManager?.getSessionId();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;

			const previous = deliveredAt.get(sessionId);
			if (previous !== undefined && Date.now() - previous < DEDUPE_WINDOW_MS) return;
			if (inFlight.has(sessionId)) return;

			const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent");
			const envPath = path.join(agentDir, "telegram-collab.env");

			// Claim the session before yielding so a replayed event cannot double-send.
			inFlight.add(sessionId);
			// The handler must return immediately: collab can take up to ~180s to publish.
			void run({ pi, ctx, sessionId, envPath })
				.catch(() => {
					pi.logger?.warn?.("telegram-collab-link: unexpected failure");
				})
				.finally(() => {
					inFlight.delete(sessionId);
				});
		} catch {
			pi.logger?.warn?.("telegram-collab-link: handler failed");
		}
	});
}
