CREATE TABLE IF NOT EXISTS usage_records (
  record_id   uuid PRIMARY KEY,
  customer_id text NOT NULL,
  dimension   text NOT NULL,
  quantity    numeric NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_records_customer_occurred_idx
  ON usage_records (customer_id, occurred_at DESC);
