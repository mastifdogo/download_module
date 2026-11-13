-- Ledger 0.13.2 gives modules file storage (ctx.storage): on the data share, per
-- organization, and in every backup folder as real files. Inbox files move
-- there; storage_path is where (e.g. "inbox/3f9c2a1b7d04/Hydro bill.pdf").
-- Files without one still have their bytes in file_chunks (older Ledger, or
-- not moved yet). Uploads still arrive in file_chunks, in pieces.
ALTER TABLE files ADD COLUMN storage_path text;
