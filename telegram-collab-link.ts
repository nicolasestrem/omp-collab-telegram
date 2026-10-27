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
 * - A session's link is sent at most once per process: the delivered set is
 *   consulted before spawning a run, and a claim is registered before the
 *   background work starts, so a replayed `session_start` cannot double-send.
 * - A pending delivery is cancelled when its session transitions away
 *   (`session_switch` reasons new/resume/fork and `session_branch` reasons
 *   branch/fork) or on `session_shutdown`: those transitions stop the session's
 *   Collab room and withdraw its registry entry, so a queued link would
 *   advertise a dead room. `/btw` branches and tree navigation target the same
 *   session lineage and do NOT cancel.
 * - Polling has a wall-clock budget (180s) and logs the actual elapsed time.
 *   Both the host poll and the link mint share the cancel signal, so a
 *   cancelled run frees its CLI processes promptly instead of waiting out
 *   remaining command timeouts.
 * - Telegram delivery retries only HTTP 429 rejections, which are explicit
 *   failures (the message was not delivered), honoring `retry_after` within a
 *   bounded wait. Network errors, timeouts, and every other status — including
 *   5xx, where delivery may still have occurred — are never retried.
 *
 * Diagnostics (log content hygiene):
 * - Logs never include the bot token, the full join URL, the chat id, or any
 *   raw exception message or stack. Failure facts are bounded, structured
 *   fields: the failing argv verb, exit code / killed flag, the error
 *   constructor name only, and (for `omp` CLI failures) the first bounded
 *   non-blank stderr line — text the CLI writes itself, never carrying urls
 *   or tokens.
 *
 * Configuration: `<agentDir>/telegram-collab.env` with
 *   OMP_TELEGRAM_BOT_TOKEN=...
 *   OMP_TELEGRAM_CHAT_ID=...
 * The directory resolves like `omp` itself: `PI_CODING_AGENT_DIR` when set
 * (profiles export their own agent dir there on activation, so a profile run
 * reads its own env file), else `~/$PI_CONFIG_DIR/agent` (i.e. `~/.omp/agent`
 * by default).
 *
 * Notes: this file intentionally imports only Node builtins. Extensions loaded from
 * `~/.omp/agent/extensions/` cannot resolve `@oh-my-pi/pi-coding-agent`, so no
 * package import (not even type-only) is used; the small surface this extension
 * touches is declared locally below and was verified against omp 18.13.1.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Wall-clock poll budget, covering Collab relaunch backoff (up to 60s) plus CLI time. */
const POLL_BUDGET_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;
const CMD_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 10_000;

/** Total Telegram attempts (initial + bounded retries for explicitly rejected 429s). */
const SEND_ATTEMPTS = 3;
const SEND_RETRY_DEFAULT_MS = 2_000;
/** Upper bound for a retry wait, draining attempts faster when `retry_after` is large. */
const SEND_RETRY_WAIT_MAX_MS = 5_000;

/** Maximum characters of one CLI stderr line ever admitted into the log. */
const LOG_LINE_MAX = 120;

/** Sessions whose link was delivered during this process; members never re-send. */
const deliveredAt = new Map<string, number>();
/** Sessions with a delivery attempt in progress (prevents duplicate sends). */
const inFlight = new Set<string>();
/** Aborts pending deliveries when their session transitions away. */
const pendingSends = new Map<string, AbortController>();

interface Credentials {
	token: string;
	chatId: string;
}

interface HostInfo {
	instanceId: string;
	/** Highest access the host publishes (`view` / `control`; empty for unseen legacy output). */
	access: string;
}

/** A minted link plus the access level its own CLI response confirmed. */
interface LinkTarget {
	url: string;
	access: string | null;
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
	on(event: "session_switch", handler: (event: unknown, ctx: ExtensionContextLike) => void): void;
	on(event: "session_branch", handler: (event: unknown, ctx: ExtensionContextLike) => void): void;
	on(event: "session_shutdown", handler: (event: unknown, ctx: ExtensionContextLike) => void): void;
	logger?: LoggerLike;
	exec(
		command: string,
		args: string[],
		options?: { timeout?: number; signal?: AbortSignal },
	): Promise<ExecResultLike>;
}

interface RunArgs {
	pi: ExtensionApiLike;
	ctx: ExtensionContextLike;
	sessionId: string;
	envPath: string;
	signal: AbortSignal;
}

