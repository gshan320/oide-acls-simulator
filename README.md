# OIDE ACLS Simulator

High-fidelity advanced cardiac life support training simulator. Real-time ECG
synthesis, adaptive artefact cancellation, and FFT analysis run in a Web Worker;
sessions, interventions, and 1 Hz AMSA telemetry persist to Firestore.

Internal research environment: Firestore runs in Test Mode without security
rules by design.

> Training use only. Not a medical device and not for clinical decision-making.

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in your Firebase values
npm run dev
```

Open http://localhost:3000.

`/monitor` with no `?sim=` runs the full dual-arm workspace against a local
fixture with persistence disabled, so every route works before you have a
Firebase project set up.

## Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript, strict |
| Styling | Tailwind CSS v4 (CSS-first `@theme` config in `src/app/globals.css`) |
| Icons | lucide-react |
| Charts | chart.js + react-chartjs-2 |
| Persistence | Firebase / Firestore |
| Signal math | fft.js in a dedicated Web Worker |
| Class utilities | clsx + tailwind-merge (`cn()` in `src/lib/utils.ts`) |

## Layout

```
src/
  app/                  Routes: / · /scenario · /monitor · /debrief
  components/
    ui/                 Glassmorphism + monitor primitives (GlassPanel, VitalReadout, AlertBanner)
    simulator/          PatientForm · AutomatedDualSimulator
                        WaveformCanvas · AmsaGauge · OutcomeAnalysis
  lib/
    firebase/           client.ts · config.ts · firestore.ts (single source of truth)
    oide/               kkmAclsRules.ts  KKM decision matrices → timed sequence
                        decisionEngine.ts  E_opt from AMSA and TTI
                        aclsEngine.ts      simulation, playback, export
                        outcome.ts         injury index (+ test suites throughout)
    exportFile.ts       downloadJson(), sessionExportFilename()
    utils.ts            cn(), formatElapsed()
  workers/
    ecg.worker.ts       3-channel waveform synthesis + FFT/AMSA analysis
    useEcgWorker.ts     React hook owning the worker and one ring buffer per channel
  types/                patient · signal · session
```

## Design tokens

Defined once in `src/app/globals.css` under `@theme`; Tailwind v4 needs no
`tailwind.config.ts`.

| Token | Value | Use |
|---|---|---|
| `monitor-void` | `#0A0D12` | Page background |
| `trace-ecg` | `#00FFAA` | ECG trace, nominal vitals |
| `trace-spo2` / `signal-blue` | `#00E5FF` | Pleth trace, interactive accents |
| `trace-resp` | `#FFD60A` | Capnography |
| `trace-abp` | `#FF2D78` | Arterial pressure |
| `alert-advisory` → `alert-arrest` | `#FFB020` → `#FF0040` | Escalating alarms |

Utility classes: `.glass-panel`, `.monitor-grid`, `.tabular`. Shadows:
`shadow-glow-ecg`, `shadow-glow-blue`, `shadow-glow-alert`. Animations:
`animate-alarm-pulse`, `animate-sweep`, `animate-flatline` (all suppressed under
`prefers-reduced-motion`).

## Architecture notes

**Signal path.** `ecg.worker.ts` synthesises three independent channels at 500 Hz
and posts 40 ms chunks as transferred `Float32Array`s — one per channel, all
advancing on a shared sample clock. `useEcgWorker` writes them into three fixed
ring buffers that are never reallocated; each `WaveformCanvas` reads its own
buffer inside `requestAnimationFrame`. **No sample ever passes through React
state.** Every 1024 samples (50% overlap) the worker runs an FFT on the ECG
channel and reports dominant frequency and AMSA over 2–48 Hz, plus a `metrics`
message carrying the live EtCO₂ plateau.

**Channels are coupled only by perfusion.** `PerfusionState` (`arrest` | `cpr` |
`rosc`) is derived from the rhythm and whether compressions are running, and it
is what makes the traces diverge — mirroring the real physiology, where cardiac
output drives both the pulse and CO₂ delivery to the lungs.

| | ECG (mV, bipolar) | Pleth (0–1, unipolar) | EtCO₂ (mmHg, unipolar) |
|---|---|---|---|
| **arrest** | chaotic VF, waxing envelope | flat — no pulsatile flow | 7 mmHg baseline |
| **cpr** | VF + compression artefact & motion noise | blunt mechanical pulses at the compression rate, no dicrotic notch | 15–25 plateau, scaled by CPR quality |
| **rosc** | organised rhythm morphology | full pulse with dicrotic notch + respiratory sway | jumps to ~38 |

