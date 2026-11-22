-- Up Migration

CREATE TABLE factory_governors (
  governor_id NUMERIC(20, 0) PRIMARY KEY,
  governor TEXT NOT NULL UNIQUE,
  timelock TEXT NOT NULL,
  token_votes TEXT NOT NULL,
  deployer TEXT NOT NULL,
  deployed_at BIGINT NOT NULL,
  ledger BIGINT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  transaction_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_factory_governors_deployer
  ON factory_governors(deployer, governor_id);
CREATE INDEX idx_factory_governors_deployed_at
  ON factory_governors(deployed_at DESC, governor_id DESC);

-- Down Migration

DROP TABLE IF EXISTS factory_governors;
