# Flexit Roomie — Homey App

Local control of Flexit Roomie WiFi V2 ventilation fans on Homey Pro 2026. Speaks the Blauberg / EcoVent UDP protocol directly — no cloud, no Modbus, no radio.

Includes:

- **Roomie Fan** driver — pair each physical fan as its own Homey device. Auto-discovers fans on the local network. Speed, mode, humidity, RPM, filter alarm.
- **Balanced Ventilation System** driver — virtual orchestrator that controls two paired Roomie fans as one balanced system. Modes (Away / Normal / Boost / Kitchen / Summer circulate) with configurable speed and airflow strategy per mode. Auto-boost on humidity with hysteresis.

Verified against Vento Expert Duo A30-1 W V.2 (Roomie Dual rebrand), firmware 0.9 (2024-07-08).

## Install

This is a sideloaded private app — not published in the Homey Store.

```sh
homey app validate
homey app install
```

Homey CLI: <https://apps.developer.homey.app/the-basics/getting-started/cli>

## Architecture

```
.homeycompose/                  source of truth for app.json
  app.json
  capabilities/                 custom capabilities (airflow mode, speed level, system mode, RPM, filter days, filter alarm)
  flow/{triggers,conditions,actions}/

drivers/
  roomie/                       one Homey device per physical fan
    driver.compose.json
    driver.js                   pair flow with UDP discovery + PIN verify
    device.js                   poll + capability listeners
    pair/                       custom HTML pair views (discover, pin)

  ventilation-system/           virtual orchestrator
    driver.compose.json
    driver.js                   pair: preflight check (needs 2 paired roomies)
    device.js                   _setMode (airflow strategy + speed), auto-boost on humidity
    pair/intro.html             explains what the system device does

lib/
  roomie-protocol.js            RoomieClient: discover, verify, readState, writes
```

## Protocol

Blauberg / EcoVent UDP, port 4000. Packet layout:

```
FDFD <type=02> <id_size> <id ASCII> <pwd_size> <pwd ASCII> <func> <params...> <chksum LE16>
```

Functions: `01 read`, `02 write`, `03 write_return`, `06 resp`, `07 = rejected (wrong PIN/ID)`.

Discovery uses `ID=DEFAULT_DEVICEID + PWD=1111 + read(0x7c)` — returns the device's real ID and unit type regardless of the configured PIN.

See `phase-0-findings.md` for the full protocol mapping and verified parameters.

## Files

- `flexit-roomie-homey-app-spec.md` — original protocol spec
- `roadmap.md` — phased development plan
- `phase-0-findings.md` — protocol verification results
- `test.js` — standalone UDP test CLI (requires `ROOMIE_PWD` env var)

## License

MIT