**Adaptive CPR-artefact cancellation.** The analysis path runs a 128-tap
normalised-LMS adaptive noise canceller before any spectral work. The primary
input is the acquired ECG; the reference is the compression motion, which
correlates with the artefact and not with the underlying rhythm. The filter
learns the motion→ECG transfer function and the *error* signal — what motion
cannot explain — is the cleaned ECG. On real equipment the reference comes from
the CPR puck's accelerometer; here the worker synthesises the same motion
profile it injects.

NLMS rather than plain LMS keeps the step size stable as compression depth
changes; a small leakage term stops the weights drifting along the null space of
a strictly periodic reference.

Measured on the VF scenario at 110/min:

| | AMSA | note |
|---|---|---|
| No compressions | 3.3 mV·Hz | ground truth for this VF |
| CPR, unfiltered | 5.6 mV·Hz | artefact inflates it ~70% |
| CPR, adaptively filtered | 3.4 mV·Hz | recovers ground truth; **−15.6 dB** broadband suppression |

Two honest limits. Compressions also raise the broadband noise floor, which is
uncorrelated with the reference and therefore uncancellable — that residue is
the 3.3→3.4 gap. And any genuine ECG component coherent with the compression
rate is indistinguishable from artefact and will be cancelled with it.

The spectral notch below now runs *after* cancellation and typically finds
~0.0 mV·Hz left to remove, which is itself confirmation the LMS did the work.

**CPR notch (residual).** Compressions default to **110/min**, mid-band for the
AHA/KKM 100–120 high-quality CPR target, and `compressionRate` phase-locks the
ECG artefact to the pleth pulses. That injects a periodic component at the
compression fundamental and its harmonics, which inflates AMSA and can capture
the dominant-frequency search, so `analyze()` notches the fundamental and second
harmonic (±0.35 Hz) out of the spectrum before computing either. At 110/min that
is **1.83 Hz and 3.67 Hz**, derived from `compressionRate` rather than hardcoded
so the notches track the whole guideline band.

The notch applies to the analysis path only — the displayed ECG trace stays
unfiltered, as a real defibrillator shows it, because the raw artefact is how a
clinician judges compression mechanics. `SpectrumResult` reports `amsa`,
`amsaRaw`, and `notchedHz` so the filter's effect is visible on the monitor.

Do not raise `CPR_NOTCH_HARMONICS` past 2 without re-measuring. Higher harmonics
(5.50, 7.33, 9.17, 11.0 Hz at 110/min) fall inside VF's own fibrillatory band:
at 6 harmonics the notch removes more artefact (1.1 vs 0.4 mV·Hz) but dominant
frequency collapses from 5.4 Hz to 2.4 Hz because the filter starts eating the
signal it exists to measure.

The EtCO₂ plateau is integrated across ticks with an asymmetric time constant
(0.8 s rising, 6 s falling), so ROSC presents as an abrupt step up while loss of
output washes out slowly. Measured ramp on a CPR→ROSC transition: 23 → 32 → 36 →
38 mmHg over ~3 s.

**OIDE Clinical Decision Engine.** Pure functions in `src/lib/oide/decisionEngine.ts`,
kept out of the worker so the recommendation logic can be exercised directly.
AMSA is taken from the adaptively filtered signal as Σ(frequency × amplitude)
over 2–48 Hz, then:

```
E_opt = Base_Energy (150 J) × (Patient_Impedance / 75 Ω) × AMSA_Scaling_Factor
```

`AMSA_Scaling_Factor` is a monotonically decreasing calibration — a
better-energised myocardium defibrillates at lower energy — anchored so the
shock-recommended band spans 110–140 J at nominal 75 Ω:

| AMSA (mV·Hz) | Scaling | Joules @ 75 Ω | Action |
|---|---|---|---|
| ≥ 15.5 | 0.933 → 0.733 | 140 → 110 | HIGH ROSC PROBABILITY — SHOCK RECOMMENDED |
| 6.5 – 15.5 | 1.000 → 0.933 | 150 → 140 | INTERMEDIATE ENERGY — PERFORM 2-MIN CPR TO BOOST PERFUSION |
| < 6.5 | 1.000 | 150 | LOW MYOCARDIAL ENERGY — DEFER SHOCK (RISK OF MYOCARDIAL INJURY) |

