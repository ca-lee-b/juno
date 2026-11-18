# Sandbox engine

Install and configure Codex **before starting the engine**. The sandbox needs a Codex CLI with app-server support and credentials for its model provider. The Go binary runs one Codex process and lazily creates one thread on the first send. Later sends reuse it.

Build from this directory. For a Linux amd64 sandbox:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ./bin/engine ./cmd/engine
```

Upload the binary and start it inside the sandbox:

```sh
ENGINE_ENDPOINT=wss://example.com/sandbox/123 ./bin/engine -dir /workspace
```

Use a distinct endpoint path or credential to identify each sandbox. Set optional `ENGINE_TOKEN` to authenticate the WebSocket upgrade with a bearer token. Flags include `-endpoint`, `-dir` and `-codex` (defaults to the executable on PATH). The child uses its own Codex configuration and credentials.

## WebSocket protocol

The engine dials the endpoint. Each text frame contains one JSON object. Commands carry a caller-chosen string ID. Replies contain that ID and either `result` or an `error` string. IDs correlate replies. Retrying a command can execute it twice.

| Endpoint command example | Behavior |
| --- | --- |
| `{"id":"a","op":"send","text":"Inspect the tests"}` | Start a turn and return its threadId and turnId. Returns busy during an active turn. The caller owns any queue. |
| `{"id":"b","op":"steer","turnId":"T","text":"Focus on auth"}` | Add input to the specified active turn. |
| `{"id":"c","op":"interrupt","turnId":"T"}` | Request interruption. Wait for the Codex turn/completed event for completion. |
| `{"id":"d","op":"respond","requestId":7,"result":{"answers":{"q1":{"answers":["Yes"]}}}}` | Answer a pending Codex request using its original ID and method-specific result. |
| `{"id":"e","op":"replay","from":43}` | Read from sequence 43 inclusive and continue live. The next unwritten sequence is also valid. |
| `{"id":"f","op":"prepare_shutdown"}` | Returns busy during work or while a request is pending. Otherwise returns ready_to_stop and closes admission to new turns. The caller can then terminate the sandbox. |

Codex notifications and server requests share the same event format:

```json
{"seq":42,"event":{"method":"item/agentMessage/delta","params":{"threadId":"th","turnId":"T","itemId":"i","delta":"Hello"}}}
```

Sequence numbers start at 1 per engine run. The engine appends each event to a private temporary file before delivery and retains a byte offset per event in memory. Reconnecting starts live. To catch up, request the first sequence after the last consecutive one you processed. Replayed events retain their sequence numbers, so clients can discard duplicates. A fresh consumer can replay from 1. There are no delivery acknowledgments or greeting. Socket loss leaves Codex running. Replay history is scoped to this process and consumes local disk for its lifetime.
