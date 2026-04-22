-- ===========================================================================
-- FermaApp — Migration Fix Script (v2 — with Family Tree support)
-- Run this ONCE in your Render PostgreSQL dashboard (psql or web console)
-- ===========================================================================

-- 1. FIX: milk_records price column — drop it (price belongs in milk_sales only)
ALTER TABLE milk_records DROP COLUMN IF EXISTS price;

-- 2. FIX: Add notes column to milk_records if missing
ALTER TABLE milk_records ADD COLUMN IF NOT EXISTS notes TEXT;

-- 3. FIX: Add animal columns introduced later if missing
ALTER TABLE animals ADD COLUMN IF NOT EXISTS insemination_date    DATE;
ALTER TABLE animals ADD COLUMN IF NOT EXISTS last_calving_date    DATE;
ALTER TABLE animals ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- 4. NEW: Family tree columns on animals table
--    father_id / mother_id  — direct FK refs (nullable; NULL = unknown)
--    father_unknown / mother_unknown — explicit "bought / artificial insemination"
--    acquisition_type — 'born' | 'purchased' (born on farm vs bought)
--    temp_no_milk — vaqtinchalik sut bermayapti (multi-reason: kasal, homilador, boshqa)
ALTER TABLE animals ADD COLUMN IF NOT EXISTS father_id         VARCHAR(32) REFERENCES animals(id) ON DELETE SET NULL;
ALTER TABLE animals ADD COLUMN IF NOT EXISTS mother_id         VARCHAR(32) REFERENCES animals(id) ON DELETE SET NULL;
ALTER TABLE animals ADD COLUMN IF NOT EXISTS father_unknown    BOOLEAN DEFAULT false;
ALTER TABLE animals ADD COLUMN IF NOT EXISTS mother_unknown    BOOLEAN DEFAULT false;
ALTER TABLE animals ADD COLUMN IF NOT EXISTS acquisition_type  VARCHAR(20) DEFAULT 'born';
ALTER TABLE animals ADD COLUMN IF NOT EXISTS temp_no_milk      TEXT[];    -- array: {'kasal','homilador','boshqa'}

-- 5. FIX: Add reason and weight_kg to animal_sales if missing
ALTER TABLE animal_sales ADD COLUMN IF NOT EXISTS reason    VARCHAR(30);
ALTER TABLE animal_sales ADD COLUMN IF NOT EXISTS weight_kg DECIMAL(6,2);

-- 6. NEW: password_resets table for forgot-password flow
CREATE TABLE IF NOT EXISTS password_resets (
  id         SERIAL    PRIMARY KEY,
  username   TEXT      NOT NULL,
  code       TEXT      NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used       BOOLEAN   DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Update animals whose status was set to 'soyish' (wrong) → 'soyildi' (correct)
UPDATE animals SET status = 'soyildi' WHERE status = 'soyish';

-- 8. Performance indexes (safe to re-run)
CREATE INDEX IF NOT EXISTS idx_milk_date        ON milk_records(date);
CREATE INDEX IF NOT EXISTS idx_milk_animal      ON milk_records(animal_id);
CREATE INDEX IF NOT EXISTS idx_ms_date          ON milk_sales(date);
CREATE INDEX IF NOT EXISTS idx_exp_date         ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_animal_tag       ON animals(tag_number);
CREATE INDEX IF NOT EXISTS idx_animal_status    ON animals(status);
CREATE INDEX IF NOT EXISTS idx_animal_father    ON animals(father_id);
CREATE INDEX IF NOT EXISTS idx_animal_mother    ON animals(mother_id);
CREATE INDEX IF NOT EXISTS idx_pw_reset_user    ON password_resets(username);

-- 9. Housekeeping: remove any already-expired reset codes
DELETE FROM password_resets WHERE expires_at < NOW() - INTERVAL '1 day';

-- Verify the fix worked:
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'animals'
 ORDER BY ordinal_position;

-- ===========================================================================
-- FermaApp v4 — Upgrade: Warehouse (Ombor) + Equipment (Texnika)
-- ===========================================================================

-- Warehouse items (Ombor mahsulotlari)
CREATE TABLE IF NOT EXISTS warehouse_items (
  id           VARCHAR(32)     PRIMARY KEY,
  name         TEXT            NOT NULL,
  category     VARCHAR(30)     DEFAULT 'boshqa',
  unit         VARCHAR(20)     DEFAULT 'kg',
  current_qty  DECIMAL(10,3)   DEFAULT 0,
  min_qty      DECIMAL(10,3)   DEFAULT 0,
  notes        TEXT,
  created_at   TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
);

-- Warehouse transactions (Kirim / Chiqim)
CREATE TABLE IF NOT EXISTS warehouse_transactions (
  id        VARCHAR(32)     PRIMARY KEY,
  item_id   VARCHAR(32)     REFERENCES warehouse_items(id) ON DELETE SET NULL,
  type      VARCHAR(3)      NOT NULL CHECK (type IN ('in','out')),
  qty       DECIMAL(10,3)   NOT NULL,
  date      DATE            DEFAULT CURRENT_DATE,
  price     DECIMAL(12,2)   DEFAULT 0,
  notes     TEXT,
  created_at TIMESTAMP      DEFAULT CURRENT_TIMESTAMP
);

-- Equipment / Texnika
CREATE TABLE IF NOT EXISTS equipment (
  id           VARCHAR(32)  PRIMARY KEY,
  name         TEXT         NOT NULL,
  type         VARCHAR(30)  DEFAULT 'boshqa',
  status       VARCHAR(20)  DEFAULT 'working' CHECK (status IN ('working','repair','inactive')),
  last_service DATE,
  next_service DATE,
  notes        TEXT,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for new tables
CREATE INDEX IF NOT EXISTS idx_wh_tx_item   ON warehouse_transactions(item_id);
CREATE INDEX IF NOT EXISTS idx_wh_tx_date   ON warehouse_transactions(date);
CREATE INDEX IF NOT EXISTS idx_equip_status ON equipment(status);
