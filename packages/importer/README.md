# @ipam/importer

Command-line importer that reads the existing **IP address allocation** workbook
and loads it into Cloud IPAM.

## What it produces

Each country row in the spreadsheet becomes two things in the revised model:

| Spreadsheet | Becomes |
|---|---|
| `ISO` + `COUNTRY` + region banner | a **country**, linked to its region |
| `CLOUD SPACE` + `MASK` | a **master subnet** for that country |
| `Current Range` | a note on the master subnet's remarks |
| `Subscription` + `Address Space` | an **Azure subscription** mapping |
| `/16` / `/14` / `/12` sheet | **subnet plan** entries |

`Current Range` is preserved as a remark rather than a field, because the revised
model derives usage from child subnets. Once the masters are loaded, create child
subnets for the ranges actually in use — that is what drives the allocated and
available figures.

## Why the parser has to be clever

The workbook does not use one simple table per sheet. Each allocation sheet
contains several *blocks* laid out side by side under merged region banners, and
the blocks do not all have the same columns:

```
        A        B            C          D           E             F
  1              CAMEAT                        │      ASIA                  <- merged banners
  2  ISO   COUNTRY   CLOUD SPACE   MASK        │  ISO   COUNTRY   ...
  3  AE    UAE       10.20.0.0     /16         │  SG    Singapore ...
```

- Some blocks include `Current Range`, some also `Remarks`, and some (e.g.
  `NORTH AMERICA`) stop at `MASK`.
- The `MASK` column is written inconsistently: `/16`, `16`, and `255.255.0.0`
  all appear.
- The Azure sheets also contain `Subscription` / `Address Space` tables split into
  **Classic (Old Portal)** and **ARM (New Portal)**.
- One sheet is the hierarchical `/16 → /14 → /12` plan.

Rather than assuming fixed positions, the parser anchors on header cells (`ISO`,
`Subscription`, `/16`), reads the contiguous run of headers to the right, and
scans upwards through merged cells to find the region banner.

## Usage

```bash
# From the repository root
npm install
npm run build --workspace packages/shared
npm run build --workspace packages/importer

# 1. Inspect the workbook without writing anything
node packages/importer/dist/index.js "IPAM-Solution-Cloud-data.xlsx" --dry-run

# 2. Produce CSVs to upload via the app's "Import CSV" buttons
node packages/importer/dist/index.js "IPAM-Solution-Cloud-data.xlsx" --out ./out

# 3. Or load straight into a deployed environment
node packages/importer/dist/index.js "IPAM-Solution-Cloud-data.xlsx" \
  --api https://abc123.execute-api.eu-west-1.amazonaws.com \
  --token "$ID_TOKEN"
```

### Options

| Option | Purpose |
|---|---|
| `--dry-run` | Report findings; write nothing. **Always start here.** |
| `--out <dir>` | Write CSVs matching the app's import format |
| `--json <dir>` | Write raw JSON payloads |
| `--api <url>` | POST directly to the IPAM API |
| `--token <jwt>` | Cognito **ID token** (required with `--api`) |
| `--quiet` | Suppress the per-warning listing |

### Import order

**Countries must be loaded before master subnets**, because subnets reference
them by ISO code. `--api` does this automatically. When uploading CSVs by hand,
do `countries.csv` first.

### Getting an ID token for `--api`

```bash
aws cognito-idp admin-initiate-auth \
  --user-pool-id <UserPoolId> \
  --client-id <UserPoolClientId> \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=you@compass-group.com,PASSWORD='<password>' \
  --query 'AuthenticationResult.IdToken' --output text
```

The account must be in the `Author` or `Admin` group — imports span countries, so
country owners cannot run them.

## How values are interpreted

| Source | Becomes |
|---|---|
| Sheet name contains `AWS` | `providerLocation = AWS` |
| Sheet name contains `Azure` | `providerLocation = Azure` (includes the *Azure New* sheet) |
| Sheet name contains `GCP` | `providerLocation = GCP` |
| `NORTH AMERICA` banner | region `NORTH AMERICA` |
| `CAMEAT`, `Middle East` | region `CAMEAT` |
| `ASIA`, `APAC`, `Pacific` | region `APAC` |
| `LATAM`, `Latin America` | region `LATAM` |
| `Compass Group` | region `GROUP` |
| `CLOUD SPACE` + `MASK` | one normalised CIDR (`10.20.0.0` + `255.255.0.0` → `10.20.0.0/16`) |

Rows are **skipped** when they have no `CLOUD SPACE`, or when that value contains
no digits (sub-headings and subtotal rows).

## Reading the output

```
Sheet summary
──────────────────────────────────────────────────────────────────────────────
SHEET                   DETECTED AS                        MASTERS  SUBS  PLAN
AWS                     AWS master subnets (4 region bloc        9     0     0
Azure                   Azure master subnets (2 region bl        4     4     0
Azure New               Azure master subnets (1 region bl        2     0     0
16 SUBNETS              subnet plan                              0     0     3
──────────────────────────────────────────────────────────────────────────────
TOTAL                                                           15     4     3
```

Check the **region block count** against the number of banners you expect on each
sheet. If a block is missing, its banner text probably is not recognisable as a
region — the warnings name the row and column so you can fix the heading.

## Rows the API rejects

The importer deliberately does not pre-filter problems that need a human
decision. The API reports them per row and skips them, leaving the rest imported:

```
/master-subnets/import  200 {"total":15,"inserted":14,"skipped":1}
    ! row 13: "10.71.0.0/255.0.255.0" is not a valid IPv4 CIDR.
```

The two common cases:

- **Invalid mask** — e.g. the discontiguous `255.0.255.0`. Fix it in the
  spreadsheet or add the subnet by hand.
- **Overlapping ranges** — the spreadsheet may contain overlaps that the new
  model forbids. The message names the CIDR it clashes with so you can decide
  which is correct.

Imports are **idempotent**: re-running updates existing rows (matched on the
exact CIDR for masters, ISO for countries) rather than duplicating them.