The factor bottoms out at AMSA 25; output is clamped to a 50–360 J deliverable
envelope.

**The three AMSA tiers are gated on rhythm.** AMSA only bears on the decision
when defibrillation is on the table, so non-shockable rhythms (including any
perfusing rhythm and PEA) return `non-shockable` / `shockAdvised: false`
regardless of AMSA. Without this gate the engine recommends defibrillating a
patient in sinus tachycardia with a pulse.

This is a custom OIDE calibration for training, not a published resuscitation
guideline, and not a medical device.

## KKM ACLS rules engine

`src/lib/oide/kkmAclsRules.ts` encodes the adult advanced life support decision
matrices of the KKM NCORT ALS manual **as data**, then expands them into an
exact timestamped intervention sequence for a given intake profile. It is the
one place doses, energies and intervals are written down; nothing downstream
hardcodes a milligram or a joule.

The presenting rhythm selects the algorithm:

| Family | Presentations | Energy | Key drugs |
|---|---|---|---|
| `cardiac-arrest` | Coarse VFib · Fine VFib · Pulseless VT | Unsynchronised, fixed 200 J biphasic | Adrenaline 1 mg q3–5 min · Amiodarone 300 mg after shock 3, 150 mg after shock 5 |
| `cardiac-arrest` | Torsades de Pointes | Unsynchronised, fixed 200 J — polymorphic VT has no consistent R wave to synchronise to | Magnesium sulphate 2 g at 01:00 · Adrenaline 1 mg q3–5 min · **amiodarone withheld** |
| `cardiac-arrest` | PEA · Asystole | None — no fibrillatory waveform to terminate | Adrenaline 1 mg as soon as access allows, then q3–5 min |
| `tachycardia` | Unstable Tachycardia, Narrow QRS | Synchronised, 50 → 100 → 150 → 200 J | Adenosine 6 mg then 12 mg rapid IV push |
| `tachycardia` | Unstable Tachycardia, Broad QRS | Synchronised, 100 → 150 → 200 → 200 J | Amiodarone 150 mg over 10 min, repeatable to 300 mg · Lignocaine 1–1.5 mg/kg |
| `bradycardia` | Symptomatic Bradycardia | None — transcutaneous pacing at 70/min | Atropine 0.5 mg q3–5 min to a 3 mg ceiling · Adrenaline 2–10 mcg/min or Dopamine 5–20 mcg/kg/min |

`generateKkmTimeline(params)` returns the plan: the matrix, the ordered
`KkmStep[]`, the circumstance modifiers in force, the drug-interval multiplier,
the CPR-yield multiplier, the shock gate, the impedance floor, and the guideline
checklist the assessment card renders. Weight-based orders (lignocaine mg/kg,
the lipid emulsion bolus) are resolved against the intake weight and capped at
their single-dose ceiling. Doses tied to a shock *number* rather than an instant
carry `afterShock`, so a run that converts early never receives a bolus that
followed a shock it never reached. Every step carries a `guidelineRef` such as
`kkm.tachy.broad.amiodarone`, which is persisted with the intervention.

**Torsades runs under the arrest algorithm, not the tachycardia one.** That is
what the codebase's own rhythm taxonomy already says: `SHOCKABLE_RHYTHMS`
contains torsades and `PERFUSING_RHYTHMS` does not, so the signal worker draws it
in the arrest perfusion regime — flat pleth, 7 mmHg EtCO₂. Filing it under
tachycardia-with-a-pulse would put a heart rate and a "rhythm converted" verdict
on a monitor showing no cardiac output. It carries a genuine fibrillatory
waveform, so AMSA is measurable and conversion resolves against it exactly as it
does for VF.

Two things make it its own branch rather than a relabelled VF: magnesium is the
specific treatment and is given at 01:00, ahead of the first adrenaline dose,
because it *is* the reversible cause rather than an adjunct; and amiodarone is
**withheld**, because the antiarrhythmic every other shockable rhythm gets would
prolong the QT interval that produced this rhythm. It is the one shockable arrest
in the engine where the standard antiarrhythmic is contraindicated. The broad-QRS
tachycardia checklist points at this presentation if the QRS turns out to be
polymorphic.

### ACLS special circumstances

