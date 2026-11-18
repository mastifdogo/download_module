-- Import 0.22.0, the last version: Import is now part of Auto sort, and this
-- version only hands its files over. Ledger 0.26.0 lets no module keep file
-- bytes in its tables, so file_chunks goes (uploads arrived there in pieces;
-- on very old installs whole files stayed there).
--
-- Import 0.21.1 moves every complete file out of file_chunks by itself (within
-- an hour of Ledger starting, and whenever the file is opened). If one is
-- still only there, this stops before anything is changed: the update is not
-- installed and 0.21.1 keeps running, so no file is lost.
DO $$
DECLARE
    stuck      integer;
    first_id   bigint;
    first_name text;
BEGIN
    SELECT count(*) INTO stuck
      FROM files f
     WHERE f.status <> 'uploading' AND f.document_id IS NULL AND f.storage_path IS NULL
       AND EXISTS (SELECT 1 FROM file_chunks c WHERE c.file_id = f.id);
    IF stuck > 0 THEN
        SELECT f.id, f.name INTO first_id, first_name
          FROM files f
         WHERE f.status <> 'uploading' AND f.document_id IS NULL AND f.storage_path IS NULL
           AND EXISTS (SELECT 1 FROM file_chunks c WHERE c.file_id = f.id)
         ORDER BY f.id LIMIT 1;
        RAISE EXCEPTION 'Import cannot be updated to 0.22.0 yet: % still % contents only in Import''s own table (%file %, "%"). Nothing was changed and the installed Import keeps working. It moves such files into Ledger''s files by itself within an hour of Ledger starting, and at once when you open the file on the Import page. Open % there (or delete what you don''t need), then update the modules again.',
            CASE WHEN stuck = 1 THEN '1 file' ELSE stuck || ' files' END,
            CASE WHEN stuck = 1 THEN 'has its' ELSE 'have their' END,
            CASE WHEN stuck = 1 THEN '' ELSE 'the first is ' END,
            first_id, first_name,
            CASE WHEN stuck = 1 THEN 'it' ELSE 'them' END;
    END IF;
END $$;

-- Uploads that never finished: nothing complete to keep (their pieces go with them).
DELETE FROM files WHERE status = 'uploading';

DROP TABLE file_chunks;