/** Constructor name of a caught error, or "non-error" for thrown non-objects. */
function errorNameOf(error: unknown): string {
	return error instanceof Error ? error.name : "non-error";
}

/**
 * View an unknown JSON value as a plain record. Property existence and type
 * checks on `unknown` do not survive `in`-narrowing, so JSON shapes first pass
 * through this; every field read is then an explicit, unknown-valued check.
 */
function recordOf(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	return value as Record<string, unknown>;
}

/** Agent directory resolved exactly like omp: env override first (profiles export theirs), else config root. */
function resolveAgentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override) return override;
	return path.join(os.homedir(), process.env.PI_CONFIG_DIR || ".omp", "agent");
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

/**
 * Outcome of one `omp` subcommand in a shape callers can diagnose without
 * secrets: stdout only after a zero exit, and the first bounded non-blank
 * stderr line always (the CLI's own error text). Exit diagnostics are logged
 * inside `execOmp`; callers only consume stdout/stderr.
 */
interface OmpOutcome {
	stdout: string | null;
	stderr: string | null;
}

/** Extract the first non-blank line of `text`, bounded to `LOG_LINE_MAX`. */
function boundedFirstLine(text: string): string | null {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		return trimmed.length > LOG_LINE_MAX ? `${trimmed.slice(0, LOG_LINE_MAX)}…` : trimmed;
	}
	return null;
}

/** Run an `omp` subcommand; every failure is logged in bounded fields, never thrown details. */
async function execOmp(
	pi: ExtensionApiLike,
	args: string[],
	signal: AbortSignal | undefined,
): Promise<OmpOutcome> {
	try {
		const result = await pi.exec("omp", args, { timeout: CMD_TIMEOUT_MS, signal });
		const stderr = boundedFirstLine(result.stderr);
		if (result.code !== 0) {
			pi.logger?.debug?.("telegram-collab-link: omp command failed", {
				action: args[1] ?? null,
				code: result.code,
				killed: result.killed,
				stderr,
			});
			return { stdout: null, stderr };
		}
		return { stdout: result.stdout, stderr };
	} catch (error) {
		// Exception messages can embed argv or url fragments; log the class only.
		pi.logger?.debug?.("telegram-collab-link: omp command failed", {
			action: args[1] ?? null,
			code: null,
			errorName: errorNameOf(error),
		});
		return { stdout: null, stderr: null };
	}
}

interface HostLookup {
	host: HostInfo | null;
	/** Live hosts visible in this listing. */
	listedHosts: number;
	/** Live hosts sharing this pid (0 → collab is hosting nothing of this process). */
	pidMatches: number;
}

/** Find this process's own host for `sessionId`; never falls back to another host. */
async function findHost(
	pi: ExtensionApiLike,
	sessionId: string,
	signal: AbortSignal | undefined,
): Promise<HostLookup | null> {
	const outcome = await execOmp(pi, ["collab", "list", "--json"], signal);
	if (outcome.stdout === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(outcome.stdout);
	} catch {
		return null;
	}
	const parsedRecord = recordOf(parsed);
	if (parsedRecord === null || !("hosts" in parsedRecord) || !Array.isArray(parsedRecord.hosts)) {
		return null;
	}
	const listed: unknown[] = parsedRecord.hosts;

	const lookup: HostLookup = { host: null, listedHosts: listed.length, pidMatches: 0 };
	for (const item of listed) {
		const candidate = recordOf(item);
		if (candidate === null) continue;
		if (typeof candidate.pid !== "number" || typeof candidate.sessionId !== "string") continue;
		if (typeof candidate.instanceId !== "string" || candidate.instanceId.length === 0) continue;
		if (candidate.pid === process.pid) lookup.pidMatches += 1;
		if (candidate.pid !== process.pid || candidate.sessionId !== sessionId || lookup.host !== null) continue;

		const access = typeof candidate.access === "string" ? candidate.access : "";
		lookup.host = { instanceId: candidate.instanceId, access };
	}

	return lookup;
}

interface MintOutcome {
	/** The minted URL, or null when the mint failed. */
	url: string | null;
	/** Access level of the minted link as confirmed by the CLI response (`view`/`control`). */
	access: string | null;
	/** Bounded one-line CLI error for the last refusal, kept so the final log can explain it. */
	note: string | null;
	/** The room rotated between `collab list` and `collab link`; the next poll heals it. */
	stale: boolean;
}