Multi-select on the intake form, and each one layers its own KKM modification
onto **both** routes, so the energy comparison stays controlled. A pregnant
dialysis patient in a cold-water arrest is one patient, not three scenarios:
interval multipliers compose, the strictest shock gate wins, and the highest
impedance floor applies.

| Circumstance | Modification |
|---|---|
| Pregnancy (maternal arrest) | `[00:15] Manual Left Uterine Displacement (LUD) Applied`, then the perimortem caesarean decision point at 04:00. Relieving aortocaval compression raises compression yield ×1.15 |
| Severe hypothermia (< 30 °C) | Every drug interval **doubled**; shocks limited to **one** attempt until active rewarming reaches 30 °C at 10:00, after which delivery resumes |
| Hyperkalemia / severe renal failure | `[02:30] Calcium Chloride 1g IV Push + Sodium Bicarbonate 50mEq`, which buys back 1.2 mV·Hz of AMSA as membrane excitability returns |
| Toxicological overdose | Naloxone 2 mg IV at 01:00, then a weight-based Intralipid 20% bolus (1.5 mL/kg) at 03:00 |
| Morbid obesity (high TTI) | Transthoracic impedance **floored at 110 Ω** regardless of the slider — the case the impedance term exists for, because a fixed 200 J selection under-delivers through a deeper thorax |

A gated shock is not silently dropped: it is logged as a `shock-deferred`
advisory naming the instant delivery resumes, and counted in
`deferredShockCount`.

## Automated time-lapsed dual-arm workspace

`/monitor?sim={simId}` renders `AutomatedDualSimulator`. There are no protocol
controls: `aclsEngine.ts` runs the KKM plan for both arms up front as
deterministic timelines, and the workspace plays them back. The learner watches
one patient receive two energy strategies and reads the difference off the
telemetry.

### Intake & assessment gate

The resuscitation tabs stay locked until **"Assess Patient & Confirm ACLS
Protocol"** is pressed. `assessPatient()` reads the locked intake profile, routes
it to its KKM algorithm, and returns a clinical assessment: impedance correction,
AMSA after downtime decay, which AMSA band the case opens in, the energy each
route would select for delivery 1, relevant history, the special circumstances
in force, and the algorithm's own checklist.

Rhythm is scanned first, always. AMSA quantifies myocardial energy state, which
only bears on the decision when unsynchronised defibrillation is on the table at
all — so for PEA, asystole and every perfusing presentation the AMSA track stays
pinned at zero and `clinicalActionFor` returns `non-shockable`. For PEA and
asystole neither arm delivers energy and the comparison correctly reports a
zero-joule tie.

### The two routes

Both arms run the **identical** KKM sequence — same compressions, same drug
schedule, same special-circumstance modifications. They diverge on exactly one
variable, the energy (or pacing output) each delivery carries:

| Family | Traditional KKM | OIDE calibrated |
|---|---|---|
| Cardiac arrest | Fixed 200 J biphasic, every shock | `recommendEnergy(AMSA, TTI)` recomputed at each shock point |
| Tachycardia | The fixed ladder, escalating on each failure | `requirement × TTI/75 × 1.05` — sized to convert on the first attempt |
| Bradycardia | Fixed 80 mA start, dialled up 10 mA every 30 s until capture | `capture requirement × TTI/75 × 1.05` — sized to capture first attempt |

Everything downstream — myocardial stunning, the AMSA trajectory, when the
rhythm converts, cumulative injury — follows from that single difference.

### AMSA dynamics

Forward Euler at 1 Hz, which is also the sample rate of the returned track, so
the chart and the numbers the events carry come from the same integration rather
than a closed form that could drift away from it.

| Term | Value | Rationale |
|---|---|---|
| Rhythm baseline | coarse VF 15.5 · fine VF 9.0 · pVT 17.0 · torsades 16.5 mV·Hz | AMSA a freshly witnessed arrest presents with |
| Downtime decay | −0.45 mV·Hz per minute down | Arrest before anyone started compressions |
| CPR gain | +2.0 mV·Hz/min, decaying with τ = 12 min | Acidosis and falling coronary perfusion pressure; without the decay every case would eventually convert |
| Hands-off decay | −3.0 mV·Hz/min | Why the 4 s rhythm-check window is charged against each shock |
| Post-shock stun | −1.4 mV·Hz, plus 0.008 per excess joule | The accumulating cost of over-dosing |
| Adrenaline | +1.0 mV·Hz | Coronary perfusion pressure bump |
| Circumstance gains | calcium/bicarbonate +1.2 · antidote +0.8 mV·Hz | Restoring membrane excitability, reversing the toxidrome |
| Magnesium | +1.5 mV·Hz | Restoring homogeneous repolarisation in torsades |
| Ceiling | 25 mV·Hz | Where the energy curve bottoms out |

