-- Up Migration

CREATE TABLE reward_epochs (
  epoch_id NUMERIC(20, 0) PRIMARY KEY,
  start_ledger BIGINT NOT NULL,
  end_ledger BIGINT NOT NULL,
  merkle_root TEXT,
  total_reward_amount NUMERIC(39, 0) NOT NULL DEFAULT 0,
  total_claimed NUMERIC(39, 0) NOT NULL DEFAULT 0,
  swept_amount NUMERIC(39, 0) NOT NULL DEFAULT 0,
  started_ledger BIGINT NOT NULL,
  root_published_ledger BIGINT,
  swept_ledger BIGINT,
  updated_ledger BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reward_epochs_end_ledger
  ON reward_epochs(end_ledger DESC, epoch_id DESC);

CREATE TABLE reward_claims (
  event_id TEXT PRIMARY KEY,
  epoch_id NUMERIC(20, 0) NOT NULL
    REFERENCES reward_epochs(epoch_id) ON DELETE CASCADE,
  claimant TEXT NOT NULL,
  amount NUMERIC(39, 0) NOT NULL,
  ledger BIGINT NOT NULL,
  transaction_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reward_claims_epoch
  ON reward_claims(epoch_id, ledger DESC, event_id DESC);
CREATE INDEX idx_reward_claims_claimant
  ON reward_claims(claimant, ledger DESC);

CREATE TABLE reward_pool_fundings (
  event_id TEXT PRIMARY KEY,
  funder TEXT NOT NULL,
  amount NUMERIC(39, 0) NOT NULL,
  ledger BIGINT NOT NULL,
  transaction_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reward_pool_fundings_ledger
  ON reward_pool_fundings(ledger DESC, event_id DESC);

-- Down Migration

DROP TABLE IF EXISTS reward_pool_fundings;
DROP TABLE IF EXISTS reward_claims;
DROP TABLE IF EXISTS reward_epochs;
