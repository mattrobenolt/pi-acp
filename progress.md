# Progress

## Status

Complete

## Tasks

- [x] TODO-99621caf: Bridge pi RPC extension_ui_request select/confirm to ACP requestPermission

## Files Changed

- `src/pi-rpc/process.ts`: ExtensionUiResponsePayload type + sendExtensionUiResponse()
- `src/acp/session.ts`: extension_ui_request handler, pendingUiRequests tracking, cancel() cleanup
- `test/extension-ui.test.ts`: 10 new tests with fakes

## Commit

dd7cbaa5cb332f3465d8f2d9a0ce6de91f031ee7 — "bridge pi extension_ui_request select/confirm to ACP requestPermission"

## Notes

- 96/96 tests pass (86 existing + 10 new)
- fmt, check (tsgo), lint all clean
- Wire format assumed: {requestId, ui: {type, title?, message?, options?, confirmText?, rejectText?}}
  Response: {type: "extension_ui_response", requestId, response: {cancelled, selectedId?/confirmed?}}
