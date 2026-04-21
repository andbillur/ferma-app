-- New Migration Script for Additional Animal Fields
-- Run this in PostgreSQL dashboard

-- Add new columns to animals table
ALTER TABLE animals ADD COLUMN IF NOT EXISTS heat_date DATE;
ALTER TABLE animals ADD COLUMN IF NOT EXISTS last_calving_date DATE;

-- Add indexes for new fields
CREATE INDEX IF NOT EXISTS idx_animals_heat_date ON animals(heat_date);
CREATE INDEX IF NOT EXISTS idx_animals_last_calving_date ON animals(last_calving_date);

-- Update existing records (optional)
UPDATE animals SET heat_date = NULL WHERE heat_date IS NULL;
UPDATE animals SET last_calving_date = NULL WHERE last_calving_date IS NULL;
