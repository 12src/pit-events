## General

Requires Linux with systemd, Node.js 22+, and a Cloudflare account. The Minecraft account must have Pit Supporter permission.

```sh
git clone https://github.com/12src/pit-events.git pit-events
cd pit-events
npm ci
npm run deploy
```

To collect once manually:

```sh
npm start
```

## REST

| Method | Path | Authentication | Result |
| --- | --- | --- | --- |
| GET | `/` | None | Upcoming events, `200 OK` |
| GET | `/history` | None | Past events, `200 OK`; `400` on a bad query |
| PUT | `/` | `Authorization: Bearer <UPLOAD_KEY>` | `204 No Content`; `400` on a bad body; `401` on a bad key; `413` over 256 KiB; `503` if no key is configured |

`/` returns events with `time >= now`. `/history` returns events with `time < now` and accepts these query parameters.

| Parameter | Type | Description |
| --- | --- | --- |
| `from` | string | Earliest `time`, ISO 8601 |
| `to` | string | Latest `time`, ISO 8601 |
| `name` | string | Event name |
| `type` | string | `major` or `minor` |
| `limit` | integer | Rows to return, default 1000, max 10000 |
| `offset` | integer | Rows to skip, default 0 |

The PUT body is a JSON array of events.

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Event name, one of the values below |
| `type` | string | `major` or `minor` |
| `time` | string | Event menu time, ISO 8601 UTC with minute precision |

| `name` | `type` |
| --- | --- |
| 2x Rewards | minor |
| All bounty | minor |
| Auction | minor |
| Beast | major |
| Blockhead | major |
| Care Package | minor |
| Dragon Egg | minor |
| Giant Cake | minor |
| KOTH | minor |
| KOTL | minor |
| Pizza | major |
| Quick Maths | minor |
| Raffle | major |
| Rage Pit | major |
| Robbery | major |
| Spire | major |
| Squads | major |
| Team Deathmatch | major |
