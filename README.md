# Pi Stop Continuation Guard

A Pi extension that checks whether the agent is stopping before finishing work you
already requested. A separate GPT-6 Luna judge compares observed human instructions
with the final answer. Clearly authorized unfinished work gets a visible continuation
message, with at most two automatic continuations per genuine user input.

It does not approve permission prompts, turn planning requests into implementation,
or execute the judge's free-form suggestions.

## Install

Requires Pi 1.3.0, Node.js 22.18 or newer, and authenticated access to
`openai-codex/gpt-6-luna`. The judge must also be allowed by the session's model scope.
Git access must be configured if the repository is private. GitHub visibility is independent
of the package's `private` flag, which prevents accidental npm publication.

```sh
pi install git:github.com/quantti/pi-stop-continuation-guard
```

Start a new Pi session after installation. The guard is on by default in interactive
TUI sessions. It does not operate in RPC, print or JSON sessions, including ordinary
noninteractive subagents. It cannot reconstruct trustworthy human provenance from
an existing session's old history after loading or reloading.

## Control

- `/stop-guard off` disables the guard immediately.
- `/stop-guard report` reports decisions without continuing.
- `/stop-guard on` enables automatic continuation.
- `/stop-guard status` shows the mode and continuation count.

Typing or pressing Escape while the judge is running cancels its decision without
consuming the key. Approval waits, cancellation, stale results and ambiguous scope
do not trigger automatic continuation. A new genuine user input resets the two-turn
allowance; synthetic extension messages do not.

## Limits

The guard observes up to six human inputs, bounded to 2,000 characters each, plus
bounded transcript excerpts, the final answer and tool names/error flags. It does not
send raw tool output to the judge. Missing or clipped authorization and image-based
instructions cannot authorize a continuation.

Each eligible stop makes a separate tool-free model call, with no provider retry and
a 20-second deadline. The requested 400-token output limit is not a hard budget in
the Codex provider; the deadline, context bound and continuation cap limit spending.
If Luna or its credentials are unavailable, the agent remains stopped.

Background tracking covers observed pi-subagents jobs and registered background-work
providers, not arbitrary processes. The judge can misinterpret intent: this is a
bounded nudge, not proof of completion or a permissions sandbox. Existing approval
and security rules still apply. Use `off` to stop nudging, or remove the package:

```sh
pi remove git:github.com/quantti/pi-stop-continuation-guard
```

## Development

There are no package dependencies to install. Run the deterministic behavioral tests:

```sh
npm test
```

The installed-Pi integration test is skipped unless `PI_PACKAGE_DIR` points to the
`@earendil-works/pi-coding-agent` package directory. Set it to exercise native
settlement, the custom-message continuation and cancellation against Pi 1.3.0.
Tests use synthetic conversations and a fake provider, not your live credentials.
Live semantic checks are separate from these deterministic tests.

## License

[MIT](LICENSE), copyright 2026 quantti. Credentials and model subscriptions are supplied
by the user and are not included in the package.
