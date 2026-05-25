# Flexit Roomie — utviklings-roadmap

Fasedelt roadmap for egenbygd Homey SDK3-app som styrer to Flexit Roomie WiFi V2-vifter og **orkestrerer dem som ett balansert ventilasjonssystem** gjennom Homey. Mat inn én fase om gangen i Claude Code. Hver fase har mål, leveranse, oppgaver, akseptansetest og risiko.

Les `flexit-roomie-homey-app-spec.md` først — den dekker protokoll og app-arkitektur. Dette roadmapet bygger oppå den og legger til balanse-orkestreringen.

---

## Konseptet: hva «balansert ventilasjon» betyr her

Roomie er reverserende enkeltromsvifter med keramisk varmeveksler. Én enhet alene veksler retning hvert ~70 sek: blåser ut (varmer opp kjernen) → suger inn (kjernen forvarmer inntaksluft). To enheter skaper *balansert* ventilasjon ved å kjøre i **motfase**:

```
Tid →     0–70s        70–140s       140–210s
Vifte A:  EXTRACT  →   SUPPLY    →   EXTRACT
Vifte B:  SUPPLY   →   EXTRACT   →   SUPPLY
          ↑ huset holder nøytralt trykk: like mye inn som ut til enhver tid
```

Mål for appen: Homey holder de to viftene i motfase, med matchet luftmengde, slik at tilluft ≈ avtrekk = balansert trykk + kontinuerlig varmegjenvinning. I tillegg: felles modusbytter og prosentterskler.

**Den harde nøtten (må avklares tidlig):** kan motfase-timingen styres via Homey, eller sitter den i enhetenes native Master/Slave-link? Fase 0 og 3 har egne verifiseringspunkter for nettopp dette.

---

## Fase 0 — Protokoll-bevis (forutsetning)

**Mål:** bevis at du kan lese og skrive til ÉN Roomie over UDP fra Node.

**Oppgaver:**
- Les `aglehmann/home_assistant_ecovent` + `ecovent_v2` for pakkeformat
- Skriv throwaway `test.js`: send read-pakke til Roomie-IP:4000, logg hex-svar
- Verifiser write: skru vifta on/off fra scriptet
- **Kartlegg motfase:** undersøk om protokollen eksponerer retning/fase eller en «reverse interval»-parameter. Logg hva enheten rapporterer om sin egen syklus.

**Akseptanse:** du får hex-svar fra begge viftene, og kan slå dem av/på fra `test.js`.

**Risiko:** device-ID-felt kan kreve enhetens faktiske ID; Roomie-appen må kanskje være lukket (én forbindelse om gangen).

---

## Fase 1 — Enkelt-enhet driver

**Mål:** én Roomie som fullverdig Homey-enhet.

**Leveranse:** `drivers/roomie/` med device.js + driver.js.

**Oppgaver:**
- Manuell IP-paring (statisk DHCP-reservasjon i UCG anbefales)
- Capabilities: `onoff`, `fan_speed`, `measure_temperature`, `measure_humidity`
- Poll hvert 15–30 s; oppdater capabilities
- Capability-listeners → bygg write-pakker
- Timeout → `setUnavailable` + retry

**Akseptanse:** én vifte styres fullt fra Homey-appen, verdier oppdateres.

---

## Fase 2 — To uavhengige enheter

**Mål:** begge viftene inn som separate enheter, hver styrbar for seg.

**Oppgaver:**
- Par inn begge (to IP-er)
- Bekreft at samtidig polling av begge ikke gir kollisjon/beep-storm
- Lagre per-enhet `role` i settings: `A` / `B` (hvem som starter i EXTRACT vs SUPPLY)

**Akseptanse:** begge viftene styres uavhengig, stabilt, samtidig.

---

## Fase 3 — Balanse-orkestrering (kjernen)

**Mål:** Homey behandler de to viftene som ÉTT balansert system i motfase.

**Arkitektur — velg én:**
- **A (anbefalt): virtuell «system»-enhet.** En egen driver `ventilation-system` som er en logisk enhet. Brukeren styrer *den* (ett nivå 0–100 %), og orkestratoren regner ut per-vifte-kommandoer. De to fysiske viftene kan skjules/grupperes under den.
- **B: app-nivå controller** som lytter på begge device-instanser og koordinerer. Mindre ryddig i UI.