/** Mint the join link for `host`; marks registry rotation as `stale` instead of treating it as a failure. */
async function mintLink(
	pi: ExtensionApiLike,
	host: HostInfo,
	signal: AbortSignal | undefined,
): Promise<MintOutcome> {
	const args = ["collab", "link", host.instanceId];
	if (host.access === "view") args.push("--view");
	args.push("--json");

	const outcome = await execOmp(pi, args, signal);
	if (outcome.stdout === null) {
		// `omp collab link` failed; reject `stale_generation`-shaped refusals as
		// room rotation (`error: host ... started a new room since it was listed`)
		// and let other CLI refusals surface through their bounded stderr line.
		const stale = outcome.stderr !== null && /started a new room|stale_generation/.test(outcome.stderr);
		return { url: null, access: null, note: outcome.stderr, stale };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(outcome.stdout);
	} catch {
		return { url: null, access: null, note: "unparseable collab link output", stale: false };
	}
	const parsedRecord = recordOf(parsed);
	if (parsedRecord === null || !("url" in parsedRecord)) {
		return { url: null, access: null, note: "collab link output missing url", stale: false };
	}
	const url = typeof parsedRecord.url === "string" ? parsedRecord.url : null;
	if (url === null || url.length === 0) {
		return { url: null, access: null, note: "collab link returned no url", stale: false };
	}

	// The registry response carries the access of the link it minted; trust that
	// over the listing snapshot for the join-message label.
	const access = typeof parsedRecord.access === "string" ? parsedRecord.access : null;
	return { url, access, note: null, stale: false };
}

interface SendOutcome {
	sent: boolean;
	/** True when the run was cancelled by a session transition; no notify, no retry. */
	cancelled: boolean;
	/** Completed Telegram attempts before this outcome. */
	attempts: number;
	/** Failure class phrased for the log and notify; never token/url/exception text. */
	cause: string;
	status: number | null;
	telegramErrorCode: unknown;
	messageId: unknown;
}

