# Deploying Cloud IPAM to your AWS account

This guide walks through a first deployment end to end. Everything runs from
your own machine using your own AWS credentials — no credentials are stored in
this repository.

**Time required:** about 30 minutes, most of it waiting for RDS and CloudFront.

---

## 1. Prerequisites

| Requirement | Check with | Notes |
|---|---|---|
| Node.js 20+ | `node --version` | 22 recommended |
| npm 10+ | `npm --version` | |
| AWS CLI v2 | `aws --version` | |
| AWS credentials | `aws sts get-caller-identity` | Must return your account |
| AWS CDK v2 | `npx cdk --version` | Installed as a dev dependency |

You will also need to choose:

- **A region** — e.g. `eu-west-1`.
- **An admin email** — receives the temporary password for the first login.
- **A Cognito domain prefix** — must be **globally unique** across all of AWS,
  e.g. `ipam-compass-7f3a`.

### IAM permissions

The deploying principal needs to create VPC, RDS, Lambda, API Gateway, Cognito,
S3, CloudFront, Secrets Manager, IAM and CloudFormation resources. In practice
that means `AdministratorAccess`, or a scoped role your cloud team approves.

---

## 2. Install and build

```bash
git clone https://github.com/SubbiahKumaraswamy-cg/ipam-aws.git
cd ipam-aws

npm install     # installs the build tools; do not skip
npm run build   # builds shared -> api -> web, in that order
```

> **Build order matters.** `packages/api` and `packages/infra` consume the
> compiled output of `packages/shared`, and the CDK stack packages
> `packages/web/dist` into the S3 deployment. `npm run build` handles the order;
> if you build individually, do shared first and web before `cdk deploy`.
>
> **`npm install` is required**, not optional — `tsc` and the CDK CLI are
> project dependencies. Building without it may silently pick up a different
> globally-installed TypeScript.

---

## 3. Bootstrap CDK (once per account/region)

```bash
export AWS_REGION=eu-west-1
cd packages/infra
npx cdk bootstrap
```

Skip this if the account/region is already bootstrapped.

---

## 4. Deploy

From `packages/infra`:

```bash
npx cdk deploy \
  -c adminEmail=you@compass-group.com \
  -c cognitoDomainPrefix=ipam-compass-7f3a
```

Review the IAM changes CDK prints, then confirm. RDS takes 10–15 minutes on
first creation.

### Deployment options

| Context key | Default | Purpose |
|---|---|---|
| `adminEmail` | *(required)* | First Admin user |
| `cognitoDomainPrefix` | *(required)* | Globally unique hosted-UI prefix |
| `appName` | `ipam` | Prefix for resource names |
| `dbInstanceClass` | `t4g.micro` | RDS size, e.g. `t4g.small` |
| `dbMultiAz` | `false` | `true` for HA (doubles DB cost, enables deletion protection) |
| `dbAllocatedStorage` | `20` | GiB |
| `useNatGateway` | `false` | `true` routes Lambda via NAT instead of VPC endpoints |

### What gets created

```
VPC (2 AZs, no NAT by default)
├── Isolated subnets
│   ├── RDS PostgreSQL 16 (encrypted, private, 7-day backups)
│   ├── API Lambda (Node 22, ARM64)
│   └── Migration Lambda (runs automatically after the DB is ready)
├── Secrets Manager VPC endpoint (so Lambda can read DB credentials)
API Gateway HTTP API  — JWT-authorised, /health public
Cognito user pool     — groups: Admin, Author, CountryOwner, Viewer
S3 + CloudFront       — private bucket behind Origin Access Control
```

Database migrations run **automatically** as part of the deployment, via a CDK
trigger on the migration Lambda.

---

## 5. Note the outputs

```
Outputs:
ipam-stack.WebsiteUrl = https://d111111abcdef8.cloudfront.net
ipam-stack.ApiUrl = https://abc123.execute-api.eu-west-1.amazonaws.com
ipam-stack.UserPoolId = eu-west-1_XXXXXXXXX
ipam-stack.UserPoolClientId = 1a2b3c4d5e6f7g8h9i0j
...
```

Retrieve them later with:

```bash
aws cloudformation describe-stacks --stack-name ipam-stack \
  --query 'Stacks[0].Outputs' --output table
```

---

## 6. First sign-in

1. Check the inbox of the `adminEmail` you supplied — Cognito sends a temporary
   password. (Check spam; the sender is `no-reply@verificationemail.com`.)