### Conversion

For an arrest,
`defibrillationEfficacy = myocardialReserve(AMSA) × energyAdequacy(delivered, optimal)`,
and the rhythm converts at **≥ 0.62**. Reserve is 0 at the 6.5 mV·Hz defer
threshold and saturates at 25.

For a *synchronised* shock there is no AMSA to read and nothing is energy-starved
— the myocardium has been perfusing right up to the moment of cardioversion — so
reserve is a fixed 0.92 and whether the attempt works turns on the energy alone:
`cardioversionEfficacy = 0.92 × energyAdequacy(delivered, requirement)`, resolved
against what the *thorax* requires rather than against either arm's selection, so
both arms are judged by the same physics.

Bradycardia has no conversion threshold at all: pacing captures the moment the
selected output reaches `paceCaptureRequirementMa(TTI)`. The traditional route
climbs to it 10 mA at a time and pays for the climb in seconds; the calibrated
route starts above it.

`energyAdequacy` is deliberately **asymmetric**. Under-dosing fails to
depolarise a critical mass of myocardium, so efficacy falls off quadratically
(`ratio²`). Over-dosing still defibrillates — it just injures the heart doing it
— so efficacy decays gently (`1 − 0.35 × excess ratio`) and never below 0.5.
The cost of over-dosing lands in the post-shock stun and the injury index
instead, which is where it belongs clinically.

The reference case — 65 y, 90 Ω, 4 min down, coarse VF — resolves to:

| | Shocks | Energy | MII | Pre-shock pause | ROSC | Survival |
|---|---|---|---|---|---|---|
| Traditional | 3 | 600 J | 67.0 | 12 000 ms | 06:14 | 33% |
| OIDE | 2 | 314 J | 0.0 | 8 000 ms | 04:09 | 50% |

Presenting instead as torsades, where magnesium plus the first CPR block lifts
AMSA enough for shock 1 to land and the only difference left is the energy:

| | Shocks | Energy | MII | ROSC | Survival |
|---|---|---|---|---|---|
| Traditional | 1 | 200 J | 24.0 | 02:04 | 52% |
| OIDE | 1 | 152 J | 0.0 | 02:04 | 56% |

At 14 minutes down the same rhythm separates hard — 6 shocks and 1200 J against
3 shocks and 484 J, ROSC at 12:29 against 06:14, survival 6% against 43%.

The same patient presenting instead with an unstable narrow-QRS tachycardia:

| | Shocks | Energy | MII | Converted | Survival |
|---|---|---|---|---|---|
| Traditional | 2 | 150 J | 31.0 | 01:45 | 87% |
| OIDE | 1 | 88 J | 0.0 | 00:45 | 93% |

…and with symptomatic bradycardia through a 120 Ω thorax, where the traditional
dial needs two escalations to reach the 96 mA this chest captures at:

| | Pacing output | Capture | Survival |
|---|---|---|---|
| Traditional | 80 → 90 → 100 mA | 06:00 | 87% |
| OIDE | 101 mA | 05:00 | 88% |

The OIDE arm's injury index is zero by construction: it delivers exactly the
optimum it is measured against.

**Survival likelihood.** For an arrest, 0.62 − 0.03 per minute to ROSC − 0.0015
per MII unit, clamped to [0.01, 0.95]; 0.01 without ROSC. A patient who never
lost their circulation starts from 0.94 and loses only 0.012 per minute of
sustained instability, falling to 0.40 if the rhythm is never brought under
control — dangerous, not immediately lethal.

### Time-lapse playback

20 simulated minutes compressed into 60 real seconds — **1 real second = 20
simulated seconds**. A `requestAnimationFrame` loop maps wall clock onto the
simulated clock, and `frameAt()` projects the timeline onto that instant; it is
pure and index-free, so the display can never desynchronise from the clock.
A run that converts early ends at its ROSC rather than padding to 20:00.

