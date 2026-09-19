# IPAM-AWS — Cloud IP Address Management

An intranet IP Address Management (IPAM) portal for tracking IP allocations
across **AWS, Azure, GCP, on-premises, units and branches**, organised by region
and country, and hosted in **your own AWS account**.

It replaces the allocation spreadsheet with a live, role-controlled application
that makes overlapping subnets impossible and keeps allocated/available counts
correct by construction.

---

## The model

```
Region  (North America · Europe · CAMEAT · APAC · LATAM · Group)
  └── Country                      e.g. DE — Germany
        └── Master Subnet          e.g. 10.20.0.0/16      ← never overlap
              ├── Child Subnet     e.g. 10.20.1.0/24      ← Allocated
              ├── Child Subnet     e.g. 10.20.2.0/25      ← Reserved
              └── Child Subnet     e.g. 10.20.9.0/24      ← Released (space reusable)
```

**Allocated and available counts are derived, never stored**, so they can't drift
from reality. A master subnet's capacity is computed from its children:
`Reserved` and `Allocated` consume space; `Released` returns it to the pool.

### Every child subnet records its request trail

| Field | Purpose |
|---|---|
| Requestor Name | who asked |
| Request Date | when they asked |
| Allocated Date | when it was granted |
| Justification / Purpose | why it exists |
| Technical Owner | who to contact |
| Environment | Prod / UAT / Dev / Test |
| Cloud Provider or Location | AWS / Azure / GCP / On-prem / Unit / Branch |
| Status | Reserved / Allocated / Released |
| Remarks | free text |

## Features

- **Overlap prevention is enforced by the database**, not just the UI —
  PostgreSQL exclusion constraints make an overlapping subnet impossible to
  insert, even via direct SQL. Children must also sit inside their master.
- **Free-range suggestion**: ask for a `/24` and the app proposes the lowest
  correctly-aligned free block in the master subnet.
- **Automatic capacity tracking** with utilisation meters, plus a dashboard
  listing the master subnets closest to exhaustion.
- **Add columns without a deployment.** Administrators define extra fields
  (text, number, date, select, boolean) that appear on the grids and forms.
- **Reserved subnet management** — hold space with `Reserved`, release it later
  without losing the request history.
- **Country-scoped permissions** so a market administrator can maintain only
  their own country's data.
- **Full audit trail** of every create, update and delete, with the actor.
- **CSV import/export** throughout, plus a CLI importer for the existing workbook.

## Permissions

Roles map to Cognito groups; the highest privilege wins.

| Role | Scope |
|---|---|
| **Admin** | Everything: all countries, custom columns, country owners, audit trail |
| **Author** | The global team — may edit every country's data |
| **CountryOwner** | May edit only the countries assigned to them |
| **Viewer** | Read-only |

Region-wide and Group-level master subnets (those with no country) are editable
only by **Author** and **Admin**.

> Every write is re-checked on the server. Hiding a button in the UI is a
> convenience, not the control.

## Architecture

```
                       ┌──────────────────┐
      Browser  ───────▶│  CloudFront + S3 │   React + Vite SPA (AG Grid + charts)
                       └────────┬─────────┘
                                │  HTTPS (Cognito ID token)
                       ┌────────▼─────────┐
                       │   API Gateway    │   JWT authorizer
                       └────────┬─────────┘
                                │
                       ┌────────▼─────────┐
                       │  Lambda (Node/TS)│   REST API, authorisation, CIDR logic
                       └────────┬─────────┘
                                │  (in VPC)
                       ┌────────▼─────────┐
                       │  RDS PostgreSQL  │   native cidr type + exclusion constraints
                       └──────────────────┘

      Amazon Cognito  ──▶  user pool + groups (Admin / Author / CountryOwner / Viewer)
```

| Layer | Technology |
|---|---|
| Frontend | React + Vite + TypeScript + AG Grid + Recharts |
| API | API Gateway (HTTP API) + AWS Lambda (Node 22, ARM64) |
| Database | Amazon RDS for PostgreSQL 16 |
| Auth | Amazon Cognito |
| Hosting | S3 + CloudFront (private bucket behind Origin Access Control) |
| IaC | AWS CDK (TypeScript) |

## Repository layout

```
ipam-aws/
├── packages/
│   ├── shared/     # Domain types + IPv4/CIDR and capacity maths
│   ├── api/        # Lambda handlers, repositories, auth, SQL migrations
│   ├── web/        # React SPA
│   ├── infra/      # AWS CDK app
│   └── importer/   # CLI that reads the existing workbook
├── docs/
│   └── DEPLOY.md   # Step-by-step deployment guide
└── README.md
```

## Quick start

Prerequisites: Node.js 20+ (22 recommended), npm, an AWS account, AWS CLI, CDK v2.

```bash
npm install     # required before building — the build tools live here
npm run build   # shared -> api -> web, in that order
```

Then deploy — see **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## Loading the existing spreadsheet

```bash
npm run build --workspace packages/importer

# Always inspect first
node packages/importer/dist/index.js "IPAM-Solution-Cloud-data.xlsx" --dry-run

# Produce CSVs for the app's Import buttons
node packages/importer/dist/index.js "IPAM-Solution-Cloud-data.xlsx" --out ./out
```

Import **countries first**, then master subnets — subnets reference countries.
Imports are idempotent, and rows that would overlap are reported and skipped
rather than silently dropped. See
[packages/importer/README.md](packages/importer/README.md).

## Data model reference

- Domain types: [packages/shared/src/model.ts](packages/shared/src/model.ts)
- Capacity maths: [packages/shared/src/cidr.ts](packages/shared/src/cidr.ts)
- SQL schema: [packages/api/migrations](packages/api/migrations)

## License

Proprietary — internal use.
