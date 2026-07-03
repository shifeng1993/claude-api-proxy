# Responses WebSocket Mode Design

## Goal

Make Responses WebSocket mode usable and fast across Relay and CodeBuddy while keeping OpenAI's official `/v1/responses` WebSocket protocol as the default.

## Protocol Rules

- Official upstream URL is `wss://host/v1/responses` or `ws://host/v1/responses`.
- Existing upstream query strings such as `?ws=true` are compatibility flags and must be preserved, but the proxy must not append `ws=true` by default.
- Clients send `response.create` frames and receive Responses events.
- `stream` and `background` are transport fields and are not sent to upstream WS.
- Normal Responses fields such as `store`, `metadata`, `include`, `text`, `truncation`, and `user` are preserved.
- `previous_response_id` and `generate: false` are supported for incremental continuation and warmup.

## Modes

- `off`: do not use upstream Responses WS.
- `ctx_pool`: default. Use pooled upstream WS connections, keyed by upstream, auth, network settings, and conversation context.
- `passthrough`: legacy compatibility value. Normalize to `ctx_pool` so Relay Responses WS ingress still records conversation state.

Legacy mode names `shared`, `dedicated`, and `passthrough` normalize to `ctx_pool`.

## Implementation

- Add mode normalization in `src/services/shared/responses-ws-mode.js`.
- Fix upstream WS URL construction in `src/services/relay/api.js` so query strings survive and endpoint detection is safe.
- Tighten `prepareResponsesWebSocketPayload()` in `src/services/shared/responses-ws-client.js`.
- Keep Relay WS ingress on `ctx_pool` so state hydration and completion recording stay enabled.

## Testing

- Unit-test URL conversion with existing query strings and direct `/responses` base URLs.
- Unit-test mode normalization and legacy `passthrough` compatibility.
- Unit-test WS payload field preservation/removal.
- Run targeted tests and the full `npm test` suite.
