import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import todoStopReminder, { DEFAULT_MAX_REMINDERS, REMINDER_MESSAGE_TYPE, resolveConfig } from "../src/index.ts";
import { endedOnToolResult, formatReminder } from "../src/reminder.ts";
import {
	assistantMessage,
	customMessage,
	stateEntry,
	task,
	todoResult,
	toolResult,
	userMessage,
} from "./fixtures.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface ReminderDraft {
	type: string;
	customType: string;
	content: string;
	display: boolean;
	details: { reminder: number; maxReminders: number; openTaskIds: number[] };
}

interface SettleResult {
	entries: ReminderDraft[];
	continue: boolean;
}

/** Fake pi host: captures handlers and drives them against an in-memory branch per session. */
function setup(env: Record<string, string | undefined> = {}) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	};
	todoStopReminder(pi as unknown as ExtensionAPI, env);

	const branches = new Map<string, unknown[]>([["session-1", []]]);
	let current = "session-1";
	const branch = (): unknown[] => branches.get(current) ?? [];
	const ctx = () => ({
		sessionManager: {
			getSessionId: () => current,
			getBranch: () => [...branch()],
			getLeafId: () => (branch().at(-1) as { id: string } | undefined)?.id ?? null,
		},
	});
	const emit = (name: string, event: unknown = {}) => (handlers.get(name) ?? []).map((handler) => handler(event, ctx()));

	return {
		handlers,
		push: (...entries: unknown[]) => branch().push(...entries),
		switchSession(id: string) {
			if (!branches.has(id)) branches.set(id, []);
			current = id;
		},
		/** `before_agent_start` fires before the prompt is persisted. */
		startRun(text = "do the work") {
			emit("before_agent_start", { type: "before_agent_start" });
			branch().push(userMessage(text));
		},
		settle(overrides: Record<string, unknown> = {}): SettleResult | undefined {
			const [result] = emit("agent_before_settle", {
				type: "agent_before_settle",
				outcome: "completed",
				entries: [],
				continue: false,
				context: { pendingMessages: [] },
				...overrides,
			});
			return result as SettleResult | undefined;
		},
		settled: () => emit("agent_settled", { type: "agent_settled", aborted: false }),
	};
}

/** A run that plans three tasks, finishes the first, and stops. */
function runWithOpenTasks(host: ReturnType<typeof setup>): void {
	host.startRun();
	const planned = [task(1, "pending"), task(2, "pending"), task(3, "pending")];
	host.push(stateEntry(planned), todoResult("create", planned));
	const progressed = [task(1, "completed"), task(2, "pending"), task(3, "pending")];
	host.push(stateEntry(progressed), todoResult("update", progressed), assistantMessage("ok"));
}

