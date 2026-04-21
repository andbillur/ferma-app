-- Render PostgreSQL Migration Script
-- Run this in your PostgreSQL dashboard to fix missing columns

-- 1. Add missing columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- 2. Add missing columns to animals table  
ALTER TABLE animals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- 3. Add missing columns to milk_records table
ALTER TABLE milk_records ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE milk_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- 4. Add missing columns to expenses table
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- 5. Add missing columns to milk_sales table
ALTER TABLE milk_sales ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- 6. Add missing columns to animal_sales table
ALTER TABLE animal_sales ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- 7. Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_animals_tag_number ON animals(tag_number);
CREATE INDEX IF NOT EXISTS idx_milk_records_date ON milk_records(date);
CREATE INDEX IF NOT EXISTS idx_milk_records_animal_id ON milk_records(animal_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_milk_sales_date ON milk_sales(date);
CREATE INDEX IF NOT EXISTS idx_animal_sales_date ON animal_sales(date);
CREATE INDEX IF NOT EXISTS idx_animal_sales_animal_id ON animal_sales(animal_id);

-- 8. Update existing records
UPDATE users SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
UPDATE animals SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
UPDATE milk_records SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
UPDATE expenses SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
UPDATE milk_sales SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
UPDATE animal_sales SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
