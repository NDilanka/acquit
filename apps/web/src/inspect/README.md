# Checker inspector

The "Try to cheat the checker" inspector. It runs a real checker in the browser on a set of prepared files, plays the
machine run (simulated), ticks the public rules as the checker reports them, opens the sealed checks, and shows the
verdict.

Use it on any page:

```tsx
import { CheckerInspector } from "./inspect/CheckerInspector.tsx";

<CheckerInspector workflow="laser" delivery="fraud-hidden-notch" />
```

`workflow` picks the checker (laser cutting when absent), `delivery` the file to open on, and `flat` forces the 2D view.
The component needs no router, session or page shell; `/inspect` (`InspectPage.tsx`) is one page that uses it.

## Adding a checker

A checker is one `CheckerEntry` in `CHECKERS` (`registry.ts`), keyed by the `workflow` its verdict reports.
`laser-deliveries.ts` is the worked example. An entry supplies:

| Field | What it is |
| --- | --- |
| `workflow` | The verdict's workflow name, also the key in `CHECKERS`. |
| `jobSummary` | One sentence naming the job, read from the spec, shown under the title. |
| `specFileName`, `specText` | The job spec as the checker reads it, shown under "Show the file". |
| `deliveries` | The files a visitor can pick. Each has an `id`, a `title`, a one-line `blurb`, `cheat`, the delivered `fileName` and `text`, and `run()`, which calls the real checker on `text` and returns its verdict. The honest file comes first. |
| `featured` | Delivery ids shown before "More cheats", in order: the honest file, then three or four cheats a visitor understands at a glance. One should pass every public rule and fail a sealed check. |
| `ruleNames` | A plain name for each public rule id, such as "Holes the right size, in the right place" for `holes`. Name what the rule tests, and give every public rule the checker can emit a name; the tests check this for the laser checker. The id is shown as small secondary text. |
| `failCaption` | A plain caption for a failed public finding. Build it only from the finding's message: any number in the caption must appear in the message. Return `null` to show the message itself. |
| `measured` | A label, unit and decimals for each key of `measured`. Mark an estimate as one in its label. |
| `dressing` | `"laser"` draws a bed, gantry and head around the scene; `"none"` draws the scene on a plain floor. |
| `runCaption` | The caption while the machine run plays. |

The verdict must fit `InspectVerdict` (`contract.ts`):

- `findings`: one per rule, in the order the checker runs them, with `hidden: true` on sealed checks. A sealed finding's
  message is never shown; it reads "content not shown".
- `scene`: every path in millimetres with its `kind`, `layer`, `z` and `points`. `stock`, when present, is the sheet the
  stage frames. `order` sets the run order; paths without one run in the order given.
- `at`, when present, is the spot a failed finding is about, and the stage marks it.
- `refs` on a failed finding names the paths it is about. The stage highlights those paths and, without `at`, marks
  the middle of them.

## Known gaps in the contract

- No finding carries `at`, so marks come from `refs`; a finding with neither is shown in the list only.
- The scene has no travel paths, so the head moves straight between cuts. The run is simulated, and it is labelled so.
- `measured` keys carry no labels or units of their own, so each checker supplies `measured` formats here.
