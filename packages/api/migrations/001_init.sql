-- Cloud IPAM initial schema
-- PostgreSQL. Uses native `cidr` type so containment/overlap queries and
-- utilisation maths can be pushed into the database.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Reference / enum types
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE environment AS ENUM ('AWS', 'Azure');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE region_group AS ENUM (
    'EUROPE',
    'CAMEAT',
    'ASIA',
    'LATAM',
    'AMERICA',
    'COMPASS GROUP'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE allocation_status AS ENUM ('Available', 'Allocated', 'Assigned', 'Used');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE azure_portal_type AS ENUM ('Classic (Old Portal)', 'ARM (New Portal)');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE audit_action AS ENUM ('create', 'update', 'delete');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- cloud_allocation
--   Mirrors the AWS / Azure country allocation tables:
--   ISO | COUNTRY | CLOUD SPACE | MASK | Current Range | Remarks
--   `current_range` and `remarks` are nullable because some region blocks
--   (e.g. NORTH AMERICA) omit those columns entirely.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cloud_allocation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment   environment       NOT NULL,
  region_group  region_group      NOT NULL,
  iso           varchar(8),
  country       text,
  cloud_space   text              NOT NULL,
  mask          text              NOT NULL,
  -- Normalised from cloud_space + mask by the API layer. Nullable so rows
  -- with malformed source data can still be imported and fixed in the UI.
  cidr          cidr,
  current_range text,
  status        allocation_status NOT NULL DEFAULT 'Allocated',
  remarks       text,
  tags          jsonb             NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz       NOT NULL DEFAULT now(),
  updated_at    timestamptz       NOT NULL DEFAULT now(),
  created_by    text,
  updated_by    text
);

CREATE INDEX IF NOT EXISTS cloud_allocation_env_idx    ON cloud_allocation (environment);
CREATE INDEX IF NOT EXISTS cloud_allocation_region_idx ON cloud_allocation (region_group);
CREATE INDEX IF NOT EXISTS cloud_allocation_iso_idx    ON cloud_allocation (iso);
CREATE INDEX IF NOT EXISTS cloud_allocation_status_idx ON cloud_allocation (status);
-- GiST index enables fast containment (<<, >>) and overlap (&&) queries.
CREATE INDEX IF NOT EXISTS cloud_allocation_cidr_idx   ON cloud_allocation USING gist (cidr inet_ops);

-- Prevent accidental duplicate rows for the same block in the same env.
CREATE UNIQUE INDEX IF NOT EXISTS cloud_allocation_unique_block
  ON cloud_allocation (environment, region_group, cloud_space, mask, COALESCE(iso, ''));

-- ---------------------------------------------------------------------------
-- azure_subscription
--   Azure tabs map subscriptions to address spaces, split by portal type:
--   "Azure - Classic (Old Portal)" and "Azure - ARM (New Portal)".
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS azure_subscription (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_type   azure_portal_type NOT NULL,
  subscription  text              NOT NULL,
  address_space text              NOT NULL,
  cidr          cidr,
  region_group  region_group,
  remarks       text,
  created_at    timestamptz       NOT NULL DEFAULT now(),
  updated_at    timestamptz       NOT NULL DEFAULT now(),
  created_by    text,
  updated_by    text
);

CREATE INDEX IF NOT EXISTS azure_subscription_portal_idx ON azure_subscription (portal_type);
CREATE INDEX IF NOT EXISTS azure_subscription_name_idx   ON azure_subscription (subscription);
CREATE INDEX IF NOT EXISTS azure_subscription_cidr_idx   ON azure_subscription USING gist (cidr inet_ops);

CREATE UNIQUE INDEX IF NOT EXISTS azure_subscription_unique
  ON azure_subscription (portal_type, subscription, address_space);

-- ---------------------------------------------------------------------------
-- subnet_plan
--   The hierarchical planning tab:
--   /16 SUBNETS | /14 (255.252.0.0) | /12 (255.240.0.0) |
--   Allocation | Remarks | Current usage | Change
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subnet_plan (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subnet_16     cidr,
  agg_14        cidr,
  agg_12        cidr,
  allocation    text,
  remarks       text,
  current_usage text,
  change        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text,
  updated_by    text
);

CREATE INDEX IF NOT EXISTS subnet_plan_16_idx ON subnet_plan USING gist (subnet_16 inet_ops);
CREATE INDEX IF NOT EXISTS subnet_plan_14_idx ON subnet_plan USING gist (agg_14 inet_ops);
CREATE INDEX IF NOT EXISTS subnet_plan_12_idx ON subnet_plan USING gist (agg_12 inet_ops);

-- ---------------------------------------------------------------------------
-- audit_log
--   Every mutation is recorded with the acting user and a field-level diff.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text         NOT NULL,
  entity_id   uuid         NOT NULL,
  action      audit_action NOT NULL,
  actor       text,
  changes     jsonb,
  at          timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_at_idx     ON audit_log (at DESC);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cloud_allocation_updated_at ON cloud_allocation;
CREATE TRIGGER cloud_allocation_updated_at BEFORE UPDATE ON cloud_allocation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS azure_subscription_updated_at ON azure_subscription;
CREATE TRIGGER azure_subscription_updated_at BEFORE UPDATE ON azure_subscription
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS subnet_plan_updated_at ON subnet_plan;
CREATE TRIGGER subnet_plan_updated_at BEFORE UPDATE ON subnet_plan
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Reporting view: utilisation per allocation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW allocation_utilisation AS
SELECT
  a.id,
  a.environment,
  a.region_group,
  a.iso,
  a.country,
  a.cloud_space,
  a.mask,
  a.cidr,
  a.current_range,
  a.status,
  CASE WHEN a.cidr IS NULL THEN NULL
       ELSE 2 ^ (32 - masklen(a.cidr)) END       AS total_addresses,
  CASE WHEN a.cidr IS NULL THEN NULL
       ELSE GREATEST(2 ^ (32 - masklen(a.cidr)) - 2, 0) END AS usable_addresses
FROM cloud_allocation a;