**Orkestreringslogikk:**
1. **Motfase-styring.** Sett vifte A og B i motsatt startfase. Avklar fra Fase 0:
   - Hvis protokollen lar deg sette fase/retning → Homey dytter A og B i motsatt fase ved start og etter hver modusendring.
   - Hvis fase-timingen er intern (~70 s) og *ikke* eksponert → da kan ikke Homey garantere presis motfase over tid (polling er for grovkornet til 70 s-presisjon). Fallback: dokumentér at native Master/Slave-link beholdes for selve reverseringen, mens Homey styrer makronivå (hastighet/modus/på-av). **Dette er det viktigste designvalget — verifiser før du bygger videre.**
2. **Matchet luftmengde.** Tilluft ≈ avtrekk: begge viftene kjører samme hastighetsnivå som default. Valgfri `imbalance_offset` (±%) hvis huset har trykkbias (f.eks. én pipe/avtrekkshette som trekker).
3. **Felles nivå.** System-nivå 0–100 % → mappes til hastighet på begge.

**Akseptanse:** sett ett nivå på system-enheten → begge vifter justeres balansert; motfase opprettholdes (verifisert ved å lytte/føle inn- vs utluft, eller via rapportert retning).

**Risiko:** motfase-presisjon (se punkt 1). Vær ærlig i implementasjonen om hva Homey faktisk garanterer vs. hva som forblir på enheten.

---

## Fase 4 — Modus & prosentterskler

**Mål:** intelligente moduser med terskler og hysterese.

**Modusmodell (eksempel — tilpass):**

| Modus | Trigger | Begge vifter |
|---|---|---|
| Borte/trickle | manuelt / fravær | lav, f.eks. 20 % |
| Normal | default | f.eks. 50 % |
| Boost | fukt > terskel, eller manuelt | f.eks. 90 %, tidsbegrenset |
| Kjøkken/forsering | manuelt | maks, midlertidig ubalanse tillatt |

**Terskler med hysterese (unngå flapring):**
- Fukt-trigget boost: PÅ ved > 65 % RH, AV ved < 55 % RH (eksempelverdier — juster)
- Hastighetsbånd med dødsone så de ikke pendler rundt en grenseverdi
- Min. tid i modus før nytt bytte (f.eks. 5 min) for å unngå konstant beep + slitasje

**Balanse under modusbytte:** når én trigges (f.eks. fukt på A's rom), løft *begge* for å holde balanse — ikke bare den ene — med mindre du bevisst vil ha lokal forsering.

**Akseptanse:** fukt over terskel løfter begge balansert; faller tilbake med hysterese; ingen flapring.

---

## Fase 5 — Polish

**Mål:** produksjonsklart for eget bruk.

**Oppgaver:**
- Flow-kort: triggere (modus endret, filter-alarm), conditions (er i boost?), actions (sett nivå/modus)
- `alarm_filter` capability (filter-status)
- UDP-broadcast discovery (slipp manuell IP)
- Robusthet: gjenoppkobling, logging, «en vifte nede»-håndtering (hold balanse ved å droppe den andre til matchende lav, eller varsle)
- Valgfritt: eksponer rå retning/RPM/temp for Insights-grafer

**Akseptanse:** overlever omstart, nettverksglitch og at én vifte forsvinner, uten manuell inngripen.

---

## Anbefalt rekkefølge å mate inn

```
Fase 0  → bevis protokoll + KARTLEGG om fase/retning er styrbar   ← avgjør Fase 3
Fase 1  → én enhet, full styring
Fase 2  → to enheter uavhengig
Fase 3  → balanse-orkestrering (system-enhet, motfase, matchet mengde)
Fase 4  → moduser + terskler + hysterese
Fase 5  → flows, discovery, robusthet
```

Stopp etter hver fase, test mot de faktiske viftene, så neste. Ikke bygg Fase 3-orkestreringen før Fase 0 har svart på om motfase er styrbar — det valget former hele arkitekturen.

## Det ene spørsmålet som styrer alt

**Er motfase-timingen (reversering hvert ~70 s) eksponert i protokollen, eller intern i enheten?**
- Eksponert → Homey kan være full orkestrator, og du trenger ikke native Master/Slave-link.
- Intern → behold native link for reverseringen, la Homey styre makronivå (hastighet/modus/på-av/terskler).

Få svar på dette i Fase 0. Alt annet henger på det.
