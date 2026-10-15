/** Builders for session-branch entries shaped like the ones pi and rpiv-todo persist. */

import { STATE_ENTRY_TYPE, type TaskStatus, TODO_TOOL_NAME, type TodoTask } from "../src/todo-state.ts";

let sequence = 0;

function nextEntryId(): string {
	sequence += 1;
	return `entry-${sequence}`;
}

export function task(id: number, status: TaskStatus, subject = `task ${id}`): TodoTask {
	return { id, subject, status };
}

/** A `custom` "rpiv-todo-state" entry, as rpiv-todo appends for every state change. */
export function stateEntry(tasks: TodoTask[]) {
	return {
		id: nextEntryId(),
		type: "custom",
		customType: STATE_ENTRY_TYPE,
		data: { action: "update", params: {}, tasks, nextId: tasks.length + 1 },
	};
}

/** A `todo` toolResult message entry carrying the `details` snapshot. */
export function todoResult(action: string, tasks: TodoTask[], extra: Record<string, unknown> = {}) {
	return {
		id: nextEntryId(),
		type: "message",
		message: {
			role: "toolResult",
			toolName: TODO_TOOL_NAME,
			content: [{ type: "text", text: action }],
			details: { action, params: {}, tasks, nextId: tasks.length + 1, ...extra },
		},
	};
}

export function userMessage(text = "hello") {
	return { id: nextEntryId(), type: "message", message: { role: "user", content: text } };
}

export function assistantMessage(text = "done") {
	return {
		id: nextEntryId(),
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
	};
}

/** A toolResult message entry from any tool, e.g. one that ended the run with `terminate: true`. */
export function toolResult(toolName: string, text = "ok") {
	return {
		id: nextEntryId(),
		type: "message",
		message: { role: "toolResult", toolName, content: [{ type: "text", text }], details: undefined },
	};
}

/** A displayed `custom_message` entry, as extensions append through `sendMessage` or boundaries. */
export function customMessage(customType = "other-extension", content = "note") {
	return { id: nextEntryId(), type: "custom_message", customType, content, display: true };
}
