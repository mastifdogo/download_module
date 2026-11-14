-- Ledger 0.19.0 has a PDF store (Documents): PDFs and PNG/JPEG scans the inbox
-- takes in are filed there, and the inbox keeps the document's id. Other
-- files (CSV, OFX, …) stay in the module's file storage (storage_path).
ALTER TABLE files ADD COLUMN document_id bigint;
-- false when the file was already in the store (someone else added it): deleting the inbox entry leaves it there.
ALTER TABLE files ADD COLUMN document_added_here boolean NOT NULL DEFAULT false;
