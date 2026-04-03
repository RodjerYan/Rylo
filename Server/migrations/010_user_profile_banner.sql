-- Migration 010: add profile banner support.

ALTER TABLE users ADD COLUMN banner TEXT;
