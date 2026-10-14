import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	fingerprint,
	isTodoMutation,
	mutatedSince,
	openTasks,
	readTodoTasks,
	snapshotTasks,
} from "../src/todo-state.ts";
import { assistantMessage, stateEntry, task, todoResult, userMessage } from "./fixtures.ts";

describe("snapshotTasks", () => {
	it("requires the { tasks, nextId } shape", () => {
		assert.equal(snapshotTasks(undefined), undefined);
		assert.equal(snapshotTasks({ tasks: [] }), undefined);
		assert.equal(snapshotTasks({ nextId: 1 }), undefined);
		assert.deepEqual(snapshotTasks({ tasks: [], nextId: 1 }), []);
	});

	it("drops malformed rows and keeps numeric blockedBy ids", () => {
		const tasks = snapshotTasks({
			tasks: [
				{ id: 1, subject: "a", status: "pending", blockedBy: [2, "x"] },
				{ id: "2", subject: "b", status: "pending" },
				{ id: 3, subject: "c", status: "unknown" },
			],
			nextId: 4,
		});
		assert.deepEqual(tasks, [{ id: 1, subject: "a", status: "pending", blockedBy: [2] }]);
	});
});

describe("readTodoTasks", () => {
	it("returns undefined when the branch never recorded a todo list", () => {
		assert.equal(readTodoTasks([userMessage(), assistantMessage()]), undefined);
	});

	it("uses the last toolResult snapshot when no state entry exists", () => {
		const branch = [todoResult("create", [task(1, "pending")]), todoResult("update", [task(1, "completed")])];
		assert.deepEqual(readTodoTasks(branch), [task(1, "completed")]);
	});

	it("treats state entries as authoritative over toolResult snapshots", () => {
		// A codemode call writes only a state entry; the earlier direct call's toolResult is stale.
		const branch = [
			todoResult("create", [task(1, "pending")]),
			stateEntry([task(1, "pending")]),
			stateEntry([task(1, "completed")]),
		];
		assert.deepEqual(readTodoTasks(branch), [task(1, "completed")]);
	});

	it("ignores entries with an unrecognized snapshot", () => {
		const branch = [stateEntry([task(1, "pending")]), { type: "custom", customType: "rpiv-todo-state", data: {} }];
		assert.deepEqual(readTodoTasks(branch), [task(1, "pending")]);
	});
});

describe("isTodoMutation", () => {
	it("counts state entries and successful mutating calls only", () => {
		assert.equal(isTodoMutation(stateEntry([])), true);
		assert.equal(isTodoMutation(todoResult("create", [])), true);
		assert.equal(isTodoMutation(todoResult("clear", [])), true);
		assert.equal(isTodoMutation(todoResult("list", [])), false);
		assert.equal(isTodoMutation(todoResult("get", [])), false);
		assert.equal(isTodoMutation(todoResult("update", [], { error: "invalid transition" })), false);
		assert.equal(isTodoMutation(userMessage()), false);
		assert.equal(isTodoMutation(null), false);
	});
});

describe("mutatedSince", () => {
	const before = stateEntry([task(1, "pending")]);
	const marker = userMessage();
	const after = stateEntry([task(1, "completed")]);

	it("scans the whole branch when the run started on an empty session", () => {
		assert.equal(mutatedSince([before], null), true);
	});

	it("only looks at entries after the marker", () => {
		assert.equal(mutatedSince([before, marker], marker.id), false);
		assert.equal(mutatedSince([before, marker, after], marker.id), true);
	});

	it("returns false when the marker is no longer on the branch", () => {
		assert.equal(mutatedSince([before, after], "missing"), false);
	});
});

describe("openTasks and fingerprint", () => {
	const tasks = [task(1, "completed"), task(2, "in_progress"), task(3, "pending"), task(4, "deleted")];

	it("keeps pending and in_progress tasks", () => {
		assert.deepEqual(
			openTasks(tasks).map((t) => t.id),
			[2, 3],
		);
	});

	it("changes when a status changes and ignores subjects", () => {
		const renamed = tasks.map((t) => ({ ...t, subject: `${t.subject}!` }));
		assert.equal(fingerprint(renamed), fingerprint(tasks));
		const progressed = tasks.map((t) => (t.id === 2 ? { ...t, status: "completed" as const } : t));
		assert.notEqual(fingerprint(progressed), fingerprint(tasks));
	});
});
