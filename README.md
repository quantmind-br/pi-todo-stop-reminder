# pi-todo-stop-reminder

A [pi](https://github.com/earendil-works/pi) extension that reminds the agent about open
[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo) tasks when it is
about to stop.

When a run ends while the todo list still has `pending` or `in_progress` tasks, the extension
appends a visible reminder listing those tasks and asks pi for one more model call. The agent then
either continues with the next task or says in one sentence why it is stopping.

It is a standalone companion: it does not import or modify `rpiv-todo`, and it reads the todo
list from the session itself.

## Requirements

- pi `>= 1.2.0` (uses the `agent_before_settle` boundary)
- `@juicesharp/rpiv-todo` loaded in the same session. Without it, the extension does nothing.

## Install

```sh
pi install npm:pi-todo-stop-reminder
```

Or from git, or from a local clone:

```sh
pi install git:github.com/quantmind-br/pi-todo-stop-reminder
pi install ./pi-todo-stop-reminder
```

Install it from one source only. Pi identifies npm packages by name and local packages by
path, so an npm entry and a local entry for this package load two copies. Each copy keeps its
own reminder limit and progress check, so the agent can get up to twice as many reminders per run.

Or try it for one session:

```sh
pi -e npm:pi-todo-stop-reminder
```

## When it reminds

The agent is reminded only when **all** of these hold:

| Guard | Why |
| --- | --- |
| The run ended normally | Never after Esc (abort) or a provider error. |
| Nothing else continues the run | Another extension's continuation and queued user messages take priority. |
| The list has `pending` or `in_progress` tasks | `completed` and `deleted` tasks are done. |
| The current run changed the list (first reminder) | Open tasks left over from an earlier prompt do not hijack an unrelated question. |
| The list changed since the last reminder (later reminders) | If the agent answers a reminder without touching the list, that is a deliberate stop and is not repeated. |
| Fewer than 3 reminders in this run | Hard cap against loops. A run is one prompt plus every continuation it triggers. |

## How it reads the todo list

The extension rebuilds the list from the current session branch, the same way `rpiv-todo` replays
its own state:

1. `custom` entries of type `rpiv-todo-state` hold a full snapshot after every change, including
   changes made through another tool such as codemode. When the branch has any, the last one wins.
2. Otherwise, the `details` of the last `todo` tool result are used. This covers sessions written
   before state entries existed.

Reading the session instead of `rpiv-todo`'s in-memory store keeps the two packages decoupled and
gives the right answer after branching, tree navigation, and compaction.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `PI_TODO_STOP_REMINDER` | on | `off`, `0`, `false`, or `no` disables the extension. |
| `PI_TODO_STOP_REMINDER_MAX` | `3` | Maximum reminders per run. `0` disables the extension. |
| `PI_TODO_STOP_REMINDER_DEBUG` | unset | `1` logs every decision to stderr. |

## Development

```sh
npm install
npm run check   # tsc --noEmit + node --test
```

The tests run on Node's built-in TypeScript type stripping (Node `>= 22.18`).

## License

MIT
