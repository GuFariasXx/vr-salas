-- VR Salas - schema PostgreSQL
-- Executado automaticamente na inicialização (idempotente).

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(120) NOT NULL,
  email           VARCHAR(160) NOT NULL UNIQUE,
  password_hash   VARCHAR(120),
  role            VARCHAR(10)  NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  department      VARCHAR(80),
  manager_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  google_refresh_token TEXT,
  google_sub      VARCHAR(64),
  noshow_count    INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT manager_not_self CHECK (manager_id IS NULL OR manager_id <> id)
);

CREATE TABLE IF NOT EXISTS rooms (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(80) NOT NULL UNIQUE,
  location        VARCHAR(120),
  capacity        INTEGER NOT NULL DEFAULT 4 CHECK (capacity > 0),
  resources       TEXT[] NOT NULL DEFAULT '{}',
  color           VARCHAR(9) NOT NULL DEFAULT '#E8620E',
  open_time       TIME NOT NULL DEFAULT '08:00',
  close_time      TIME NOT NULL DEFAULT '18:00',
  requires_checkin BOOLEAN NOT NULL DEFAULT TRUE,
  google_resource_email VARCHAR(200),
  description     TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT room_hours CHECK (open_time < close_time)
);

CREATE TABLE IF NOT EXISTS bookings (
  id              SERIAL PRIMARY KEY,
  room_id         INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           VARCHAR(160) NOT NULL,
  description     TEXT,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  status          VARCHAR(12) NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('confirmed','checked_in','no_show','cancelled')),
  participants    TEXT[] NOT NULL DEFAULT '{}',
  series_id       UUID,
  checkin_at      TIMESTAMPTZ,
  checkin_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   VARCHAR(200),
  google_event_id VARCHAR(200),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT booking_period CHECK (starts_at < ends_at)
);

-- Impede, no próprio banco, duas reservas ativas sobrepostas na mesma sala.
DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (room_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
    WHERE (status IN ('confirmed','checked_in'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_bookings_starts ON bookings (starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_user   ON bookings (user_id, starts_at);

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(30) NOT NULL,
  title       VARCHAR(160) NOT NULL,
  message     TEXT NOT NULL,
  booking_id  INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications (user_id, read_at);

CREATE TABLE IF NOT EXISTS settings (
  key    VARCHAR(60) PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('checkin_open_before_min', '10'),   -- check-in liberado X min antes do início
  ('checkin_tolerance_min',   '15'),   -- após X min do início sem check-in => no-show
  ('max_duration_min',        '240'),
  ('max_advance_days',        '60'),
  ('reminder_before_min',     '15')    -- lembrete ao organizador antes do início
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     VARCHAR(40) NOT NULL,
  entity     VARCHAR(30) NOT NULL,
  entity_id  INTEGER,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_resets (
  token      VARCHAR(80) PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

-- Controle do job de lembrete (evita reenvio)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

-- Check-in por QR Code (token por sala, impresso na porta)
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS checkin_token VARCHAR(40);
UPDATE rooms SET checkin_token = replace(gen_random_uuid()::text, '-', '') WHERE checkin_token IS NULL;
ALTER TABLE rooms ALTER COLUMN checkin_token SET DEFAULT replace(gen_random_uuid()::text, '-', '');
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_checkin_token ON rooms (checkin_token);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checkin_method VARCHAR(10);
DELETE FROM settings WHERE key='checkin_require_qr';
-- Forma de check-in por usuário: 'both' = QR code ou botão | 'qr' = somente QR code
ALTER TABLE users ADD COLUMN IF NOT EXISTS checkin_mode VARCHAR(4) NOT NULL DEFAULT 'both';
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_checkin_mode CHECK (checkin_mode IN ('both','qr'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Sessão única por usuário: um novo login invalida as sessões anteriores do mesmo usuário
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
