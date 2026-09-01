# Deploying Cloud IPAM to your AWS account

This guide walks through a first deployment end to end. Everything runs from
your own machine using your own AWS credentials — no credentials are stored in
this repository.

**Time required:** about 30 minutes, most of it waiting for RDS and CloudFront.

---

## 1. Prerequisites

| Requirement | Check with | Notes |
|-------------|-----------|-------|
| Node.js 20+ | `node --version` | 22 recommended |
| npm 10+ | `npm --version` | |
| AWS CLI v2 | `aws --version` | |
| AWS credentials | `aws sts get-caller-identity` | Must return your account |
| AWS CDK v2 | `npx cdk --version` | Installed as a dev dependency |

You will also need to choose:

- **A region** — e.g. `eu-west-1`. Use one close to your network team.
- **An admin email** — receives the temporary password for the first login.
- **A Cognito domain prefix** — must be **globally unique** across all of AWS,
  e.g. `ipam-contoso-7f3a`.

### IAM permissions

The deploying principal needs to create VPC, RDS, Lambda, API Gateway, Cognito,
S3, CloudFront, Secrets Manager, IAM and CloudFormation resources. In practice
this means `AdministratorAccess`, or a scoped role your cloud team approves.

---

## 2. Install and build

```bash
git clone https://github.com/SubbiahKumaraswamy-cg/ipam-aws.git
cd ipam-aws

npm install
npm run build          # builds shared -> api -> web, in that order
```

> **Build order matters.** `packages/api` and `packages/infra` consume the
> compiled output of `packages/shared`, and the CDK stack packages
> `packages/web/dist` into the S3 deployment. `npm run build` handles the order
> for you; if you build individually, do shared first and web before `cdk deploy`.

---

## 3. Bootstrap CDK (once per account/region)

```bash
export AWS_REGION=eu-west-1        # your chosen region
cd packages/infra
npx cdk bootstrap
```

This creates the CDK staging bucket. Skip it if the account/region is already
bootstrapped.

---

## 4. Deploy

From `packages/infra`:

```bash
npx cdk deploy \
  -c adminEmail=you@yourcompany.com \
  -c cognitoDomainPrefix=ipam-yourcompany-7f3a
```

Review the IAM changes CDK prints, then confirm. The RDS instance takes
10–15 minutes on first creation.

### Deployment options

Pass any of these with `-c key=value`:

| Context key | Default | Purpose |
|-------------|---------|---------|
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
Cognito user pool     — groups: Admin, Editor, Viewer
S3 + CloudFront       — private bucket behind Origin Access Control
```

Database migrations run **automatically** as part of the deployment, via a CDK
trigger on the migration Lambda.

---

## 5. Note the outputs

CDK prints these when the deploy finishes:

```
Outputs:
ipam-stack.WebsiteUrl = https://d111111abcdef8.cloudfront.net
ipam-stack.ApiUrl = https://abc123.execute-api.eu-west-1.amazonaws.com
ipam-stack.UserPoolId = eu-west-1_XXXXXXXXX
ipam-stack.UserPoolClientId = 1a2b3c4d5e6f7g8h9i0j
ipam-stack.CognitoHostedUiDomain = https://ipam-...auth.eu-west-1.amazoncognito.com
ipam-stack.DatabaseSecretArn = arn:aws:secretsmanager:...
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
3. Click **Sign in with corporate account**, enter the email and temporary
   password, then set a permanent one (12+ characters, mixed case, digit,
   symbol).

You are in the `Admin` group, so you can edit everything and see the audit trail.

> **Email limits.** By default Cognito sends email through its own service,
> capped at 50 messages/day. For more than a handful of users, configure the
> user pool to send via Amazon SES.

---

## 7. Add your team

Only `Editor` and `Admin` can modify rows. `Viewer` is read-only.

```bash
POOL=eu-west-1_XXXXXXXXX     # UserPoolId output

# Create a user (they receive a temporary password by email)
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL" \
  --username colleague@yourcompany.com \
  --user-attributes Name=email,Value=colleague@yourcompany.com \
                    Name=email_verified,Value=true

# Grant edit rights
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$POOL" \
  --username colleague@yourcompany.com \
  --group-name Editor
```

Group names are exactly `Admin`, `Editor`, `Viewer`. To revoke editing:

```bash
aws cognito-idp admin-remove-user-from-group \
  --user-pool-id "$POOL" --username colleague@yourcompany.com --group-name Editor
```

A user with no group is treated as a Viewer. **Role changes take effect when the
user's token refreshes** — have them sign out and back in for an immediate change.

You can also do all of this in the AWS console under
**Cognito → User pools → your pool → Users / Groups**.

---

## 8. Load your spreadsheet

Two options.

### Option A — via the UI (simplest)

Generate CSVs, then upload them with the **Import CSV** button on each page:

```bash
# From the repository root
node packages/importer/dist/index.js "IP address allocation.xlsx" --dry-run   # inspect first
node packages/importer/dist/index.js "IP address allocation.xlsx" --out ./out
```

