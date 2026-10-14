/**
 * pi-todo-stop-reminder — reminds the agent about open @juicesharp/rpiv-todo tasks
 * before it stops.
 *
 * Standalone companion to rpiv-todo: it never imports that package and reads the
 * todo list from the session branch (see `todo-state.ts`).
 *
 * Hook: `agent_before_settle`, the last boundary at which an extension can append
 * session entries and request one more model call. A reminder is a visible custom
 * message plus `continue: true`; `decide()` documents when one is sent.
 *
 * A run is one prompt plus every continuation it triggers. Continuations re-emit
 * `agent_start`, so per-run state is created at `before_agent_start` (once per run)
 * and dropped at `agent_settled` (once per run, after the last continuation).
 *
 * Environment:
 *   PI_TODO_STOP_REMINDER=off        disable the extension
 *   PI_TODO_STOP_REMINDER_MAX=<n>    reminders per run (default 3; 0 disables)
 *   PI_TODO_STOP_REMINDER_DEBUG=1    log each decision to stderr
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decide, formatReminder, type RunState } from "./reminder.ts";

export const REMINDER_MESSAGE_TYPE = "todo-stop-reminder";
export const DEFAULT_MAX_REMINDERS = 3;

export interface ReminderConfig {
	enabled: boolean;
	maxReminders: number;
	debug: boolean;
}

type Env = Record<string, string | undefined>;

const OFF_VALUES = new Set(["0", "off", "false", "no"]);

export function resolveConfig(env: Env = process.env): ReminderConfig {
	const flag = env.PI_TODO_STOP_REMINDER?.trim().toLowerCase();
	const rawMax = env.PI_TODO_STOP_REMINDER_MAX?.trim();
	const parsedMax = rawMax ? Number(rawMax) : Number.NaN;
	const maxReminders = Number.isInteger(parsedMax) && parsedMax >= 0 ? parsedMax : DEFAULT_MAX_REMINDERS;
	return {
		enabled: !(flag !== undefined && OFF_VALUES.has(flag)) && maxReminders > 0,
		maxReminders,
		debug: env.PI_TODO_STOP_REMINDER_DEBUG === "1",
	};
}

/**
 * Session id for per-run bookkeeping, or `undefined` when the context is stale
 * (pi invalidates a replaced session's ctx and its getters throw).
 */
function sessionKey(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

export default function todoStopReminder(pi: ExtensionAPI, env: Env = process.env): void {
	const config = resolveConfig(env);
	if (!config.enabled) return;

	const runs = new Map<string, RunState>();
	const log = (message: string): void => {
		if (config.debug) process.stderr.write(`[todo-stop-reminder] ${message}\n`);
	};
	const dropRun = (_event: unknown, ctx: ExtensionContext): void => {
		const key = sessionKey(ctx);
		if (key !== undefined) runs.delete(key);
	};

	pi.on("before_agent_start", (_event, ctx) => {
		const key = sessionKey(ctx);
		if (key === undefined) return;
		runs.set(key, { startLeafId: ctx.sessionManager.getLeafId(), reminders: 0 });
	});

	pi.on("agent_before_settle", (event, ctx) => {
		const key = sessionKey(ctx);
		if (key === undefined) return;
		const run = runs.get(key) ?? { startLeafId: undefined, reminders: 0 };
		const decision = decide(
			run,
			{
				outcome: event.outcome,
				continueRequested: event.continue,
				pendingMessages: event.context.pendingMessages.length,
				branch: ctx.sessionManager.getBranch(),
			},
			config.maxReminders,
		);
		if (!decision.remind) {
			log(`skip (${decision.reason})`);
			return;
		}

		run.reminders += 1;
		run.lastFingerprint = decision.fingerprint;
		runs.set(key, run);
		const openTaskIds = decision.open.map((task) => task.id);
		log(`remind ${run.reminders}/${config.maxReminders}: open ${openTaskIds.map((id) => `#${id}`).join(", ")}`);

		return {
			// Handlers chain: the returned list replaces `event.entries`, so keep earlier drafts.
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: REMINDER_MESSAGE_TYPE,
					content: formatReminder(decision.open),
					display: true,
					details: { reminder: run.reminders, maxReminders: config.maxReminders, openTaskIds },
				},
			],
			continue: true,
		};
	});

	pi.on("agent_settled", dropRun);
	pi.on("session_shutdown", dropRun);
}
