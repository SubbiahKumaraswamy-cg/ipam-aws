# IPAM-AWS — Cloud IP Address Management

An interactive IP Address Management (IPAM) web application for tracking CIDR/address-space
allocations to markets (countries/regions) across **AWS** and **Azure**, hosted in **your own
AWS account**.

It replaces the multi-tab allocation spreadsheet with a live, role-controlled, spreadsheet-style
web app: viewers can browse and filter; editors/admins can add, edit and delete rows.

---

## Features

- **Spreadsheet-style editable grids** (AG Grid) for each data set, with inline edit, search,
  column filters, and per-region column visibility.
- **Region groupings**: EUROPE, CAMEAT (Central Africa & Middle East), ASIA, LATAM (Latin
  America), AMERICA / NORTH AMERICA, COMPASS GROUP.
- **Environments**: AWS and Azure. Azure allocations are tracked by **subscription** and
  **portal type** — `Classic (Old Portal)` and `ARM (New Portal)` (a.k.a. "Azure New").
- **Subnet plan** view for the hierarchical `/12 → /14 → /16` supernet planning table.
- **Dashboard** with utilization charts by region, environment, and status.
- **Role-based access** via Amazon Cognito: `Viewer` (read-only), `Editor` (modify rows),
  `Admin` (modify rows + manage users/reference data).
- **CSV / XLSX import & export** to seed from the existing spreadsheet and to share data.
- **Audit trail** — every create/update/delete is recorded with user + timestamp.

## Architecture

```
                       ┌──────────────────┐
      Browser  ───────▶│  CloudFront + S3 │   React + Vite SPA (AG Grid + charts)
                       └────────┬─────────┘
                                │  HTTPS (JWT from Cognito)
                       ┌────────▼─────────┐
                       │   API Gateway    │
                       └────────┬─────────┘
                                │
                       ┌────────▼─────────┐
                       │  Lambda (Node/TS)│   REST API + auth + CIDR logic
                       └────────┬─────────┘
                                │  (in VPC)
                       ┌────────▼─────────┐
                       │  RDS PostgreSQL  │   native cidr/inet types
                       └──────────────────┘

      Amazon Cognito  ──▶  user pool + groups (Viewer / Editor / Admin)
```

| Layer     | Technology                                             |
|-----------|--------------------------------------------------------|
| Frontend  | React + Vite + TypeScript + AG Grid + Recharts         |
| API       | Amazon API Gateway (HTTP API) + AWS Lambda (Node/TS)   |
| Database  | Amazon RDS for PostgreSQL (native `cidr`/`inet` types) |
| Auth      | Amazon Cognito (user pool, groups → roles)             |
| Hosting   | S3 + CloudFront (SPA), Lambda in VPC                    |
| IaC       | AWS CDK (TypeScript)                                    |

## Repository layout

```
ipam-aws/
├── packages/
│   ├── shared/     # Shared TypeScript domain types + CIDR helpers
│   ├── api/        # Lambda handlers, DB access, auth, migrations
│   ├── web/        # React + Vite SPA
│   ├── infra/      # AWS CDK app (VPC, RDS, Lambda, API GW, Cognito, S3/CF)
│   └── importer/   # CSV/XLSX importer to seed from the spreadsheet
├── docs/
│   └── DEPLOY.md   # Step-by-step deployment guide for your AWS account
└── README.md
```

## Quick start

Prerequisites: Node.js 20+, npm, an AWS account, AWS CLI configured, AWS CDK v2.

```bash
npm install                 # install workspace dependencies
npm run build               # build shared, api, web
```

Deploy to your AWS account — see **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## Data model

See [packages/shared/src/model.ts](packages/shared/src/model.ts) for the canonical domain types
and [packages/api/migrations](packages/api/migrations) for the SQL schema.

## License

Proprietary — internal use.
