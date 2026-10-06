-- SPDX-License-Identifier: Apache-2.0
-- Credits ledger for pay-as-you-go. D1 (SQLite) gives atomic decrements, which
-- KV cannot — `UPDATE ... WHERE balance >= ?` either deducts fully or not at all,
-- eliminating the double-spend race.
CREATE TABLE IF NOT EXISTS credits (
  email       TEXT PRIMARY KEY,
  balance     INTEGER NOT NULL DEFAULT 0,
  lifetime    INTEGER NOT NULL DEFAULT 0,   -- total ever purchased (for display/analytics)
  updated_ms  INTEGER NOT NULL DEFAULT 0
);
