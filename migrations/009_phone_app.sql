-- Receipts sent by the phone app (the Android companion app): their own
-- origin, and the account the person chose on the phone for the receipt.
ALTER TABLE files DROP CONSTRAINT files_origin_check;
ALTER TABLE files ADD CONSTRAINT files_origin_check
    CHECK (origin IN ('', 'email', 'scanner', 'camera', 'upload', 'app'));
-- Named account_code so Ledger keeps it right when an account is renumbered.
ALTER TABLE files ADD COLUMN account_code text NOT NULL DEFAULT '';
