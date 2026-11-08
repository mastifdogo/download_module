-- Ledger 0.11.0: files handed to another module through ctx.files. The id of
-- that hand-off lets the inbox show the receiving module's status and result.
ALTER TABLE files ADD COLUMN sent_file_id bigint;
