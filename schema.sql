CREATE TABLE IF NOT EXISTS events (
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  time TEXT NOT NULL,
  PRIMARY KEY (name, time)
);
CREATE INDEX IF NOT EXISTS events_time ON events (time);
