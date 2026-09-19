-- Cloud IPAM — revised solution model
--
-- Introduces the Master Subnet / Child Subnet hierarchy that replaces the
-- flat per-country allocation table, plus:
--   * countries linked to regions (region list revised)
--   * request tracking on every child allocation
--   * database-enforced prevention of overlapping subnets
--   * admin-definable custom columns for future use
--   * country-scoped write permissions
--
-- Any data in cloud_allocation is migrated into master_subnet before that
-- table is dropped.

-- ---------------------------------------------------------------------------
-- 1. Revised region list
--    ASIA -> APAC, AMERICA -> NORTH AMERICA, COMPASS GROUP -> GROUP.
--    Renaming preserves existing rows that already reference these values.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'region_group' AND e.enumlabel = 'ASIA'
  ) THEN
    ALTER TYPE region_group RENAME VALUE 'ASIA' TO 'APAC';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'region_group' AND e.enumlabel = 'AMERICA'
  ) THEN
    ALTER TYPE region_group RENAME VALUE 'AMERICA' TO 'NORTH AMERICA';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'region_group' AND e.enumlabel = 'COMPASS GROUP'
  ) THEN
    ALTER TYPE region_group RENAME VALUE 'COMPASS GROUP' TO 'GROUP';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. New enumerated types
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE provider_location AS ENUM (
    'AWS', 'Azure', 'GCP', 'On-prem', 'Unit', 'Branch'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE deployment_environment AS ENUM ('Prod', 'UAT', 'Dev', 'Test');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Lifecycle of a child subnet allocation.
DO $$ BEGIN
  CREATE TYPE subnet_status AS ENUM ('Reserved', 'Allocated', 'Released');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE custom_field_entity AS ENUM (
    'master_subnet', 'child_subnet', 'country'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE custom_field_type AS ENUM (
    'text', 'number', 'date', 'select', 'boolean'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 3. country — country-wise allocation, linked to a region
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS country (
  iso          varchar(8)   PRIMARY KEY,
  name         text         NOT NULL,
  region_group region_group NOT NULL,
  active       boolean      NOT NULL DEFAULT true,
  remarks      text,
  -- Values for admin-defined custom columns.
  attributes   jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  created_by   text,
  updated_by   text
);

CREATE INDEX IF NOT EXISTS country_region_idx ON country (region_group);
CREATE INDEX IF NOT EXISTS country_name_idx   ON country (name);

-- ---------------------------------------------------------------------------
-- 4. master_subnet — the parent block from which child subnets are carved
--
--    country_iso is nullable so a master can sit at region or Group level
--    rather than belonging to a single country.
--
--    The EXCLUDE constraint is the core guarantee: no two master subnets may
--    ever overlap, which combined with the containment trigger below makes
--    overlapping allocations impossible across the whole estate.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS master_subnet (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text,
  cidr              cidr              NOT NULL,
  region_group      region_group      NOT NULL,
  country_iso       varchar(8)        REFERENCES country (iso) ON DELETE RESTRICT,
  provider_location provider_location,
  description       text,
  remarks           text,
  attributes        jsonb             NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz       NOT NULL DEFAULT now(),
  updated_at        timestamptz       NOT NULL DEFAULT now(),
  created_by        text,
  updated_by        text,
  CONSTRAINT master_subnet_no_overlap EXCLUDE USING gist (cidr inet_ops WITH &&)
);

CREATE INDEX IF NOT EXISTS master_subnet_region_idx   ON master_subnet (region_group);
CREATE INDEX IF NOT EXISTS master_subnet_country_idx  ON master_subnet (country_iso);
CREATE INDEX IF NOT EXISTS master_subnet_provider_idx ON master_subnet (provider_location);

-- ---------------------------------------------------------------------------
-- 5. child_subnet — an allocation carved out of a master subnet
--
--    Released subnets are excluded from the overlap constraint so that space
--    returned to the pool can legitimately be handed out again.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS child_subnet (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_subnet_id  uuid          NOT NULL REFERENCES master_subnet (id) ON DELETE RESTRICT,
  cidr              cidr          NOT NULL,
  name              text,

  -- Request tracking
  requestor_name    text,
  request_date      date,
  allocated_date    date,
  justification     text,
  technical_owner   text,
  environment       deployment_environment,
  provider_location provider_location,
  status            subnet_status NOT NULL DEFAULT 'Reserved',

  remarks           text,
  attributes        jsonb         NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  created_by        text,
  updated_by        text,

  -- Active (non-released) child subnets may never overlap one another.
  CONSTRAINT child_subnet_no_overlap
    EXCLUDE USING gist (cidr inet_ops WITH &&) WHERE (status <> 'Released')
);

CREATE INDEX IF NOT EXISTS child_subnet_master_idx   ON child_subnet (master_subnet_id);
CREATE INDEX IF NOT EXISTS child_subnet_status_idx   ON child_subnet (status);
CREATE INDEX IF NOT EXISTS child_subnet_env_idx      ON child_subnet (environment);
CREATE INDEX IF NOT EXISTS child_subnet_provider_idx ON child_subnet (provider_location);
CREATE INDEX IF NOT EXISTS child_subnet_owner_idx    ON child_subnet (technical_owner);
CREATE INDEX IF NOT EXISTS child_subnet_cidr_idx     ON child_subnet USING gist (cidr inet_ops);

-- A child must sit entirely inside its master. Enforced by trigger because a
-- CHECK constraint cannot reference another table.
CREATE OR REPLACE FUNCTION child_subnet_within_master() RETURNS trigger AS $$
DECLARE
  parent cidr;
BEGIN
  SELECT cidr INTO parent FROM master_subnet WHERE id = NEW.master_subnet_id;

  IF parent IS NULL THEN
    RAISE EXCEPTION 'Master subnet % does not exist', NEW.master_subnet_id;
  END IF;

  IF NOT (NEW.cidr <<= parent) THEN
    RAISE EXCEPTION
      'Child subnet % is not contained within master subnet %',
      NEW.cidr, parent
      USING HINT = 'Choose a range inside the master subnet, or attach it to a different master.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS child_subnet_containment ON child_subnet;
CREATE TRIGGER child_subnet_containment
  BEFORE INSERT OR UPDATE OF cidr, master_subnet_id ON child_subnet
  FOR EACH ROW EXECUTE FUNCTION child_subnet_within_master();

-- Prevent a master from shrinking away from its existing children.
CREATE OR REPLACE FUNCTION master_subnet_still_contains_children() RETURNS trigger AS $$
DECLARE
  stray text;
BEGIN
  IF NEW.cidr = OLD.cidr THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(host(cidr) || '/' || masklen(cidr), ', ')
    INTO stray
    FROM child_subnet
   WHERE master_subnet_id = NEW.id AND NOT (cidr <<= NEW.cidr);

  IF stray IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot change master subnet to % — these child subnets would fall outside it: %',
      NEW.cidr, stray;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS master_subnet_contains_children ON master_subnet;
CREATE TRIGGER master_subnet_contains_children
  BEFORE UPDATE OF cidr ON master_subnet
  FOR EACH ROW EXECUTE FUNCTION master_subnet_still_contains_children();

-- ---------------------------------------------------------------------------
-- 6. custom_field — admin-defined extra columns, for future use
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS custom_field (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity     custom_field_entity NOT NULL,
  field_key  text                NOT NULL,
  label      text                NOT NULL,
  data_type  custom_field_type   NOT NULL DEFAULT 'text',
  -- Permitted values when data_type = 'select'.
  options    text[]              NOT NULL DEFAULT '{}',
  position   integer             NOT NULL DEFAULT 0,
  required   boolean             NOT NULL DEFAULT false,
  active     boolean             NOT NULL DEFAULT true,
  help_text  text,
  created_at timestamptz         NOT NULL DEFAULT now(),
  updated_at timestamptz         NOT NULL DEFAULT now(),
  created_by text,
  updated_by text,
  CONSTRAINT custom_field_key_format
    CHECK (field_key ~ '^[a-z][a-z0-9_]{0,48}$'),
  CONSTRAINT custom_field_unique_key UNIQUE (entity, field_key)
);

CREATE INDEX IF NOT EXISTS custom_field_entity_idx ON custom_field (entity, position);

-- ---------------------------------------------------------------------------
-- 7. country_owner — grants write access over one country's data
--
--    A user listed here may modify master and child subnets belonging to that
--    country only. Global authors and admins are governed by Cognito groups
--    and do not need rows here.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS country_owner (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored lower-cased; the API normalises before writing.
  user_email  text        NOT NULL,
  country_iso varchar(8)  NOT NULL REFERENCES country (iso) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  CONSTRAINT country_owner_unique UNIQUE (user_email, country_iso)
);

CREATE INDEX IF NOT EXISTS country_owner_email_idx ON country_owner (user_email);

-- ---------------------------------------------------------------------------
-- 8. Widen audit_log.entity_id
--
--    It was uuid, but `country` is keyed by its ISO code rather than a uuid.
--    Text accommodates every entity's key type.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name  = 'audit_log'
       AND column_name = 'entity_id'
       AND data_type   = 'uuid'
  ) THEN
    ALTER TABLE audit_log ALTER COLUMN entity_id TYPE text USING entity_id::text;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 9. updated_at triggers for the new tables
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS country_updated_at ON country;
CREATE TRIGGER country_updated_at BEFORE UPDATE ON country
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS master_subnet_updated_at ON master_subnet;
CREATE TRIGGER master_subnet_updated_at BEFORE UPDATE ON master_subnet
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS child_subnet_updated_at ON child_subnet;
CREATE TRIGGER child_subnet_updated_at BEFORE UPDATE ON child_subnet
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS custom_field_updated_at ON custom_field;
CREATE TRIGGER custom_field_updated_at BEFORE UPDATE ON custom_field
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 10. Utilisation reporting
--
--    Allocated / available counts are derived rather than stored, so they can
--    never drift from the underlying child subnets.
--    "Reserved" and "Allocated" both consume space; "Released" does not.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW master_subnet_utilisation AS
SELECT
  m.id,
  m.name,
  host(m.cidr) || '/' || masklen(m.cidr)              AS cidr,
  m.region_group,
  m.country_iso,
  c.name                                              AS country_name,
  m.provider_location,
  masklen(m.cidr)                                     AS prefix_length,
  (2::numeric ^ (32 - masklen(m.cidr)))::bigint       AS total_addresses,
  GREATEST((2::numeric ^ (32 - masklen(m.cidr))) - 2, 0)::bigint AS usable_hosts,
  COALESCE(SUM(
    CASE WHEN ch.status <> 'Released'
         THEN (2::numeric ^ (32 - masklen(ch.cidr)))
         ELSE 0 END
  ), 0)::bigint                                       AS allocated_addresses,
  ((2::numeric ^ (32 - masklen(m.cidr))) - COALESCE(SUM(
    CASE WHEN ch.status <> 'Released'
         THEN (2::numeric ^ (32 - masklen(ch.cidr)))
         ELSE 0 END
  ), 0))::bigint                                      AS available_addresses,
  COUNT(ch.id) FILTER (WHERE ch.status = 'Allocated')  AS allocated_children,
  COUNT(ch.id) FILTER (WHERE ch.status = 'Reserved')   AS reserved_children,
  COUNT(ch.id) FILTER (WHERE ch.status = 'Released')   AS released_children,
  COUNT(ch.id)                                         AS total_children
FROM master_subnet m
LEFT JOIN country c      ON c.iso = m.country_iso
LEFT JOIN child_subnet ch ON ch.master_subnet_id = m.id
GROUP BY m.id, m.name, m.cidr, m.region_group, m.country_iso, c.name,
         m.provider_location;

-- ---------------------------------------------------------------------------
-- 11. Migrate cloud_allocation into the new model, then retire it
--
--     Rows are inserted individually so that a row which would violate the
--     new no-overlap guarantee is reported and skipped rather than aborting
--     the whole migration. Rows with an unparseable CIDR are skipped too.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  rec       record;
  migrated  integer := 0;
  skipped   integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'cloud_allocation'
  ) THEN
    RAISE NOTICE 'cloud_allocation does not exist; nothing to migrate.';
    RETURN;
  END IF;

  -- Countries referenced by existing allocations.
  INSERT INTO country (iso, name, region_group, created_by, updated_by)
  SELECT DISTINCT ON (upper(a.iso))
         upper(a.iso),
         COALESCE(NULLIF(a.country, ''), upper(a.iso)),
         a.region_group,
         'migration-002',
         'migration-002'
    FROM cloud_allocation a
   WHERE a.iso IS NOT NULL AND a.iso <> ''
   ORDER BY upper(a.iso), a.country NULLS LAST
  ON CONFLICT (iso) DO NOTHING;

  FOR rec IN
    SELECT a.id, a.environment, a.region_group, a.iso, a.country,
           a.cidr, a.remarks, a.created_by, a.updated_by
      FROM cloud_allocation a
     WHERE a.cidr IS NOT NULL
     ORDER BY a.cidr
  LOOP
    BEGIN
      INSERT INTO master_subnet (
        name, cidr, region_group, country_iso, provider_location,
        description, remarks, created_by, updated_by
      ) VALUES (
        COALESCE(NULLIF(rec.country, ''), host(rec.cidr) || '/' || masklen(rec.cidr)),
        rec.cidr,
        rec.region_group,
        NULLIF(upper(rec.iso), ''),
        CASE rec.environment::text WHEN 'AWS' THEN 'AWS'::provider_location
                                   WHEN 'Azure' THEN 'Azure'::provider_location
                                   ELSE NULL END,
        'Migrated from the original allocation spreadsheet.',
        rec.remarks,
        COALESCE(rec.created_by, 'migration-002'),
        COALESCE(rec.updated_by, 'migration-002')
      );
      migrated := migrated + 1;
    EXCEPTION
      WHEN exclusion_violation THEN
        skipped := skipped + 1;
        RAISE NOTICE
          'Skipped overlapping allocation % (%) — already covered by another master subnet.',
          rec.cidr, COALESCE(rec.country, rec.iso);
      WHEN foreign_key_violation THEN
        skipped := skipped + 1;
        RAISE NOTICE 'Skipped allocation % — unknown country %.', rec.cidr, rec.iso;
    END;
  END LOOP;

  RAISE NOTICE 'Migrated % master subnet(s); skipped %.', migrated, skipped;
END $$;

-- The flat allocation table is superseded by master_subnet / child_subnet.
DROP VIEW IF EXISTS allocation_utilisation;
DROP TABLE IF EXISTS cloud_allocation;
