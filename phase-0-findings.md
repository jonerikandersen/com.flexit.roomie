# Fase 0 — funn

Status: **Bestått.** Protokollen er bevist mot begge faktiske enheter — full read og write fungerer.

## Enhets-info

| | tvstue | kjokken |
|---|---|---|
| IP | 10.0.20.157 | 10.0.20.219 |
| Device ID | `002100384B46570C` | `001B00244B46570C` |
| Unit type | Vento Expert Duo A30-1 W V.2 (`0x0400`) | samme |
| Firmware | 0.9, 2024-07-08 | samme |
| Speed (nå) | low (1) | low (1) |
| State (nå) | on | on |
| **Airflow-modus** | **ventilation (0)** | **heat_recovery (1)** |
| Fan1 RPM | 1200 | 1200 |
| Fan2 RPM | 1320 | 1320 |
| Humidity | 45 % | 39 % |
| Humidity threshold | 70 % | 70 % |
| Humidity sensor aktiv | off | off |
| Machine hours | 12d 10h | 12d 10h |
| Filter timer countdown | ~77 dager | ~77 dager |
| Cloud server | on | on |
| RTC dato | 2017-09-24 *(aldri satt)* | 2017-09-24 *(aldri satt)* |

PIN er **lik for begge** og leses fra `ROOMIE_PWD` env-var. Aldri commitet.

## Protokoll-fakta som er bekreftet i kode

- **Transport:** UDP, port 4000
- **Pakkeformat:** `FDFD <type=02> <id_size> <id ASCII> <pwd_size> <pwd ASCII> <func> <params...> <chksum LE16>`
- **Funksjoner:** `01 read`, `02 write`, `03 write_return`, `04 inc`, `05 dec`, `06 resp`, `07 = avvist (feil PIN/ID)`
- **Discovery:** `ID=DEFAULT_DEVICEID + PWD=1111 + read(0x7c)` returnerer enhetens faktiske ID + unit_type, uavhengig av hva enhetens reelle PIN er
- **Full read av alle 42 params i én pakke fungerer** — krever ekte ID + ekte PIN
- **Write returnerer ekko av nye verdi** i `func=0x06`-respons → enkelt å verifisere

## Det ene spørsmålet — besvart

> Er motfase-timingen (reversering hvert ~70 s) eksponert i protokollen, eller intern i enheten?

**Intern.** Protokollen eksponerer:
- `airflow`-modus (ventilation / heat_recovery / air_supply) — overordnet driftsmodus
- `fan1_rpm` og `fan2_rpm` — ren telemetri
- Ingen fase-, retnings- eller intervall-parameter

70-sekunders reverseringen i `heat_recovery`-modus styres internt av enheten. Homey kan ikke pushe A og B i motfase med presisjon — UDP-polling er for grovkornet.

**Konsekvens for Fase 3:** følg fallback-løypa i roadmapet — Homey styrer makronivå (hastighet, airflow-modus, på/av, terskler), enhetene håndterer egen syklus.

## Pluss et arkitektur-funn som endrer Fase 3-konseptet

Begge enheter er **Vento Expert Duo A30-1 W V.2** — Duo-modeller med **to impellere i samme boks**. Hver enhet er internt balansert (én impeller suger, én blåser, samtidig). Den "balanserte ventilasjonen" i roadmapet handler IKKE om motfase mellom de to enhetene, men om:

1. **Per enhet:** intern balanse løses av enheten selv (innebygd Duo-design + heat_recovery-modus)
2. **Mellom enhetene:** matchet luftmengde — begge på samme `speed`-nivå, evt. felles `airflow`-modus

Phase 3 «virtuell system-enhet» gir mening fortsatt, men logikken forenkles: ingen 70 s-timing å bekymre seg for, bare match speed % og koordiner modusbytter.

## Diverse observasjoner

- `cloud_server_state = on` på begge — vi kan slå denne av for ren lokal drift når Homey-driveren er klar
- `humidity_sensor_state = off` — fukt-trigget boost er deaktivert i enhetenes egen logikk. For Fase 4 (modus & terskler) kan vi velge: la enhetene trigge selv (slå på `humidity_sensor_state`) eller la Homey lese fukt og trigge sentralt
- RTC er aldri satt (2017-09-24). Mulig å synke fra Homey i Fase 5 om vi orker
- `man_speed = 9/255 (~4 %)` — manuell speed-verdi som brukes når `speed = 0xff (manual)`. Currently i navngitt low-modus så ikke aktiv

## Capabilities-mapping (oppdatert basert på faktiske params)

| Homey capability | Roomie param | Notater |
|---|---|---|
| `onoff` | `0x0001 state` | 0=off, 1=on |
| `fan_speed` (0..1) | `0x0044 man_speed` (0–255) + `0x0002 speed = 0xff manual` | må sette begge — speed til manual, så man_speed til verdi |
| eller `dim` (0..3) | `0x0002 speed` direkte (1=low, 2=medium, 3=high) | enklere men grov |
| `measure_humidity` | `0x0025 humidity_pct` | 0–100 % |
| `measure_temperature` | *ingen direkte param* | Roomie Duo har ingen temp-sensor på protokollen (luft-temp finnes ikke i `params`-tabellen) |
| `alarm_filter` | `0x0088 filter_replacement_status` | 0=ok, 1=replace |
| custom enum `airflow_mode` | `0x00b7 airflow` | ventilation/heat_recovery/air_supply |

**NB:** ingen temperatur-param i protokoll-spec'en. Roadmapet listet `measure_temperature` som v1-capability — droppes, eller markeres som «ikke tilgjengelig fra enheten».

## Klar for Fase 1

Vi har:
- Fungerende UDP-protokoll-lag i `test.js` (kan løftes til en `lib/`-modul i Fase 1)
- Bekreftet alle device-IDer
- Bekreftet write-mekanikk
- Klart svar på roadmapets nøkkelspørsmål