2. Open the **WebsiteUrl**.
3. Sign in and set a permanent password (12+ characters, mixed case, digit,
   symbol).

You are in the `Admin` group, so you can edit everything, define custom columns
and assign country owners.

> **Email limits.** Cognito's built-in email is capped at 50 messages/day. For
> more users, configure the user pool to send via Amazon SES.

---

## 7. Set up your team

### The global team (5 people with author rights)

```bash
POOL=eu-west-1_XXXXXXXXX     # UserPoolId output

aws cognito-idp admin-create-user \
  --user-pool-id "$POOL" \
  --username colleague@compass-group.com \
  --user-attributes Name=email,Value=colleague@compass-group.com \
                    Name=email_verified,Value=true

aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$POOL" \
  --username colleague@compass-group.com \
  --group-name Author
```

`Author` grants edit rights across **every** country — the right role for the
core global team.

### Country administrators

This is a **two-step** process:

```bash
# 1. Put them in the CountryOwner group
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$POOL" \
  --username de.admin@compass-group.com \
  --group-name CountryOwner
```

2. In the app, go to **Admin → Country owners → Assign countries**, enter their
   email, and tick the countries they may edit.

Both steps are required. The group alone grants nothing until countries are
assigned, and assigning countries does nothing until they are in the group.

### Read-only users

Create the user and add them to **no group** (or to `Viewer`).

### Group reference

| Group | Effect |
|---|---|
| `Admin` | Everything, including custom columns, country owners and audit |
| `Author` | Edit all countries |
| `CountryOwner` | Edit only assigned countries (assign them in the app) |
| `Viewer` | Read-only |

**Role changes take effect when the user's token refreshes** — have them sign out
and back in for an immediate change.

You can do all of this in the console under **Cognito → User pools → your pool →
Users / Groups**.

---

## 8. Load your data

Order matters: **countries → master subnets → child subnets**, because each
level references the one above.

### Option A — via the UI

```bash
node packages/importer/dist/index.js "IPAM-Solution-Cloud-data.xlsx" --dry-run
node packages/importer/dist/index.js "IPAM-Solution-Cloud-data.xlsx" --out ./out
```

Then upload:

| File | Page |
|---|---|
| `out/countries.csv` | Countries |
| `out/master-subnets.csv` | Master subnets |
| `out/azure-subscriptions.csv` | Azure subs |
| `out/subnet-plan.csv` | Subnet plan |

### Option B — straight to the API

```bash
ID_TOKEN=$(aws cognito-idp admin-initiate-auth \
  --user-pool-id "$POOL" \
  --client-id <UserPoolClientId> \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=you@compass-group.com,PASSWORD='<password>' \
  --query 'AuthenticationResult.IdToken' --output text)

node packages/importer/dist/index.js "IPAM-Solution-Cloud-data.xlsx" \
  --api https://abc123.execute-api.eu-west-1.amazonaws.com \
  --token "$ID_TOKEN"
```

Always `--dry-run` first and check the region block counts per sheet. Imports are
idempotent; rows that would overlap an existing subnet are reported and skipped
so you can resolve them deliberately. See
[packages/importer/README.md](../packages/importer/README.md).

---

## 9. Adding columns later

No deployment needed. **Admin → Custom columns → Add column**: choose whether it
applies to master subnets, child subnets or countries, pick a type (text,
number, date, select, boolean), and it appears on that grid and its form for
everyone.

The storage key cannot be changed afterwards, because existing values are stored
under it. To retire a column, **hide** it rather than deleting it — hiding keeps
the stored values intact.

---

## 10. Updating the application

```bash
git pull
npm install
npm run build
cd packages/infra
npx cdk deploy -c adminEmail=you@compass-group.com -c cognitoDomainPrefix=<same-prefix>
```

Always pass the **same** `cognitoDomainPrefix`, otherwise CDK will try to replace
the Cognito domain.

New `.sql` files in `packages/api/migrations/` are applied automatically on the
next deploy, in filename order. Never edit a migration that has already run —
add a new one.

---

## 11. Cost estimate

Rough monthly figures for `eu-west-1`, light internal use:

