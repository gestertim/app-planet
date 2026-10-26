-- Usage functions lock current account and school rows before writing reservations.
-- Column-level UPDATE is required for SELECT ... FOR SHARE; runtime roles receive none.
GRANT UPDATE (id) ON app.profiles, app.schools TO postgres;
