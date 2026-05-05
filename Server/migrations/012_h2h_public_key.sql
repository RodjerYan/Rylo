-- Add public_key column for H2H encryption
ALTER TABLE users ADD COLUMN public_key TEXT;
CREATE INDEX idx_users_public_key ON users(public_key);