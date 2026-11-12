-- Ledger 0.13.0 saves each module table as a CSV beside every backup: clearer
-- names for the people reading those.
ALTER TABLE file_chunks RENAME COLUMN idx TO chunk_index;
ALTER TABLE state RENAME TO email_check_state;
ALTER TABLE extractions RENAME COLUMN rows TO transactions;   -- [{date, description, amount, balance}]