describe("reminder", () => {
	it("appends a visible reminder listing only open tasks and requests continuation", () => {
		const host = setup();
		runWithOpenTasks(host);
		const earlier = { type: "custom", customType: "other-extension" };
		const result = host.settle({ entries: [earlier] });

		assert.ok(result);
		assert.equal(result.continue, true);
		assert.equal(result.entries.length, 2);
		assert.deepEqual(result.entries[0], earlier, "drafts from earlier handlers are kept");
		const reminder = result.entries[1];
		assert.ok(reminder);
		assert.equal(reminder.type, "custom_message");
		assert.equal(reminder.customType, REMINDER_MESSAGE_TYPE);
		assert.equal(reminder.display, true);
		assert.match(reminder.content, /#2 \[pending\] task 2/);
		assert.match(reminder.content, /#3 \[pending\] task 3/);
		assert.doesNotMatch(reminder.content, /#1 /);
		assert.deepEqual(reminder.details, { reminder: 1, maxReminders: DEFAULT_MAX_REMINDERS, openTaskIds: [2, 3] });
	});

	it("reads state written only through codemode (state entries without toolResults)", () => {
		const host = setup();
		host.startRun();
		host.push(stateEntry([task(1, "completed"), task(2, "pending")]), assistantMessage());
		assert.deepEqual(host.settle()?.entries[0]?.details.openTaskIds, [2]);
	});

	it("does not remind when every task is completed or deleted", () => {
		const host = setup();
		host.startRun();
		host.push(stateEntry([task(1, "completed"), task(2, "deleted")]), assistantMessage());
		assert.equal(host.settle(), undefined);
	});

	it("does not remind when the session never used the todo list", () => {
		const host = setup();
		host.startRun();
		host.push(assistantMessage());
		assert.equal(host.settle(), undefined);
	});
});

describe("guards", () => {
	it("does not remind after an abort or a provider error", () => {
		for (const outcome of ["aborted", "error"]) {
			const host = setup();
			runWithOpenTasks(host);
			assert.equal(host.settle({ outcome }), undefined, outcome);
		}
	});

	it("defers to a continuation another handler requested or to queued messages", () => {
		const host = setup();
		runWithOpenTasks(host);
		assert.equal(host.settle({ continue: true }), undefined);
		assert.equal(host.settle({ context: { pendingMessages: [{ role: "user" }] } }), undefined);
		assert.ok(host.settle(), "still reminds once nothing else continues the run");
	});

	it("ignores open tasks the current run did not touch", () => {
		const host = setup();
		runWithOpenTasks(host);
		host.settled();
		host.startRun("unrelated question");
		host.push(assistantMessage("answer"));
		assert.equal(host.settle(), undefined);
	});

	it("does not remind when the run start is unknown (e.g. loaded mid-run)", () => {
		const host = setup();
		host.push(userMessage(), stateEntry([task(1, "pending")]), assistantMessage());
		assert.equal(host.settle(), undefined);
	});

	it("does not repeat a reminder the agent answered without changing the list", () => {
		const host = setup();
		runWithOpenTasks(host);
		assert.ok(host.settle());
		host.push(assistantMessage("The user asked me to stop here."));
		assert.equal(host.settle(), undefined);
	});

	it("keeps reminding while the list progresses, up to the per-run limit", () => {
		const host = setup({ PI_TODO_STOP_REMINDER_MAX: "2" });
		host.startRun();
		host.push(stateEntry([task(1, "pending"), task(2, "pending"), task(3, "pending"), task(4, "pending")]));
		assert.equal(host.settle()?.entries[0]?.details.reminder, 1);
		host.push(stateEntry([task(1, "completed"), task(2, "pending"), task(3, "pending"), task(4, "pending")]));
		assert.equal(host.settle()?.entries[0]?.details.reminder, 2);
		host.push(stateEntry([task(1, "completed"), task(2, "completed"), task(3, "pending"), task(4, "pending")]));
		assert.equal(host.settle(), undefined, "limit reached");
	});

	it("starts a fresh budget for the next run after agent_settled", () => {
		const host = setup({ PI_TODO_STOP_REMINDER_MAX: "1" });
		runWithOpenTasks(host);
		assert.ok(host.settle());
		host.settled();
		host.startRun("continue");
		host.push(stateEntry([task(1, "completed"), task(2, "completed"), task(3, "pending")]));
		assert.equal(host.settle()?.entries[0]?.details.reminder, 1);
	});

	it("does not override a run that a tool ended on purpose", () => {
		// e.g. pi-goal-x's update_goal pausing the goal returns `terminate: true`,
		// so the run ends on its tool result without a final assistant message.
		const host = setup();
		runWithOpenTasks(host);
		host.push(toolResult("update_goal", "Goal paused."));
		assert.equal(host.settle(), undefined);
	});

	it("still reminds when the model answered after its last tool call", () => {
		const host = setup();
		runWithOpenTasks(host);
		host.push(toolResult("bash"), assistantMessage("stopping"), customMessage());
		assert.ok(host.settle());
	});

	it("keeps per-run state separate for each session", () => {
		const host = setup();
		runWithOpenTasks(host);
		assert.ok(host.settle());
		host.switchSession("session-2");
		runWithOpenTasks(host);
		assert.equal(host.settle()?.entries[0]?.details.reminder, 1);
		host.switchSession("session-1");
		host.push(assistantMessage("no progress"));
		assert.equal(host.settle(), undefined);
	});
});

describe("endedOnToolResult", () => {
	it("looks at the last message and skips non-message entries", () => {
		assert.equal(endedOnToolResult([]), false);
		assert.equal(endedOnToolResult([userMessage(), assistantMessage()]), false);
		assert.equal(endedOnToolResult([assistantMessage(), toolResult("update_goal")]), true);
		assert.equal(
			endedOnToolResult([toolResult("set_goal_tasks"), stateEntry([task(1, "pending")]), customMessage()]),
			true,
		);
		assert.equal(endedOnToolResult([toolResult("bash"), assistantMessage(), customMessage()]), false);
		assert.equal(endedOnToolResult([null, undefined, "noise"]), false);
	});
});

describe("formatReminder", () => {
	it("flattens and truncates subjects and lists only open blockers", () => {
		const long = `first line\nsecond ${"x".repeat(200)}`;
		const text = formatReminder([
			{ id: 2, subject: long, status: "in_progress", blockedBy: [1, 3] },
			{ id: 3, subject: "c", status: "pending" },
		]);
		const line = text.split("\n").find((l) => l.startsWith("- #2"));
		assert.ok(line);
		assert.doesNotMatch(line, /\n/);
		assert.match(line, /^- #2 \[in_progress\] first line second x+… \(blocked by #3\)$/);
		assert.match(text, /2 open tasks/);
	});

	it("asks the agent to check the request's scope before continuing", () => {
		const text = formatReminder([{ id: 1, subject: "a", status: "pending" }]);
		const scopeCheck = text.indexOf("only part of this list");
		const continueStep = text.indexOf("continue with the next open task");
		assert.ok(scopeCheck !== -1 && continueStep !== -1);
		assert.ok(scopeCheck < continueStep, "the scope check comes before the instruction to continue");
	});
});

describe("resolveConfig", () => {
	it("defaults to enabled with the default limit", () => {
		assert.deepEqual(resolveConfig({}), { enabled: true, maxReminders: DEFAULT_MAX_REMINDERS, debug: false });
	});

	it("can be disabled by flag or a zero limit", () => {
		assert.equal(resolveConfig({ PI_TODO_STOP_REMINDER: "off" }).enabled, false);
		assert.equal(resolveConfig({ PI_TODO_STOP_REMINDER: " FALSE " }).enabled, false);
		assert.equal(resolveConfig({ PI_TODO_STOP_REMINDER_MAX: "0" }).enabled, false);
	});

	it("falls back to the default limit on invalid values", () => {
		for (const value of ["-1", "1.5", "abc", ""]) {
			assert.equal(resolveConfig({ PI_TODO_STOP_REMINDER_MAX: value }).maxReminders, DEFAULT_MAX_REMINDERS, value);
		}
	});

	it("registers no handlers when disabled", () => {
		assert.equal(setup({ PI_TODO_STOP_REMINDER: "off" }).handlers.size, 0);
	});
});
