# Flexit Roomie — Homey-app · teknisk spec

Mål: en egenbygd Homey SDK3-app (`homey app install` på din egen Homey Pro 2026) som styrer to Flexit Roomie WiFi V2-vifter lokalt over IP. Ingen sky, ingen Modbus, ingen radio — ren lokal UDP.

## Nøkkelinnsikt (det som gjør dette overkommelig)

Flexit Roomie er en **rebrandet Blauberg VENTO**-vifte. Roomie Dual/One WiFi V2 har en ESP-wroom-02-brikke og styres via Blaubergs **lokale UDP-protokoll** — samme protokoll som Blauberg VENTO Expert-serien. Det betyr:

- Protokollen er allerede reversert og dokumentert (Blauberg VENTO smart house-spec)
- Det finnes fungerende referansekode: `aglehmann/home_assistant_ecovent` (Python) + `ecovent_v2`-biblioteket
- Roomie-appen kobler kun på lokal IP, uten passord — bekreftet av flere brukere

Du porterer altså en kjent protokoll til en Homey-driver, ikke reverserer fra null.

## Referansekilder (les disse i Claude Code først)

| Kilde | Hva |
|---|---|
| `aglehmann/home_assistant_ecovent` (GitHub) | HA custom component, on/off + fan speed bekreftet mot Roomie Dual WiFi |
| `ecovent_v2` Python-lib (PyPI/GitHub) | Nyere protokoll-implementasjon, mer komplett |
| Blauberg "VENTO Expert Duo A30-1 W smart house" PDF | Offisiell protokoll-dokumentasjon (pakkeformat, parametere) |
| Homey Apps SDK — `Homey.Device`, `dgram` UDP | Homey-API for nettverk |

## Protokoll-oppsummering (Blauberg/EcoVent UDP)

Verifiser disse mot referansekoden ved implementasjon — ikke stol blindt på spec:

- **Transport:** UDP, default port **4000**
- **Pakke-header:** `0xFD 0xFD` (start)
- **Protokoll-type:** `0x02`
- **Device ID:** 16-byte ID-streng (ofte enhetens ID / "DEFAULT_DEVICEID" eller serienummer)
- **Passord:** lengde-prefikset ASCII, default ofte tomt / "1111"
- **Funksjoner:** read (`0x01`), write (`0x03`), read+write (`0x05`), inkrement/dekrement
- **Parametere (eksempler — bekreft mot lib):**
  - Power on/off
  - Fan speed (manuell hastighet, ofte 0–3 eller prosent)
  - Operation mode (manual / auto / kjøkkenhette-boost)
  - Boost on/off
  - Lese: temperatur, fuktighet, filter-status, RPM
- **Sjekksum:** 16-bit, ende av pakke

Roomie V2 kan kjøre Master/Slave-par. Hver enhet har egen IP — i din app behandles de som **to separate enheter** (du har to Roomie v2).

## App-arkitektur (Homey SDK3)

```
com.<ditt-navn>.flexit-roomie/
├── app.json (.homeycompose/)
│   ├── sdk: 3
│   ├── compatibility: ">=12.0.0"
│   └── permissions: [] (lokal nett, ingen spesiell)
├── package.json
│   └── deps: kun Node stdlib (dgram) hvis mulig — unngå tunge avhengigheter
├── app.js
└── drivers/
    └── roomie/
        ├── driver.compose.json
        │   ├── class: "fan"
        │   ├── capabilities: ["onoff", "fan_speed", "measure_temperature", "measure_humidity", "alarm_filter?"]
        │   └── pair: IP-input (manuell) ELLER UDP-discovery
        ├── driver.js   (paring: la bruker skrive inn IP, evt. broadcast-discovery)
        └── device.js   (poll + send-kommandoer via UDP)
```

### Capabilities-mapping
- `onoff` → power on/off-parameter
- `fan_speed` (eller `dim` 0–1, eventuelt custom enum) → fan speed-parameter
- `measure_temperature` → lest temp (hvis enheten rapporterer)
- `measure_humidity` → lest fuktighet
- `alarm_filter` (custom capability) → filter-status, valgfritt v1

### Paring
- **v1 (enklest):** manuell — bruker skriver inn lokal IP for hver Roomie. Du vet IP-ene fra UCG-en din. Statisk DHCP-reservasjon anbefales.
- **v2 (senere):** UDP-broadcast discovery på port 4000 for å finne enheter automatisk.

### device.js — kjernelogikk
1. `onInit`: les IP + device-ID fra settings, start poll-intervall (f.eks. hvert 10–30 sek)
2. `poll()`: send read-pakke over UDP, parse svar, oppdater capabilities
3. `registerCapabilityListener('onoff', ...)`: bygg write-pakke, send UDP
4. `registerCapabilityListener('fan_speed', ...)`: skaler Homey 0–1 → enhetens hastighetsverdi, send write
5. Håndter timeout/ingen svar → marker `setUnavailable`, retry

## Utviklingssteg (i Claude Code)

```bash
# 1. Opprett nytt repo / homey app create, eller klon en mal
homey app create        # velg "fan"-template som utgangspunkt

# 2. Hent referanseprotokollen
#    - les aglehmann/home_assistant_ecovent og ecovent_v2 for pakkeformat
#    - oversett Python-pakkebygging til Node Buffer + dgram

# 3. Bygg UDP-laget først som frittstående test
#    - en liten test.js som sender read-pakke til Roomie-IP og logger svar
#    - VERIFISER at du får svar fra din faktiske vifte før du bygger driveren

# 4. Bygg driver + device rundt det fungerende UDP-laget

# 5. Valider + installer
homey app validate
homey app install
```

## Kritisk: test UDP-laget isolert FØRST

Ikke bygg hele driveren før du har bevist at du får svar fra viftene. Lag en throwaway `test.js`:

```js
const dgram = require('dgram');
const client = dgram.createsocket('udp4');
// bygg read-pakke iht. Blauberg-spec, send til <roomie-ip>:4000
// logg rå respons som hex → sammenlign mot ecovent_v2 sin parsing
```

Får du hex-svar tilbake fra dine to Roomie v2 → protokollen stemmer, og resten er mekanisk. Får du ingenting → sjekk port, device-ID-feltet, og om Roomie-appen må være lukket (noen enheter tar én forbindelse om gangen).

## Forventede fallgruver

- **Device-ID-feltet:** Blauberg-pakker har et 16-byte device-ID. Noen enheter godtar en default/wildcard, andre krever enhetens faktiske ID. Hvis read feiler, prøv å hente ID fra Roomie-appen eller via en discovery-broadcast.
- **Beep ved hver kommando:** kjent på disse viftene — enheten piper når den får kommando. Ikke en bug i appen.
- **Master/Slave:** hvis dine to er paret som Master/Slave, snakk med Master-IP; Slave speiler. Hvis de er uavhengige, to separate enheter i Homey.
- **Polling vs. push:** enheten pusher ikke — du må polle. Hold intervallet moderat (10–30 s) for å unngå unødig trafikk og beep.

## Omfang v1 (hold det lite)

Lever dette først, så utvider du:
- [ ] To enheter parbare via manuell IP
- [ ] on/off
- [ ] fan speed
- [ ] les temperatur + fuktighet
- [ ] robust timeout-håndtering

Senere: filter-alarm, boost-modus, auto/manual-bytte, UDP-discovery, flow-kort.

## Notat
Privat app via `homey app install` — ikke publisert i storen, ingen sertifisering. Lever på din Homey så lenge du ikke avinstallerer. Samme modell som Swiid-porten du nettopp fikk til.