| Component | Configuration | ~USD/month |
|---|---|---:|
| RDS PostgreSQL | `db.t4g.micro`, 20 GiB gp3, single-AZ | 15–18 |
| Secrets Manager VPC endpoint | 1 endpoint × 2 AZs | 14 |
| Secrets Manager | 1 secret | 0.40 |
| Lambda | Well within free tier | ~0 |
| API Gateway | Well within free tier | ~0 |
| S3 + CloudFront | A few MB, low traffic | <1 |
| Cognito | Under 50 users, Plus feature plan | 0–3 |
| **Total** | | **≈ $30–37** |

- **Cheaper:** keep `useNatGateway=false` (the default) — a NAT gateway would add
  ~$33/month.
- **Production:** `-c dbMultiAz=true` roughly doubles the RDS line and enables
  deletion protection.

---

## 12. Troubleshooting

**"cognitoDomainPrefix is required"** — pass both `-c adminEmail=...` and
`-c cognitoDomainPrefix=...`; the app fails fast rather than deploying something
unusable.

**Deploy fails: domain already exists** — the Cognito prefix is globally unique
across AWS. Pick another.

**No temporary-password email** — check spam, confirm the address, and check the
50/day Cognito limit. Reset with:
```bash
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" \
  --username you@compass-group.com --password '<NewPass123!>' --permanent
```

**Signed in but every request returns 401** — the SPA sends the **ID token**. If
you built a custom client, ensure it does too, and that `ApiUrl` in
`config.json` matches the deployed API.

**"Your account has read-only access"** — the user is in no writing group. Add
them to `Author`, or to `CountryOwner` *and* assign countries in the app. Then
sign out and back in.

**"You do not own DE"** — a country owner tried to edit a country not assigned to
them. Assign it under **Admin → Country owners**.

**"Region-wide and Group-level records can only be changed by a global Author or
Admin"** — the master subnet has no country. This is intentional: shared space
needs global oversight.

**"10.20.128.0/17 overlaps an existing master subnet"** — working as designed.
Master subnets may never overlap. Pick a different range, or adjust the existing
master.

**"Child subnet X is not contained within master subnet Y"** — pick a range
inside the master, or attach it to a different master. The **Suggest** button on
the request form finds a valid range.

**A child subnet won't fit** — use **Suggest** with the size you need; if nothing
is free the app reports the largest block still available.

**Master subnet shows as full but children look small** — `Reserved` counts
against capacity just like `Allocated`. Release anything no longer needed;
released space becomes reusable immediately.

**Cannot delete a master subnet** — delete or reassign its children first. Same
for a country that still has master subnets; consider marking it inactive
instead.

**Migrations appear not to have run** — inspect the migration Lambda's log group
in CloudWatch (`/aws/lambda/...MigrationFunction...`). It logs the migrations
directory used and each file applied. Re-invoke manually if needed:
```bash
aws lambda invoke --function-name <MigrationFunctionName> /dev/stdout
```

**Web changes are not visible** — CloudFront caches. The deployment invalidates
`/*`; allow a minute, then hard-reload.

---

## 13. Tearing down

```bash
cd packages/infra
npx cdk destroy
```

Deliberately retained so data is not lost silently:

- **RDS** takes a final snapshot (`RemovalPolicy.SNAPSHOT`).
- **The Cognito user pool is retained** — your users and groups survive.

Delete those manually if you want everything gone:

```bash
aws rds describe-db-snapshots --snapshot-type manual \
  --query 'DBSnapshots[?contains(DBSnapshotIdentifier,`ipam`)].DBSnapshotIdentifier'
aws rds delete-db-snapshot --db-snapshot-identifier <snapshot-id>
aws cognito-idp delete-user-pool --user-pool-id "$POOL"
```

---

## Security notes

- The database has **no public endpoint** and is reachable only from the Lambda
  security group inside the VPC.
- Credentials live in **Secrets Manager** and are fetched at runtime; they are
  never committed or placed in environment variables.
- The S3 bucket blocks all public access; CloudFront reads it through **Origin
  Access Control**.
- **Overlap prevention is a database constraint**, so it holds even against
  direct SQL access — not only through the application.
- Every mutation is written to `audit_log` with the acting user, visible to
  Admins on the **Audit** page.
- All write endpoints re-check the caller's role *and* country scope
  **server-side**.
- A country owner cannot move a record between countries: the check applies to
  both the source and the target market.

To put the app behind your own domain, add `domainNames` plus an ACM certificate
(in `us-east-1`) to the CloudFront distribution in
`packages/infra/lib/ipam-stack.ts`, and add the new URL to the Cognito client's
callback and logout URLs.
