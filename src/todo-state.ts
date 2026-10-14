/**
 * Read-only view of @juicesharp/rpiv-todo state, rebuilt from the session branch.
 *
 * Mirrors rpiv-todo's own replay (`state/replay.ts`) without importing the package:
 * - `custom` entries of type "rpiv-todo-state" carry the full post-mutation snapshot
 *   for every state change, including calls made through another tool
 *   (`ctx.executeTool`, e.g. codemode) that never land as a standalone toolResult.
 *   Once the branch has any of them, they are authoritative.
 * - `todo` toolResult `details` carry the same `{ tasks, nextId }` shape and are the
 *   fallback for sessions written before state entries existed.
 */

export const STATE_ENTRY_TYPE = "rpiv-todo-state";
export const TODO_TOOL_NAME = "todo";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TodoTask {
	id: number;
	subject: string;
	status: TaskStatus;
	blockedBy?: number[];
}

/** The subset of a session entry this module inspects. */
interface BranchEntry {
	id?: unknown;
	type?: unknown;
	customType?: unknown;
	data?: unknown;
	message?: { role?: unknown; toolName?: unknown; details?: unknown };
}

const STATUSES: ReadonlySet<unknown> = new Set(["pending", "in_progress", "completed", "deleted"]);
const MUTATING_ACTIONS: ReadonlySet<unknown> = new Set(["create", "update", "delete", "clear"]);

function asEntry(value: unknown): BranchEntry {
	return value && typeof value === "object" ? (value as BranchEntry) : {};
}

function toTask(value: unknown): TodoTask | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "number" || typeof v.subject !== "string" || !STATUSES.has(v.status)) return undefined;
	const task: TodoTask = { id: v.id, subject: v.subject, status: v.status as TaskStatus };
	if (Array.isArray(v.blockedBy)) task.blockedBy = v.blockedBy.filter((id): id is number => typeof id === "number");
	return task;
}

/**
 * Tasks from a persisted `{ tasks, nextId }` snapshot, or `undefined` when the value
 * does not have that shape (same discriminator as rpiv-todo's `isTaskDetails`).
 * Malformed task rows are dropped instead of rejecting the whole snapshot.
 */
export function snapshotTasks(value: unknown): TodoTask[] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as { tasks?: unknown; nextId?: unknown };
	if (!Array.isArray(v.tasks) || typeof v.nextId !== "number") return undefined;
	return v.tasks.map(toTask).filter((task): task is TodoTask => task !== undefined);
}

function isTodoToolResult(entry: BranchEntry): boolean {
	return entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === TODO_TOOL_NAME;
}

/**
 * Latest todo list on the branch (last write wins), or `undefined` when the branch
 * never recorded one.
 */
export function readTodoTasks(branch: Iterable<unknown>): TodoTask[] | undefined {
	let fromEntries: TodoTask[] | undefined;
	let fromToolResults: TodoTask[] | undefined;
	for (const raw of branch) {
		const entry = asEntry(raw);
		if (entry.type === "custom") {
			if (entry.customType === STATE_ENTRY_TYPE) fromEntries = snapshotTasks(entry.data) ?? fromEntries;
			continue;
		}
		if (isTodoToolResult(entry)) fromToolResults = snapshotTasks(entry.message?.details) ?? fromToolResults;
	}
	return fromEntries ?? fromToolResults;
}

/**
 * True when the entry records a todo state change: a state entry, or a successful
 * mutating `todo` call (create/update/delete/clear). Reads (`list`, `get`) and
 * rejected calls do not count.
 */
export function isTodoMutation(raw: unknown): boolean {
	const entry = asEntry(raw);
	if (entry.type === "custom") return entry.customType === STATE_ENTRY_TYPE;
	if (!isTodoToolResult(entry)) return false;
	const details = entry.message?.details;
	if (!details || typeof details !== "object") return false;
	const d = details as { action?: unknown; error?: unknown };
	return MUTATING_ACTIONS.has(d.action) && d.error === undefined;
}

/**
 * Whether the todo list changed after the entry `sinceEntryId`.
 *
 * `null` means the run started on an empty session, so the whole branch counts.
 * An id that is no longer on the branch (e.g. after tree navigation) returns
 * `false`: when in doubt, the run is treated as not having touched the list.
 */
export function mutatedSince(branch: readonly unknown[], sinceEntryId: string | null): boolean {
	let start = 0;
	if (sinceEntryId !== null) {
		const index = branch.findIndex((raw) => asEntry(raw).id === sinceEntryId);
		if (index === -1) return false;
		start = index + 1;
	}
	for (let i = start; i < branch.length; i++) {
		if (isTodoMutation(branch[i])) return true;
	}
	return false;
}

/** Tasks still to do: `pending` or `in_progress`. */
export function openTasks(tasks: readonly TodoTask[]): TodoTask[] {
	return tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
}

/** Identity of the list's status layout; changes when any task is added, removed, or changes status. */
export function fingerprint(tasks: readonly TodoTask[]): string {
	return tasks.map((task) => `${task.id}:${task.status}`).join(",");
}
