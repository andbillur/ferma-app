-- FermaApp Database Migration Script
-- Fix missing columns, constraints, and indexes

-- 1. Fix missing columns
-- Users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Animals table  
ALTER TABLE animals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Milk records table
ALTER TABLE milk_records ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE milk_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Expenses table
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Milk sales table
ALTER TABLE milk_sales ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Animal sales table
ALTER TABLE animal_sales ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- 2. Ensure constraints (should already exist from CREATE TABLE)
-- Username should be unique in users table
ALTER TABLE users ADD CONSTRAINT IF NOT EXISTS users_username_unique UNIQUE (username);
-- Tag number should be unique in animals table  
ALTER TABLE animals ADD CONSTRAINT IF NOT EXISTS animals_tag_number_unique UNIQUE (tag_number);

-- 3. Create performance indexes
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_animals_tag_number ON animals(tag_number);
CREATE INDEX IF NOT EXISTS idx_milk_records_date ON milk_records(date);
CREATE INDEX IF NOT EXISTS idx_milk_records_animal_id ON milk_records(animal_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_milk_sales_date ON milk_sales(date);
CREATE INDEX IF NOT EXISTS idx_animal_sales_date ON animal_sales(date);
CREATE INDEX IF NOT EXISTS idx_animal_sales_animal_id ON animal_sales(animal_id);

-- 4. Update existing records that don't have timestamps
UPDATE users SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
UPDATE animals SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
UPDATE milk_records SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
UPDATE expenses SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
UPDATE milk_sales SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
UPDATE animal_sales SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
