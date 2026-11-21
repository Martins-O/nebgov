-- Up Migration
--
-- Guardian council (issue #995): an M-of-N multisig standing in as governor's
-- emergency `guardian`. Actions are proposed by a member, approved by others,
-- and executed permissionlessly once the threshold is met (or expire).

CREATE TABLE IF NOT EXISTS guardian_council_actions (
  id                   SERIAL PRIMARY KEY,
  action_id            BIGINT NOT NULL,
  action_kind          TEXT NOT NULL,        -- Pause | Unpause | CancelActive | CancelQueued | RotateMember | SetThreshold | SetActionTtl
  proposal_id          BIGINT,               -- populated for CancelActive / CancelQueued
  proposer             TEXT NOT NULL,
  created_at_ledger    INT NOT NULL,
  executed             BOOLEAN NOT NULL DEFAULT FALSE,
  executed_at_ledger   INT,
  expired              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (action_id)
);

CREATE INDEX IF NOT EXISTS idx_guardian_council_actions_kind ON guardian_council_actions(action_kind);
CREATE INDEX IF NOT EXISTS idx_guardian_council_actions_created_ledger ON guardian_council_actions(created_at_ledger DESC);

CREATE TABLE IF NOT EXISTS guardian_council_approvals (
  id                SERIAL PRIMARY KEY,
  action_id         BIGINT NOT NULL,
  member            TEXT NOT NULL,
  approved          BOOLEAN NOT NULL DEFAULT TRUE,   -- FALSE once revoked
  approved_at_ledger INT NOT NULL,
  revoked_at_ledger  INT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (action_id, member)
);

CREATE INDEX IF NOT EXISTS idx_guardian_council_approvals_action ON guardian_council_approvals(action_id);

CREATE TABLE IF NOT EXISTS guardian_council_members (
  member            TEXT PRIMARY KEY,
  added_at_ledger   INT NOT NULL,
  removed_at_ledger INT,                              -- non-null once rotated out
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Down Migration

DROP TABLE IF EXISTS guardian_council_approvals;
DROP TABLE IF EXISTS guardian_council_actions;
DROP TABLE IF EXISTS guardian_council_members;