React state is published at 12 Hz rather than every frame: the waveforms are
drawn straight from the worker's ring buffers inside their own animation frame,
so React only has to keep the numeric readouts and the event feed current.

### Tab lock

Each route has its own **"Start Resuscitation Sequence (Time-Lapse)"** button,
and only one route can run at a time. `startSequence` refuses outright while
another arm is mid-run, so the gate does not depend on the button's disabled
state alone. While one is running the other tab is
disabled and badged **"Simulation in Progress…"** — switching mid-run would tear
the waveform away from the sequence driving it. **"Compare Both Routes"** stays
locked until both runs have completed, because comparing two arms at different
points in their timelines is exactly the confound the workspace exists to avoid.

### Live telemetry & event feed

Three continuous channels (ECG with a Raw / DSP-filtered toggle, pleth,
capnography) driven by the signal worker, reconfigured as the timeline changes
rhythm or compression state. The readout bar carries heart rate, live AMSA, the
route's energy (with the counterfactual — the traditional tab shows what OIDE
would have used), EtCO₂, and impedance, above the AMSA metabolic gauge.

Alongside them, a scrolling event log with simulated timestamps:

```
[00:00] CPR Initiated (110 CPM)
[00:15] Manual Left Uterine Displacement (LUD) Applied
[02:00] Rhythm Check: Coarse VFib
[02:04] Shock #1 Delivered: 200 J (Traditional) vs 162 J (OIDE calibrated)
[02:30] Calcium Chloride 1g IV Push + Sodium Bicarbonate 50mEq
[03:00] Adrenaline 1 mg IV/IO Push
[04:05] Rhythm Check: Coarse VFib
[04:09] Shock #2 Delivered: 200 J (Traditional) vs 153 J (OIDE calibrated)
```

Every event writes to `Interventions` tagged with the arm that produced it, and
AMSA timepoints stream to `AmsaLogs` every 5 simulated seconds — the track is
integrated at 1 Hz because the physics needs it, but two arms of 1200 documents
each is write volume the trajectory's shape does not require.

`/monitor` with no `?sim=` renders the same workspace against a local fixture
with persistence disabled — useful for inspecting the architecture without a
Firestore session. There is no separate bedside view and no manual protocol
controls anywhere in the app: every intervention originates in the rules engine.

**Charts.** Markers differ in shape as well as colour and every status is
repeated in text, never encoded in colour alone — the neon cyan/green pair has
weak separation under tritan-type colour vision when plotted adjacently.

## Firestore schema

```
Simulations/{simId}                      root session + final outcome
Simulations/{simId}/Interventions/{id}   learner actions, append-only
Simulations/{simId}/AmsaLogs/{id}        1 Hz decision-engine timepoints
```

`src/lib/firebase/firestore.ts` (Web SDK v10 modular):

| Function | Behaviour |
|---|---|
| `createSimulationSession(patientData)` | Creates `Simulations/{simId}`. Transactional, so a hand-entered reference id cannot silently overwrite an existing session. Returns the id. |
| `logSimulationAction(simId, payload)` | Appends to `Interventions` with a `serverTimestamp()`. |
| `logAmsaTimepoint(simId, payload)` | Buffers, then flushes as one `writeBatch`. |
| `saveFinalOutcome(simId, outcome)` | Flushes pending AMSA logs, then transactionally writes ROSC status, cumulative joules, and total pre-shock pause. |

The engine emits at 1 Hz, so writing each AMSA point individually would cost 60
round trips per minute per session. Points buffer to 30 (or 20 s, whichever
comes first) and flush as a single batch, chunked at Firestore's 500-op ceiling.
Flushes are chained so overlapping calls cannot interleave, and the monitor
flushes on unmount so navigating away does not drop the tail.

`firestore.ts` is the single source of truth for database access; there is no
second schema.

## Session setup flow

`/scenario` → `PatientForm` collects reference id (auto-generated if blank), age,
weight, transthoracic impedance (40–150 Ω slider, default 75), time down without
CPR, the presentation rhythm, the ACLS special circumstances, and comorbidity
toggles. **Quick Randomize** fills a clinically plausible preset (65 y, 85 kg,
90 Ω, Fine VFib, 4 min down).

Nine presentations, grouped by the **algorithm they route to** rather than by
waveform, because that is the consequential distinction: the assessment gate has
to be able to rule defibrillation *out* and pick synchronised energy or pacing
instead.

