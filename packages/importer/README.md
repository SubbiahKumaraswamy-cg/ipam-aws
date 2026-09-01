# @ipam/importer

Command-line importer that reads the existing **IP address allocation** workbook
and loads it into Cloud IPAM.

## Why it needs to be clever

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
- The Azure sheets additionally contain `Subscription` / `Address Space` tables
  split into **Azure - Classic (Old Portal)** and **Azure - ARM (New Portal)**.
- One sheet is the hierarchical `/16 → /14 → /12` subnet plan.

Rather than assuming fixed positions, the parser anchors on header cells (`ISO`,
`Subscription`, `/16`), reads the contiguous run of headers to the right, and
scans upwards through merged cells to find the region banner.

## Usage

```bash
# From the repository root
npm run build --workspace packages/shared
npm run build --workspace packages/importer

# 1. Inspect the workbook without writing anything
node packages/importer/dist/index.js "IP address allocation.xlsx" --dry-run

# 2. Produce CSVs to upload via the app's "Import CSV" buttons
node packages/importer/dist/index.js "IP address allocation.xlsx" --out ./out

# 3. Or load straight into a deployed environment
node packages/importer/dist/index.js "IP address allocation.xlsx" \
  --api https://abc123.execute-api.eu-west-1.amazonaws.com \
  --token "$ID_TOKEN"
```

### Options

| Option                 | Purpose                                                    |
|------------------------|------------------------------------------------------------|
| `--dry-run`            | Report findings; write nothing. **Always start here.**      |
| `--out <dir>`          | Write CSVs matching the app's import format                 |
| `--json <dir>`         | Write raw JSON payloads                                     |
| `--api <url>`          | POST directly to the IPAM API                               |
| `--token <jwt>`        | Cognito **ID token** (required with `--api`)                |
| `--default-status <s>` | Force a status instead of deriving it                       |
| `--quiet`              | Suppress the per-warning listing                            |

### Getting an ID token for `--api`

```bash
aws cognito-idp admin-initiate-auth \
  --user-pool-id <UserPoolId> \
  --client-id <UserPoolClientId> \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=you@example.com,PASSWORD='<password>' \
  --query 'AuthenticationResult.IdToken' --output text
```

The account must be in the `Editor` or `Admin` group, since importing modifies
data.

## How values are interpreted

| Source                        | Becomes                                                            |
|-------------------------------|--------------------------------------------------------------------|
| Sheet name contains `AWS`     | `environment = AWS`                                                |
| Sheet name contains `Azure`   | `environment = Azure` (this includes the *Azure New* sheet)        |
| `NORTH AMERICA` banner        | `regionGroup = AMERICA`                                            |
| `CAMEAT`, `Middle East`       | `regionGroup = CAMEAT`                                             |
| `LATAM`, `Latin America`      | `regionGroup = LATAM`                                              |
| `Compass Group`               | `regionGroup = COMPASS GROUP`                                      |
| `CLOUD SPACE` + `MASK`        | Normalised CIDR (`10.20.0.0` + `255.255.0.0` → `10.20.0.0/16`)     |
| `Current Range` present       | `status = Used`, otherwise `Allocated` (override with `--default-status`) |
| `Azure - Classic (Old Portal)`| `portalType = Classic (Old Portal)`                                |
| `Azure - ARM (New Portal)`    | `portalType = ARM (New Portal)`                                    |

Rows are **skipped** when they have no `CLOUD SPACE` value or when that value
contains no digits (sub-headings and subtotal rows). Rows whose network/mask
pair is not a valid IPv4 CIDR are still imported, but reported as warnings and
highlighted in red in the UI so they can be corrected.

Imports are **idempotent**: re-running updates existing rows rather than
duplicating them. The key is
`(environment, region, cloud space, mask, ISO)` for allocations and
`(portal, subscription, address space)` for subscriptions.

## Reading the output

```
Sheet summary
──────────────────────────────────────────────────────────────────────────────
SHEET                   DETECTED AS                     ALLOC  SUBS  PLAN
AWS                     AWS allocations (4 region blo       9     0     0
Azure                   Azure allocations (2 region b       4     4     0
Azure New               Azure allocations (1 region b       2     0     0
16 SUBNETS              subnet plan                         0     0     3
```

Check the **region block count** against the number of banners you expect on
each sheet. If a block is missing, its banner text probably is not recognisable
as a region — the warnings will name the row and column so you can fix the
heading (or import that block separately as CSV).
