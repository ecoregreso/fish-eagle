# Fish Eagle WS Bridge

This service is the foundation for a custom WebSocket server for Fish Eagle Fight.

## Why this exists
The client uses a proprietary binary WebSocket protocol. To integrate Playtime wallet/bets, we need to:
1. Capture/understand that protocol.
2. Implement a compatible server.
3. Bridge bets/settles to Playtime APIs.

This service ships in **proxy mode** first (stable + secure), logging frames so we can reverse-engineer the protocol without breaking gameplay.

## Quick start (local)
```bash
cd services/fish-eagle-ws
npm install
npm start
```

Default:
- Port: `8787`
- Mode: `proxy`
- Upstream: `wss://webstoreusa.net/fish-eagle-fight-api/eagle-strike/connection`

## Use it from the game
Pass a `ws` query param to the wrapper:
```
.../games/fish-eagle-fight/fish-eagle-fight-wrapper.html?ws=ws://localhost:8787
```

## Environment variables
- `PORT`: server port (default `8787`)
- `MODE`: `proxy` or `local` (default `proxy`)
- `UPSTREAM_WS`: vendor WS URL when proxying
- `UPSTREAM_ORIGIN`: optional Origin header to send upstream
- `LOG_DIR`: path to write JSONL logs (disabled if empty)
- `LOG_LIMIT_BYTES`: cap total log size per connection

## Roadmap
- Phase 1: proxy + log frames (current)
- Phase 2: decode protocol and implement server responses
- Phase 3: integrate Playtime bet/settle and wallet sync
