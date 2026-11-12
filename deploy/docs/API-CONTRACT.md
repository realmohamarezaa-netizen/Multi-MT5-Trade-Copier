# REST API Contract (v1)

The Next.js reference dashboard (this repo, `src/app/api/**`) and the Windows
Python engine (`deploy/worker/copier_engine.py`) implement the SAME contract,
so the exported dashboard works against both without changes.

All endpoints return JSON. Errors: `{ "error": string }` with HTTP 4xx/5xx.
All timestamps are epoch milliseconds (numbers).

## Read endpoints

| Endpoint | Description |
|---|---|
| `GET /api/state` | Full dashboard snapshot: `SnapshotDTO` (stats, terminals, masterRelations, latency) |
| `GET /api/positions?terminalId=&kind=position\|pending&symbol=&side=` | Open positions / pending orders |
| `GET /api/closed?terminalId=&symbol=&reason=&q=&from=&to=&limit=` | Closed trades history |
| `GET /api/logs?level=&category=&terminalId=&q=&limit=` | Structured logs (newest first) |
| `GET /api/copies?masterTicket=&limit=` | Copy-operation ledger (idempotency + latency per copy) |
| `GET /api/metrics` | Latency aggregates (current/avg/min/max, success/fail/missed/reconnects, per-slave) |
| `GET /api/settings` | Global app settings |
| `GET /api/tests` | Acceptance test runs + latest results (Windows engine returns empty list) |
| `GET /api/logs/export?format=csv` | CSV download (Next.js reference implementation) |

## Write endpoints

| Endpoint | Body | Description |
|---|---|---|
| `POST /api/terminals` | `{name, broker?, server?, exePath?}` | Register terminal |
| `PATCH /api/terminals/{id}` | `{action, value?}` where action ∈ `connect, disconnect, setRole, enable, disable, pause, resume, autoReconnect` | Terminal management |
| `DELETE /api/terminals/{id}` | - | Remove terminal |
| `PUT /api/terminals/{id}/settings` | partial `SlaveSettingsDTO` | Per-slave copy settings |
| `POST /api/engine` | `{action}` ∈ `start_copying, stop_copying, emergency_stop, restart` | Engine controls |
| `PUT /api/settings` | partial `AppSettingsDTO` | Global settings (emergencyPolicy, syncOnStart, ...) |
| `POST /api/sync` | `{slaveId, action: open_missing\|close_extra}` | Manual reconciliation actions |
| `POST /api/sim` | `{action, params}` | Simulator controls (Next.js sandbox only; Windows engine returns 409) |
| `POST /api/tests/run` | - | Start acceptance suite (sandbox only) |

## DTO shapes

Defined once in `src/lib/types.ts` (TypeScript) - the Python engine produces
the identical JSON key names (camelCase). Key types: `SnapshotDTO`,
`TerminalDTO`, `SlaveSettingsDTO`, `PositionDTO`, `ClosedTradeDTO`,
`CopyOperationDTO`, `MasterTradeRelationDTO`, `LatencyStatsDTO`,
`EngineStatsDTO`, `AppSettingsDTO`.

## Status vocabularies

- Terminal status: `connected | connecting | disconnected | reconnecting | error`
- Terminal role: `master | slave | none`
- Copy op status: `pending | sent | executed | failed | skipped | missed`
- Lot modes: `same | fixed | multiplier | balance | risk`
- Sync policies: `report | autoOpenMissing | autoCloseExtra`
- Emergency policies: `halt | halt_close_master | halt_close_all`
