# Pi Stop Continuation Guard

A Pi extension that checks whether the agent is stopping before finishing work you
already requested. A System One decision model compares observed human instructions
with the final answer. Clearly authorized unfinished work gets a visible continuation
message, with at most two automatic continuations per genuine user input.

It does not approve permission prompts, turn planning requests into implementation,
or execute the judge's free-form suggestions.

## Install

Requires Pi 1.3.0, Node.js 22.18 or newer, and a System One endpoint that supports
`choice` questions and Bearer authentication. The guard asks one question: the answer
is either a stop reason or the ID of the observed user input that authorizes a continuation.
Git access must be configured if the repository is private. GitHub visibility is independent
of the package's `private` flag, which prevents accidental npm publication.

```sh
pi install git:github.com/quantti/pi-stop-continuation-guard
```

Create `~/.config/pi-stop-guard.json`. To use a different file, set
`PI_STOP_GUARD_CONFIG` to its absolute path before launching Pi.

```json
{
  "endpoint": "https://api.example.com/v1/systemone",
  "model": "your-decision-model",
  "apiKeyFile": "/absolute/path/to/key",
  "timeoutMs": 2000
}
```

Give the full HTTPS endpoint URL. Store only the API key in the key file and restrict
its permissions to your user. Use an endpoint authorized to receive your task data.
There is no default endpoint. `timeoutMs` is optional and accepts 1 to 20,000 ms.
Restart Pi or run `/reload` after changing the configuration or key.

The guard is on by default in configured interactive TUI sessions. It does not operate in RPC, print or JSON sessions, including ordinary
noninteractive subagents. It cannot reconstruct trustworthy human provenance from
an existing session's old history after loading or reloading.

## Control

- `/stop-guard off` disables the guard immediately.
- `/stop-guard report` reports decisions without continuing.
- `/stop-guard on` enables automatic continuation.
- `/stop-guard status` shows the mode, configuration status, and continuation count.

Typing or pressing Escape while the judge is running cancels its decision without
consuming the key. Approval waits, cancellation, stale results and ambiguous scope
do not trigger automatic continuation. A new genuine user input resets the two-turn
allowance; synthetic extension messages do not.

## Limits

The guard observes up to 16 human inputs, with a limit of 2,000 characters each. It
also includes short transcript excerpts, the final answer, tool names, and tool error
flags. If the full packet exceeds 16,000 characters, the guard does not call the judge.
It does not send raw tool output. Missing or clipped authorization and image-based
instructions cannot authorize a continuation.

Each eligible stop makes one request. The default deadline is two seconds. The guard
does not follow redirects, retry, or call another model if the endpoint fails.
Missing configuration, an invalid response, or a timeout leaves the agent stopped.

The guard does not continue while tracked background work is active. Tracking covers
observed pi-subagents jobs and registered background-work providers, not arbitrary processes. The judge can misinterpret intent: this is a
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
settlement, the custom-message continuation, and cancellation.
Tests use synthetic conversations and stubbed HTTP responses, not live credentials.
Live semantic checks are separate from these deterministic tests.

## License

[MIT](LICENSE), copyright 2026 quantti. Credentials and model subscriptions are supplied
by the user and are not included in the package.