Special circumstances are stored in the canonical order regardless of the order
they were toggled, so two profiles with the same circumstances always serialise
identically. **"Assess Patient & Lock Intake Profile"** calls
`createSimulationSession` and routes to `/monitor?sim={simId}`, which subscribes
to the session and hands it to `AutomatedDualSimulator`. The page is a write
path only: the simulator generates both arms and renders its own comparison, so
nothing is mirrored back into page state.

The simulator derives its `PatientParameters` from session *primitives*, and
joins the circumstance array into a string key before using it as a dependency —
a Firestore snapshot returns a fresh array every time, and an array identity in
the dependency list would rebuild both timelines and reset a run in progress.

Reference ids are crypto-random over a 32-glyph alphabet with I/O/0/1 removed, so
they survive being read aloud and two tablets starting in the same second cannot
collide. They are generated on interaction only, never during render.

Coarse and Fine VFib are genuinely different signals, not labels: measured under
CPR, coarse VF yields AMSA 2.8 mV·Hz and fine VF 2.0 mV·Hz.

## Outcome engine

`src/lib/oide/outcome.ts` — pure, with an injectable RNG.

**Myocardial injury index.** `MII = Σ max(0, delivered − baseline) × 0.5`,
accumulated **per shock** rather than over the totals, so an over-dose cannot be
cancelled out by an under-dose elsewhere in the run. Every shock records what
OIDE would have advised at that instant, so the traditional arm's baseline is the
calibrated energy it declined to use. An arm that delivers exactly the calibrated
energy scores 0 by construction.

The baseline differs by delivery type, and the asymmetry is clinical. For
defibrillation it is the calibrated optimum: failed attempts are an expected part
of the arrest algorithm and both arms pay for them equally. For a **synchronised**
shock that converted nothing the baseline is **zero** — the calibrated route would
never have selected that rung at all, so every joule of it is excess. That is why
the traditional narrow-QRS run above scores 31.0 on 150 J: the failed 50 J attempt
is charged in full.

**Probabilistic shock resolution** (`resolveShock`, `roscProbability`) predates
the automated engine and is retained: base p(ROSC) 0.90 / 0.45 / 0.05 by AMSA
band, less 2 percentage points per second of hands-off time beyond a 5 s grace
period. `aclsEngine` does **not** use it — a comparison between two protocols
has to be a controlled experiment, so conversion there is the deterministic
`defibrillationEfficacy` threshold described above rather than a dice roll.

## Comparative dashboard

`OutcomeAnalysis.tsx` renders behind the **Compare Both Routes** tab, and again
at `/debrief?sim={simId}` for any concluded session.

- A comparison strip: total energy delivered, myocardial injury index,
  pre-shock pause accumulation in ms, the final conversion probability, the
  rhythm outcome, and survival likelihood — side by side with the OIDE-relative
  delta. On the rhythm row the delta is the time-to-conversion difference.
- Side-by-side outcome cards per route: conversion status and time, survival
  likelihood, energy delivered against the calibrated baseline, MII, pre-shock
  pause, final conversion probability, rhythm outcome, adrenaline doses, and —
  for a bradycardia run — the instant pacing captured.
- A **comparative** AMSA trajectory — one trace per route, split on the `arm`
  tag each timepoint carries. Both arms received identical compressions, so the
  gap between the traces is the myocardial cost of the energy strategy alone.
  CPR intervals shade the background; shock, drug and special-circumstance
  markers overlay it. Markers differ in shape as well as colour, and the full
  event log is repeated as a table, so nothing depends on colour alone.

Every label the dashboard renders is algorithm-aware: `CONVERSION_LABEL` reads
"ROSC" for an arrest, "Rhythm converted" for a tachycardia, and "Pacing capture"
for a bradycardia, and the family is read off the persisted arm outcome rather
than re-derived, so a session reloaded from Firestore reports whatever it actually
ran under. For a presentation with no fibrillatory waveform the chart caption says
so instead of implying a flat AMSA line means something.

## Research export

Two artefacts, deliberately separate.