Upload `out/aws-allocations.csv` on the **AWS** page,
`out/azure-allocations.csv` on the **Azure** page,
`out/azure-subscriptions.csv` on **Subscriptions**, and
`out/subnet-plan.csv` on **Subnet plan**.

### Option B — straight to the API

```bash
ID_TOKEN=$(aws cognito-idp admin-initiate-auth \
  --user-pool-id "$POOL" \
  --client-id <UserPoolClientId> \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=you@yourcompany.com,PASSWORD='<your-password>' \
  --query 'AuthenticationResult.IdToken' --output text)

node packages/importer/dist/index.js "IP address allocation.xlsx" \
  --api https://abc123.execute-api.eu-west-1.amazonaws.com \
  --token "$ID_TOKEN"
```

Always run `--dry-run` first and check the region block counts against your
sheets. Imports are idempotent, so re-running corrects rather than duplicates.
See [packages/importer/README.md](../packages/importer/README.md) for details.

---

## 9. Updating the application

```bash
git pull
npm run build
cd packages/infra
npx cdk deploy -c adminEmail=you@yourcompany.com -c cognitoDomainPrefix=<same-prefix>
```

Always pass the **same** `cognitoDomainPrefix`, otherwise CDK will try to
replace the Cognito domain.

New `.sql` files in `packages/api/migrations/` are applied automatically on the
next deploy, in filename order. Never edit a migration that has already run —
add a new one (`002_...sql`).

---

## 10. Cost estimate

Rough monthly figures for `eu-west-1`, light internal use:

| Component | Configuration | ~USD/month |
|-----------|--------------|-----------:|
| RDS PostgreSQL | `db.t4g.micro`, 20 GiB gp3, single-AZ | 15–18 |
| Secrets Manager VPC endpoint | 1 endpoint × 2 AZs | 14 |
| Secrets Manager | 1 secret | 0.40 |
| Lambda | Well within free tier | ~0 |
| API Gateway | Well within free tier | ~0 |
| S3 + CloudFront | A few MB, low traffic | <1 |
| Cognito | Under 50 users, Plus feature plan | 0–3 |
| **Total** | | **≈ $30–37** |

Ways to trim or harden:

- **Cheaper:** set `-c useNatGateway=false` (already the default) — a NAT gateway
  would add ~$33/month. Dropping to one AZ would halve the endpoint cost but
  reduces resilience.
- **Production:** `-c dbMultiAz=true` roughly doubles the RDS line and turns on
  deletion protection.

---

## 11. Troubleshooting

**"cognitoDomainPrefix is required"** — pass both `-c adminEmail=...` and
`-c cognitoDomainPrefix=...`; the app fails fast rather than deploying something
unusable.

**Deploy fails: domain already exists** — the Cognito prefix is globally unique
across AWS. Pick another, e.g. append random characters.

**No temporary-password email** — check spam, confirm the address, and verify
you have not hit the 50/day Cognito limit. Reset with:
```bash
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" \
  --username you@yourcompany.com --password '<NewPass123!>' --permanent
```

**Signed in but every request returns 401** — the SPA sends the **ID token**. If
you built a custom client, ensure it does the same, and that `ApiUrl` in
`config.json` matches the deployed API.

**Requests return 403 "read-only access"** — the account is not in `Editor` or
`Admin`. Add the group, then sign out and back in to refresh the token.

**Grid is empty and the dashboard shows zeros** — no data imported yet (step 8).
Confirm the API is healthy:
```bash
curl https://abc123.execute-api.eu-west-1.amazonaws.com/health
```

**Migrations appear not to have run** — inspect the migration Lambda's log group
in CloudWatch (`/aws/lambda/...MigrationFunction...`). It logs the migrations
directory it used and each file applied. Re-invoke it manually if needed:
```bash
aws lambda invoke --function-name <MigrationFunctionName> /dev/stdout
```

**Rows show red CLOUD SPACE cells** — that network/mask pair is not a valid
IPv4 CIDR. The mask accepts `/16`, `16` or `255.255.0.0`; note that a
discontiguous mask such as `255.0.255.0` is correctly rejected. Fix the cell in
the UI.

**Web changes are not visible** — CloudFront caches. The deployment invalidates
`/*`, but allow a minute, then hard-reload.

---

## 12. Tearing down

```bash
cd packages/infra
npx cdk destroy
```

Deliberately retained so data is not lost silently:

- **RDS** takes a final snapshot (`RemovalPolicy.SNAPSHOT`).
- **The Cognito user pool is retained** (`RemovalPolicy.RETAIN`) — your users
  and groups survive.

Delete those manually if you truly want everything gone:

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
  never checked in or placed in environment variables.
- The S3 bucket blocks all public access; CloudFront reads it through **Origin
  Access Control**.
- Every mutation is written to the `audit_log` table with the acting user, and
  is visible to Admins on the **Audit** page.
- All write endpoints re-check the caller's group **server-side** — hiding the
  UI buttons is a convenience, not the control.

To place the app behind your own domain, add `domainNames` plus an ACM
certificate (in `us-east-1`) to the CloudFront distribution in
`packages/infra/lib/ipam-stack.ts`, and add the new URL to the Cognito client's
callback and logout URLs.