/** Send one Telegram message. Retries only Telegram's explicit HTTP 429 rejections. */
async function sendLink(
	credentials: Credentials,
	text: string,
	signal: AbortSignal,
): Promise<SendOutcome> {
	const cancelled: Omit<SendOutcome, "attempts"> = {
		sent: false,
		cancelled: true,
		cause: "cancelled before completion",
		status: null,
		telegramErrorCode: null,
		messageId: null,
	};

	for (let attempt = 1; ; attempt++) {
		if (signal.aborted) return { ...cancelled, attempts: attempt - 1 };

		// Distinguish a send timeout from other aborts without relying on the
		// runtime's AbortError/TimeoutError naming.
		let timedOut = false;
		const timeoutSignal = AbortSignal.timeout(SEND_TIMEOUT_MS);
		timeoutSignal.addEventListener(
			"abort",
			() => {
				timedOut = true;
			},
			{ once: true },
		);

		let reportedOk: unknown = false;
		let errorCode: unknown = null;
		let messageId: unknown = null;
		let retryAfterMs: number | null = null;

		try {
			const res = await fetch(`https://api.telegram.org/bot${credentials.token}/sendMessage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chat_id: credentials.chatId, text, disable_web_page_preview: true }),
				signal: AbortSignal.any([timeoutSignal, signal]),
			});

			const reply = recordOf(await res.json().catch(() => null));
			if (reply !== null) {
				if ("ok" in reply) reportedOk = reply.ok;
				if ("error_code" in reply) errorCode = reply.error_code;
				const parameters = recordOf(reply.parameters);
				if (
					parameters !== null &&
					typeof parameters.retry_after === "number" &&
					parameters.retry_after > 0
				) {
					retryAfterMs = parameters.retry_after * 1_000;
				}
				const result = recordOf(reply.result);
				if (result !== null && "message_id" in result) {
					messageId = result.message_id;
				}
			}

			if (res.ok && reportedOk === true) {
				return {
					sent: true,
					cancelled: false,
					attempts: attempt,
					cause: "",
					status: res.status,
					telegramErrorCode: errorCode,
					messageId,
				};
			}

			// 429 is Telegram explicitly rejecting the message (nothing was
			// delivered), so a bounded retry cannot duplicate. Everything else —
			// network errors, timeouts, other statuses (incl. 5xx) — may have
			// delivered and is deliberately never retried.
			if (res.status === 429 && attempt < SEND_ATTEMPTS) {
				const waitMs = Math.min(Math.max(retryAfterMs ?? SEND_RETRY_DEFAULT_MS, 0), SEND_RETRY_WAIT_MAX_MS);
				try {
					await sleep(waitMs, undefined, { signal });
				} catch {
					// Aborted is fine: the next loop iteration returns cancelled.
				}
				continue;
			}

			return {
				sent: false,
				cancelled: false,
				attempts: attempt,
				cause: res.status === 429 ? "rate limited (429); retries exhausted" : `telegram HTTP ${res.status}`,
				status: res.status,
				telegramErrorCode: errorCode,
				messageId: null,
			};
		} catch (error) {
			if (signal.aborted) return { ...cancelled, attempts: attempt - 1 };
			return {
				sent: false,
				cancelled: false,
				attempts: attempt,
				cause: timedOut ? "send timed out" : `network error (${errorNameOf(error)})`,
				status: null,
				telegramErrorCode: null,
				messageId: null,
			};
		}
	}
}

/** Background worker: poll for the host, mint the link, send it once. Never throws. */
async function run({ pi, ctx, sessionId, envPath, signal }: RunArgs): Promise<void> {
	const beganAt = Date.now();
	const credentials = await readCredentials(envPath);
	if (!credentials) {
		ctx.ui.notify(`Collab link not sent: missing Telegram credentials in ${envPath}`, "warning");
		pi.logger?.warn?.("telegram-collab-link: credentials unavailable", { envPath });
		return;
	}

	// Structured facts for the timeout log; no urls, tokens, or chat ids.
	let listedHosts = 0;
	let pidMatches = 0;
	let hostSeen = false;
	let listSucceeded = false;
	let mintStreak = 0;
	let mintStaleStreak = 0;
	let lastMintNote: string | null = null;

	const deadline = beganAt + POLL_BUDGET_MS;
	let target: LinkTarget | null = null;

	for (;;) {
		if (signal.aborted) {
			pi.logger?.debug?.("telegram-collab-link: delivery cancelled during host poll", {
				sessionId,
				afterMs: Date.now() - beganAt,
			});
			return;
		}

		// No new poll step starts after the budget expires; a step already in
		// flight at the deadline may complete a few seconds later.
		if (Date.now() >= deadline) break;

		const lookup = await findHost(pi, sessionId, signal);
		if (lookup !== null) {
			listSucceeded = true;
			listedHosts = lookup.listedHosts;
			pidMatches = lookup.pidMatches;
			if (lookup.host !== null) hostSeen = true;

			if (lookup.host !== null) {
				const minted = await mintLink(pi, lookup.host, signal);
				if (minted.url !== null) {
					target = { url: minted.url, access: minted.access ?? lookup.host.access };
					break;
				}
				mintStreak += 1;
				mintStaleStreak = minted.stale ? mintStaleStreak + 1 : 0;
				if (minted.note) lastMintNote = minted.note;
			}
		}

		if (signal.aborted) {
			pi.logger?.debug?.("telegram-collab-link: delivery cancelled during host poll", {
				sessionId,
				afterMs: Date.now() - beganAt,
			});
			return;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		try {
			await sleep(Math.min(remaining, POLL_INTERVAL_MS), undefined, { signal });
		} catch {
			// Aborted is fine: the loop top re-checks the signal.
		}
	}

	if (target === null) {
		pi.logger?.warn?.("telegram-collab-link: no deliveryable collab link", {
			sessionId,
			afterMs: Date.now() - beganAt,
			budgetMs: POLL_BUDGET_MS,
			hostSeen,
			listSucceeded,
			listedHosts,
			pidMatches,
			mintStreak,
			mintStaleStreak,
			mintNote: lastMintNote,
		});
		return;
	}

	// The label reflects the access the registry confirmed for this link
	// (`view` → view-only; anything else the room serves as control).
	const accessLabel = target.access === "view" ? "view-only" : "control";
	const text = `OMP session ready — join with ${accessLabel} access:\n${target.url}`;
	const outcome = await sendLink(credentials, text, signal);
	if (outcome.sent) {
		deliveredAt.set(sessionId, Date.now());
		pi.logger?.info?.("telegram-collab-link: delivered", {
			chatIdTail: String(credentials.chatId).slice(-4),
			messageId: outcome.messageId,
			sessionId,
			attempts: outcome.attempts,
		});
		return;
	}
	if (outcome.cancelled) {
		pi.logger?.debug?.("telegram-collab-link: delivery cancelled after link mint", {
			sessionId,
			afterMs: Date.now() - beganAt,
		});
		return;
	}

	ctx.ui.notify(
		`Telegram delivery of collab link failed — ${outcome.cause}; the session is unaffected (see log)`,
		"warning",
	);
	pi.logger?.warn?.("telegram-collab-link: delivery failed", {
		sessionId,
		cause: outcome.cause,
		status: outcome.status,
		telegramErrorCode: outcome.telegramErrorCode,
		attempts: outcome.attempts,
	});
}

/** Reason of a `session_branch` event, or null when the payload says otherwise. */
function branchReasonOf(event: unknown): string | null {
	const payload = recordOf(event);
	if (payload === null || typeof payload.reason !== "string") return null;
	return payload.reason;
}

/** Cancel every still-pending delivery that is not the now-active main session:
 * a switch/branch stops the previous room and withdraws its registry entry, so
 * a queued link would point at a dead room.
 */
function cancelStalePending(
	pi: ExtensionApiLike,
	ctx: ExtensionContextLike,
	action: string,
	reason: string,
): void {
	// Guard like the start handler: only the interactive main agent's context
	// cancels, so a rebound subagent context cannot touch the main run.
	if (ctx.mode !== "tui" || ctx.hasUI !== true) return;
	if (ctx.agent?.kind !== "main") return;
	const activeId = ctx.sessionManager?.getSessionId();
	if (typeof activeId !== "string" || activeId.length === 0) return;

	for (const [pendingId, controller] of [...pendingSends]) {
		if (pendingId === activeId) continue;
		pendingSends.delete(pendingId);
		controller.abort();
		pi.logger?.debug?.("telegram-collab-link: pending delivery cancelled", {
			sessionId: pendingId,
			action,
			reason,
		});
	}
}

/** Cancel this session's own pending delivery while it disposes; others stay. */
function cancelOwnPending(pi: ExtensionApiLike, ctx: ExtensionContextLike): void {
	if (ctx.agent?.kind !== "main") return;
	const sessionId = ctx.sessionManager?.getSessionId();
	if (typeof sessionId !== "string" || sessionId.length === 0) return;
	const controller = pendingSends.get(sessionId);
	if (controller === undefined) return;
	pendingSends.delete(sessionId);
	controller.abort();
	pi.logger?.debug?.("telegram-collab-link: pending delivery cancelled", {
		sessionId,
		action: "session_shutdown",
	});
}

export default function telegramCollabLink(pi: ExtensionApiLike): void {
	pi.on("session_start", (_event, ctx) => {
		try {
			// Filter synchronously so non-interactive and subagent sessions cost nothing.
			if (ctx.mode !== "tui" || ctx.hasUI !== true) return;
			if (ctx.agent?.kind !== "main") return;

			const sessionId = ctx.sessionManager?.getSessionId();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;

			// Delivered once per process stays delivered: replays of
			// `session_start` for an already-delivered session never re-send.
			if (deliveredAt.has(sessionId)) {
				pi.logger?.debug?.("telegram-collab-link: already delivered, skipping", { sessionId });
				return;
			}
			if (inFlight.has(sessionId)) return;

			const envPath = path.join(resolveAgentDir(), "telegram-collab.env");

			// Claim the session before yielding so a replayed event cannot double-send.
			inFlight.add(sessionId);
			const controller = new AbortController();
			pendingSends.set(sessionId, controller);
			// The handler must return immediately: collab can take minutes to publish.
			void run({ pi, ctx, sessionId, envPath, signal: controller.signal })
				.catch((error) => {
					pi.logger?.warn?.("telegram-collab-link: unexpected failure", {
						errorName: errorNameOf(error),
						sessionId,
					});
				})
				.finally(() => {
					pendingSends.delete(sessionId);
					inFlight.delete(sessionId);
				});
		} catch (error) {
			pi.logger?.warn?.("telegram-collab-link: handler failed", { errorName: errorNameOf(error) });
		}
	});

	// Verified transitions: new/resume/fork switches and branch/fork replace the
	// active main session; CollabController stops that session's room and
	// withdraws its registry entry. Tree navigation and /btw are ignored: they
	// target the same session lineage.
	pi.on("session_switch", (_event, ctx) => {
		cancelStalePending(pi, ctx, "session_switch", "room stopped on session change");
	});
	pi.on("session_branch", (event, ctx) => {
		if (branchReasonOf(event) === "btw") return;
		cancelStalePending(pi, ctx, "session_branch", "room stopped on branch");
	});
	pi.on("session_shutdown", (_event, ctx) => {
		cancelOwnPending(pi, ctx);
	});
}
