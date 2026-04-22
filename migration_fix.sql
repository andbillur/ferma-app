-- ===========================================================================
-- FermaApp — Migration Fix Script
-- Run this ONCE in your Render PostgreSQL dashboard (psql or web console)
-- ===========================================================================

-- 1. FIX: milk_records price column — drop it (price belongs in milk_sales only)
--    This fixes "null value in column price violates not-null constraint"
ALTER TABLE milk_records DROP COLUMN IF EXISTS price;

-- 2. FIX: Add notes column to milk_records if missing
ALTER TABLE milk_records ADD COLUMN IF NOT EXISTS notes TEXT;

-- 3. FIX: Add animal columns introduced later if missing
ALTER TABLE animals ADD COLUMN IF NOT EXISTS insemination_date DATE;
ALTER TABLE animals ADD COLUMN IF NOT EXISTS last_calving_date  DATE;
ALTER TABLE animals ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- 4. FIX: Add reason and weight_kg to animal_sales if missing
ALTER TABLE animal_sales ADD COLUMN IF NOT EXISTS reason    VARCHAR(30);
ALTER TABLE animal_sales ADD COLUMN IF NOT EXISTS weight_kg DECIMAL(6,2);

-- 5. NEW: password_resets table for forgot-password flow
CREATE TABLE IF NOT EXISTS password_resets (
  id         SERIAL    PRIMARY KEY,
  username   TEXT      NOT NULL,
  code       TEXT      NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used       BOOLEAN   DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Update animals whose status was set to 'soyish' (wrong) → 'soyildi' (correct)
UPDATE animals SET status = 'soyildi' WHERE status = 'soyish';

-- 7. Performance indexes (safe to re-run)
CREATE INDEX IF NOT EXISTS idx_milk_date       ON milk_records(date);
CREATE INDEX IF NOT EXISTS idx_milk_animal     ON milk_records(animal_id);
CREATE INDEX IF NOT EXISTS idx_ms_date         ON milk_sales(date);
CREATE INDEX IF NOT EXISTS idx_exp_date        ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_animal_tag      ON animals(tag_number);
CREATE INDEX IF NOT EXISTS idx_animal_status   ON animals(status);
CREATE INDEX IF NOT EXISTS idx_pw_reset_user   ON password_resets(username);

-- 8. Housekeeping: remove any already-expired reset codes
DELETE FROM password_resets WHERE expires_at < NOW() - INTERVAL '1 day';

-- Verify the fix worked:
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'milk_records'
 ORDER BY ordinal_position;
