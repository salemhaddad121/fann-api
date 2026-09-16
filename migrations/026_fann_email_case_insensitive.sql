-- =============================================================
-- 026: one account per mailbox, whatever case it was typed in
--
-- findByEmail() did an exact `.where({ email })` and the column's UNIQUE
-- constraint is case-sensitive, so registering
-- AUDIT.ARTIST.X@EXAMPLE.COM after audit.artist.x@example.com returned 201
-- and created a second account. Both rows are in the database.
--
-- That is not a cosmetic duplicate. The two accounts share one inbox, so a
-- password reset, a verification link or a booking notification reaches
-- whichever of them the sender happened to look up — and "forgot password"
-- silently resets the one the user is not trying to log into.
--
-- The application side is done (users.service.ts normalises on write and
-- matches on lower(email)). This migration makes the database agree, in
-- the only order that works: normalise, then resolve what normalising
-- collides, then add the constraint.
-- =============================================================

-- ------------------------------------------------------------
-- 1. Park the losing side of every case-insensitive collision.
--
-- Run BEFORE the lowercasing below, because lowercasing a colliding pair
-- is what would raise 23505 on the existing case-sensitive unique
-- constraint.
--
-- The earliest-created row keeps the address; the others are renamed to a
-- unique parked form. Renaming rather than deleting, deliberately: a
-- duplicate may still own bookings, messages, payments or a subscription,
-- and dropping the row would cascade all of it away to tidy up an index.
-- The account survives, is reachable by id, and an admin can merge or
-- close it. It cannot be logged into by email, which is the point — that
-- address now belongs to exactly one account.
--
-- The parked form keeps the original so nothing is lost:
--   dup+<8 hex>@collision.invalid   with the original in pending_email
-- .invalid is reserved by RFC 2606 and can never be routed.
-- ------------------------------------------------------------

WITH ranked AS (
  SELECT id,
         email,
         row_number() OVER (
           PARTITION BY lower(email)
           ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM users
)
UPDATE users u
   SET email = 'dup+' || substr(replace(u.id::text, '-', ''), 1, 8) || '@collision.invalid',
       -- Keeps the address that was taken away visible to an admin
       -- resolving the duplicate. Only set when nothing else is pending.
       pending_email = COALESCE(u.pending_email, r.email)
  FROM ranked r
 WHERE r.id = u.id
   AND r.rn > 1;


-- ------------------------------------------------------------
-- 2. Normalise what is left. After step 1 no two rows can collide on
--    lower(email), so this cannot violate the existing constraint.
-- ------------------------------------------------------------

UPDATE users
   SET email = lower(email)
 WHERE email <> lower(email);

UPDATE users
   SET pending_email = lower(pending_email)
 WHERE pending_email IS NOT NULL
   AND pending_email <> lower(pending_email);


-- ------------------------------------------------------------
-- 3. The constraint that makes it stick.
--
-- A functional unique index rather than migrating the column to citext:
-- citext needs an extension this database does not have, changes the
-- comparison semantics of every existing query against the column, and
-- buys nothing the index does not. It also serves the
-- `lower(email) = ?` lookup in findByEmail(), so the case-insensitive
-- read is an index scan rather than a sequential one.
--
-- The original case-sensitive UNIQUE on email is left in place. It is
-- strictly weaker than this one and therefore harmless, and dropping a
-- constraint that other tooling may name is not worth the risk.
-- ------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));


-- ------------------------------------------------------------
-- 4. Prove it.
-- ------------------------------------------------------------

DO $$
DECLARE
  collisions integer;
BEGIN
  SELECT count(*) INTO collisions
    FROM (
      SELECT lower(email)
        FROM users
       GROUP BY lower(email)
      HAVING count(*) > 1
    ) dupes;

  IF collisions > 0 THEN
    RAISE EXCEPTION 'still % case-insensitive email collision(s) after migration', collisions;
  END IF;
END $$;
