-- SPDX-License-Identifier: Apache-2.0
-- One row per Square payment. Square delivers several events per payment
-- (payment.created + payment.updated, plus retries); the primary key makes the
-- grant apply exactly once, and `status` lets a refund reverse it exactly once.
CREATE TABLE IF NOT EXISTS square_payments (
  payment_id  TEXT PRIMARY KEY,
  order_id    TEXT,
  email       TEXT NOT NULL,
  plan        TEXT NOT NULL,
  credits     INTEGER NOT NULL DEFAULT 0,
  amount      INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'paid',   -- paid | refunded
  created_ms  INTEGER NOT NULL,
  refunded_ms INTEGER
);
