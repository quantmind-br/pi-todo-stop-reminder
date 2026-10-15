/**
 * Pure decision and message logic for the stop reminder. No pi runtime access:
 * `index.ts` feeds it the boundary event and the session branch.
 */

import { fingerprint, mutatedSince, openTasks, readTodoTasks, type TodoTask } from "./todo-state.ts";

export type Outcome = "completed" | "aborted" | "error";

/** Per-run bookkeeping. A run is one prompt plus every continuation it triggers. */
export interface RunState {
	/** Leaf entry id when the run started; `null` for an empty session, `undefined` when unknown. */
	startLeafId: string | null | undefined;
	/** Reminders already sent in this run. */
	reminders: number;
	/** Todo fingerprint at the last reminder. */
	lastFingerprint?: string;
}

export interface SettleInput {
	outcome: Outcome;
	/** An earlier `agent_before_settle` handler already requested continuation. */
	continueRequested: boolean;
	/** Messages already queued to run (user steering/follow-ups, extension messages). */
	pendingMessages: number;
	branch: readonly unknown[];
}

export type SkipReason =
	| "outcome"
	| "continuing"
	| "queued"
	| "terminated"
	| "no-todos"
	| "no-open-tasks"
	| "untouched"
	| "limit"
	| "no-progress";

export type Decision =
	| { remind: false; reason: SkipReason }
	| { remind: true; open: TodoTask[]; fingerprint: string };

function skip(reason: SkipReason): Decision {
	return { remind: false, reason };
}

/**
 * True when the last message on the branch is a tool result, so the model never
 * answered its last tool calls. A completed run only ends that way when a tool
 * returned `terminate: true` or an extension ended the turn: the run was stopped on
 * purpose (for example a goal that was paused, blocked, sent for completion review,
 * or is waiting for confirmation), and a reminder must not override that stop.
 * Non-message entries such as custom messages and state entries are skipped.
 */
export function endedOnToolResult(branch: readonly unknown[]): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: unknown; message?: { role?: unknown } } | null | undefined;
		if (entry?.type === "message") return entry.message?.role === "toolResult";
	}
	return false;
}

/**
 * Decide whether the agent should be reminded before it settles. It is reminded
 * only when all of these hold:
 * - the run ended normally (never after Esc or a provider error);
 * - nothing else will continue the run anyway (another handler's continuation or
 *   a queued message, which must take priority over a reminder);
 * - the run was not stopped on purpose right after a tool call (see `endedOnToolResult`);
 * - the todo list has pending or in_progress tasks;
 * - fewer than `maxReminders` reminders were sent in this run;
 * - first reminder: the list changed during this run, so open tasks left over from
 *   an earlier, unrelated prompt do not hijack the current one;
 * - later reminders: the list changed since the previous reminder. A reminder the
 *   agent answered without touching the list is a deliberate decision (the user
 *   limited the scope, or input is needed), so it is not repeated.
 */
export function decide(run: RunState, input: SettleInput, maxReminders: number): Decision {
	if (input.outcome !== "completed") return skip("outcome");
	if (input.continueRequested) return skip("continuing");
	if (input.pendingMessages > 0) return skip("queued");
	if (endedOnToolResult(input.branch)) return skip("terminated");

	const tasks = readTodoTasks(input.branch);
	if (tasks === undefined) return skip("no-todos");
	const open = openTasks(tasks);
	if (open.length === 0) return skip("no-open-tasks");
	if (run.reminders >= maxReminders) return skip("limit");

	const current = fingerprint(tasks);
	if (run.reminders === 0) {
		if (run.startLeafId === undefined || !mutatedSince(input.branch, run.startLeafId)) return skip("untouched");
	} else if (current === run.lastFingerprint) {
		return skip("no-progress");
	}
	return { remind: true, open, fingerprint: current };
}

const MAX_SUBJECT_LENGTH = 120;

function oneLine(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= MAX_SUBJECT_LENGTH ? flat : `${flat.slice(0, MAX_SUBJECT_LENGTH - 1)}…`;
}

/** Model-facing reminder text listing the open tasks. */
export function formatReminder(open: readonly TodoTask[]): string {
	const openIds = new Set(open.map((task) => task.id));
	const lines = open.map((task) => {
		const blockers = (task.blockedBy ?? []).filter((id) => openIds.has(id));
		const blocked = blockers.length > 0 ? ` (blocked by ${blockers.map((id) => `#${id}`).join(", ")})` : "";
		return `- #${task.id} [${task.status}] ${oneLine(task.subject)}${blocked}`;
	});
	const count = `${open.length} open task${open.length === 1 ? "" : "s"}`;
	return [
		`Todo reminder: you are about to stop with ${count} on your todo list:`,
		"",
		...lines,
		"",
		"Before stopping, check what the user asked for in this request:",
		"- If they asked for only part of this list (for example, only the first task, or only to create the tasks), or you need their input, do not continue. Reply in one sentence with which tasks remain open and why.",
		"- Otherwise, continue with the next open task now and keep the todo list in sync. If a task is already done, mark it completed; if it is no longer needed, delete it.",
	].join("\n");
}
