BEGIN;

CREATE OR REPLACE FUNCTION app.canonical_project_file_path(p_path text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog
AS $function$
  SELECT p_path ~ '^[A-Za-z0-9._/-]+$'
    AND octet_length(p_path) <= 512
    AND left(p_path, 1) <> '/'
    AND position('//' in p_path) = 0
    AND position(E'\\' in p_path) = 0
    AND position('%' in p_path) = 0
    AND p_path !~ '(^|/)\.\.?(/|$)'
    AND upper(p_path) !~ '(^|/)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|/|$)'
    AND p_path !~ '(^|/)[^/]*[. ](/|$)'
    AND (p_path LIKE '%.html' OR p_path LIKE '%.css' OR p_path LIKE '%.js')
$function$;

DO $migration$
DECLARE
  v_project_files bigint;
  v_snapshot_files bigint;
BEGIN
  SELECT count(*) INTO v_project_files
  FROM app.project_files WHERE NOT app.canonical_project_file_path(path);
  SELECT count(*) INTO v_snapshot_files
  FROM app.snapshot_files WHERE NOT app.canonical_project_file_path(path);
  IF v_project_files > 0 OR v_snapshot_files > 0 THEN
    RAISE EXCEPTION
      '0042 migration blocked: % project file paths and % snapshot file paths violate canonical rules',
      v_project_files, v_snapshot_files;
  END IF;
END
$migration$;

ALTER TABLE app.project_files DROP CONSTRAINT project_files_canonical_path;
ALTER TABLE app.project_files ADD CONSTRAINT project_files_canonical_path
  CHECK (app.canonical_project_file_path(path)) NOT VALID;
ALTER TABLE app.project_files VALIDATE CONSTRAINT project_files_canonical_path;

ALTER TABLE app.snapshot_files DROP CONSTRAINT snapshot_files_canonical_path;
ALTER TABLE app.snapshot_files ADD CONSTRAINT snapshot_files_canonical_path
  CHECK (app.canonical_project_file_path(path)) NOT VALID;
ALTER TABLE app.snapshot_files VALIDATE CONSTRAINT snapshot_files_canonical_path;

COMMIT;