**"Export Research Data (JSON)"** — `buildDualArmExport()` assembles the patient
profile, the assessment, the **KKM plan both arms executed** (family, guideline
ref, checklist, every expanded step, the circumstances in force and the interval,
yield, gate and impedance-floor modifiers they produced), the engine's calibration
constants, and both arms in full — every event and the complete **1 Hz** AMSA
track — plus the joule, MII, pre-shock-pause, survival, and time-to-conversion
deltas. Built locally from the generated timelines, so it works with no Firebase
configured. `exportedAt` is a parameter rather than a `Date.now()` call, which
keeps the builder a pure function of its inputs. `formatVersion: 3`.

**"Export session data (JSON)"** bundles the root document, the complete
`Interventions` collection, and the complete `AmsaLogs` collection into one
versioned file. Buffered AMSA points are flushed first, subcollections are read
in parallel and ordered by `offsetMs`, and Firestore `Timestamp` values are
converted to ISO strings so the output is plain JSON.

```jsonc
{
  "formatVersion": 1,
  "exportedAt": "…",
  "simId": "OIDE-ER2L-MUQW",
  "session":       { /* root doc incl. outcome.arms */ },
  "interventions": [ /* ordered by offsetMs */ ],
  "amsaLogs":      [ /* ordered by offsetMs */ ],
  "counts":        { "interventions": 20, "amsaLogs": 34 }
}
```

The download revokes its object URL on the next macrotask — revoking
synchronously can abort the save in some browsers, and never revoking leaks the
blob for the life of the document.

## Scripts

```bash
npm run dev         # dev server
npm run build       # production build (runs typecheck)
npm run lint        # eslint
npm test            # vitest, single run
npm run test:watch  # vitest, watch mode
```

`kkmAclsRules.test.ts`, `decisionEngine.test.ts`, `outcome.test.ts`, and
`aclsEngine.test.ts` cover the engines — 146 tests.

KKM rules engine: algorithm routing for every intake presentation, matrix
completeness (guideline ref and checklist on all of them, compressions only for
the arrest family), the fixed-200 J arrest rung and its repeat past the ladder's
end, the zero-energy PEA/asystole path, the narrow and broad cardioversion
ladders and their synchronisation flag, sedation ordering before attempt 1,
ladder spacing, adenosine 6/12 mg gated to narrow QRS only, broad-QRS amiodarone
capped at 150 mg twice, weight-based lignocaine and its single-dose ceiling,
atropine's 3 mg ceiling and 3–5 minute spacing, escalation to
pacing then a chronotropic infusion, the impedance scaling of both the
cardioversion requirement and the pacing capture threshold, the calibrated
selections sitting above them inside their envelopes, the traditional pacing
climb, and every special circumstance — LUD at 00:15, the PMCD window, the
doubled hypothermic intervals with their one permitted shock and rewarming
resume, calcium/bicarbonate at 02:30 with its AMSA gain, naloxone and a
weight-based lipid bolus, the obesity impedance floor, several circumstances
composing at once, plan determinism, step ordering, window containment, and the
guideline tag on every step.

Torsades specifically: that it routes to the arrest family with compressions and
agrees with both rhythm sets, that it defibrillates unsynchronised at the fixed
arrest energy and resolves against AMSA, that magnesium lands at 01:00 ahead of
the first adrenaline dose and carries its AMSA gain, that amiodarone is withheld
while every other shockable rhythm still receives it, that the broad-QRS
checklist cross-references it, and that it keeps the arrest CPR structure.

ACLS engine: the playback clock and its round trip, impedance clamping, AMSA
seeding and downtime decay, CPR fatigue monotonicity, the reserve and
energy-adequacy curves (including the under/over asymmetry and the floor), the
stun model, survival bounds, the assessment gate over every rhythm, sequence
expansion (2-minute blocks, the 3–5 minute adrenaline window, earlier adrenaline
for non-shockable rhythms, amiodarone tied to shock *numbers* rather than
instants), timeline determinism, the fixed-200 J and calibrated-energy
invariants, the event-line format the feed prints, run termination at ROSC, the
non-shockable zero-joule path, `frameAt` projection and clamping, arm folding,
and export serialisability.

Decision engine: calibration
anchors, monotonicity across a 1000-point sweep, band-edge inclusivity, the
110–140 J shock envelope, impedance linearity, clamping, non-finite input, and
the rhythm gate against every non-shockable rhythm at every AMSA band. Outcome
engine: each probability band, the pause penalty and its grace period, clamping
at zero, roll-boundary exclusivity, MII flooring, and a 20 000-trial convergence
check against a seeded LCG so the assertion cannot flake.
