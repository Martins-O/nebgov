# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Treasury Streams: `contracts/treasury-streams` for recurring treasury payments, created by the governor and paid out permissionlessly per whole interval, with pause, resume and cancel. Includes the SDK `TreasuryStreamsClient`, a backend executor job gated on `TREASURY_STREAMS_CONTRACT_ID`, and the `treasury_stream_failures` table (migration 014).
- Simulation: `treasury_strategies` scenario covering deposit, withdrawal cooldown, early and double claims, and over-allocation (new `tools/sim` steps for treasury strategies).
- Architecture docs: sections for the proposal-bonds, optimistic-governor, conviction-voting, treasury-strategies and signal-anchor contracts, and their events.
- Liquidity contract docs page covering pools, liquidity provision, swaps, fees, views, events, errors, and deployment order (#1399).
- Token votes wrapper docs page covering wrapping, voting power, withdrawal locks, entrypoints, events, errors, and deployment order (#1403).
- Unit tests for the optimistic governor SDK client (#1404).
- Fuzz targets for the liquidity pool, co-sponsorship drafts, and conviction voting, and a standalone `fuzz` workspace so `cargo fuzz build` works (#1387, #1391, #1392).
- Guardian council page at `/guardian` to view members, the threshold, and pending actions, and to approve, revoke, and execute them; SDK `GuardianCouncilClient` gains wallet-signing variants, `getActionTtl`, `listActions`, and the `SetActionTtl` action (#1397).
- Guardian Council SDK client with typed action encoding and CLI commands for proposing, approving, revoking, executing, and inspecting actions (#1395, #1396).
- Guardian Council contract entry in the README and `GUARDIAN_COUNCIL_ADDRESS` in the root environment template (#1394, #1398).

- Guardian Council: M-of-N multisig emergency guardian council for governance intervention (#1185)
- Conviction Voting: self-executing voting based on time-weighted conviction scores with pagination support for stake retrieval (#1175, #1174)
- Optimistic Governance: fast-track proposal execution with challenge window and objection mechanism (#1174)
- Proposal Bonds: refundable proposer bonds with slashing capability to prevent spam (#1174, #1172)
- Signal Anchor: off-chain signaling with on-chain anchoring for community sentiment gauging (#1174, #1166)
- Vote Escrow: lock history storage in bounded index, enhanced checkpoints with TTL preservation, and comprehensive getter functions (#1364, #1363)
- Voting Rewards: epoch-based reward distribution with admin rotation and duration update capabilities (#1359, #1355)
- Treasury Strategies: governance-controlled yield strategy allocation with allocation cap checking (#1180, #1178)
- Split Delegation: allow token holders to delegate voting power to multiple delegates simultaneously (#1157)
- Co-Sponsorship: joint proposal sponsorship mechanism with SDK client and test coverage (#1163, #1161)
- Deployment tooling: comprehensive Makefile build targets, verification scripts, and testnet deployment automation for all contracts (#1148, #1147)
- CLI documentation: command-line interface usage guide and voting-rewards deployment instructions (#1360)
- Documentation: PR template, SECURITY.md, CODE_OF_CONDUCT, and comprehensive architectural documentation across all modules (#1359, #1354, #1157)
- Frontend: refetch capability for Vote Escrow hooks, paginated reward epochs, and reachable Vote Escrow navigation (#1325, #1324)
- Indexer: OpenAPI documentation for treasury-strategies endpoints, CI coverage for migrations and events (#1178, #1350)
- SDK: typed error parsing for all contracts, comprehensive test coverage for clients and lifecycle flows (#1173, #1161, #1156, #1155, #1153)
- Simulation: optimistic governance scenario (propose/object/finalize/execute) and conviction voting test coverage (#1160, #1153)
- Testing: comprehensive test suites for vote-escrow, voting-rewards, treasury-strategies, proposal bonds, and SDK clients with event coverage (#1156, #1155, #1151, #1150)
- Proposal Bonds: admin-only `update_settings` (bond token, governor, refund grace, max lock) and `set_admin`, with `SettingsUpdated` / `AdminUpdated` events, `ProposalBondsClient.updateSettings` / `setAdmin`, and `nebgov proposal-bonds update-settings` / `set-admin`. Each bond keeps the token it was locked in (#1537)
- Optimistic Governor: admin (governance) `release_bond` / `slash_bond` for objected proposals, with `BondReleased` / `BondSlashed` events (#1539)
- Treasury Streams: `Stream.completed` and the `StrmCompleted` event; the indexer subscribes to the contract through `TREASURY_STREAMS_ADDRESS` (#1542)

### Changed

- Vote Escrow: reordered safety checks in withdraw, moved token transfer after state write for CEI pattern compliance (#1367)
- Vote Escrow: optimized checkpoint operations and preserved TTL for long-lived locks (#1363)
- Frontend: bonds and security navigation links now reachable, vote escrow decay copy corrected, leaderboard refetch exposed (#1293, #1295, #1298, #1304)
- Backend: paginated voting rewards endpoints with hardened error handling (#1351)
- Docker: environment variable configuration completed for all contract addresses (conviction-voting, proposal-bonds, signal-anchor, treasury-strategies, optimistic-governor) (#1167, #1159, #1158, #1154)
- Deployment: verification script now covers all recently-added contracts including optimistic-governor UI deactivation (#1149, #1147)
- Governance tuning: shared environment helpers used, guard against stale tuning recommendations (#1150)
- Signaling: results cache invalidated when poll is finalized (#1170)
- Backend: batch updates for signaling_votes voting_power computation (#1168)

### Fixed

- Optimistic Governor: cancelling an objected proposal no longer refunds its bond, so the anti-spam bond is actually at risk (#1539)
- Treasury Streams: a stream that pays its last whole interval is removed from `get_active_streams`, and the backend executor skips completed streams (#1542)
- Voting Rewards: `publish_epoch_root` finalizes the epoch even when `total_reward_amount` is 0, so an empty epoch's root can't be overwritten (#1545)
- SDK build: restore `ConvictionVotingConfig.indexerUrl` and export `VoteEscrowLock` / `VoteEscrowStats` from their defining module.
- `fuzz/timelock.rs` no longer shadows `Vec` with the Soroban type, so it compiles.

- Vote Escrow: reordered withdraw checks to prevent reentrancy, optimized checkpoints, fixed initialization accepting invalid min_lock_duration > max_lock_duration and zero max duration (#1367, #1363, #1362)
- Vote Escrow: overflow policy corrected, event tests added (#1361, #1356, #1352)
- Voting Rewards: arithmetic operations converted to checked arithmetic to prevent overflows (#1361, #1355)
- SDK: network configuration errors and VoteEscrow-specific error handling (#1366)
- Conviction Voting: unbounded Vec usage replaced with bounded storage (#1182)
- Optimistic Governor: missing events added, overflow conditions fixed, finalize/execute buttons exposed in UI (#1183, #1182)
- Proposal Bonds: missing event emission added (#1182)
- Treasury Strategies: allocation cap checking corrected, withdrawal balance drift resolved (#1180)
- Signal Anchor: retry logic fixed for anchor operations (#1183)
- Indexer: address environment variables properly passed through docker-compose for all contracts (#1179, #1177, #1159, #1158)
- Backend: contract address configuration and relayer environment variables forwarded correctly in docker-compose (#1176)
- Governance Tuning: validate positivity of delta/interval/window parameters, cover large-supply vote totals in quorum threshold calculation (#1171, #1169)
- Deployment: testnet script updated to include all new contracts, verification coverage gaps closed (#1172, #1152)
- Simulation: four cross-cutting issues resolved in documentation, verification, migration numbering, and CEI ordering (#1152)
- Frontend: LockCard component tests added, decay progress calculation fixed (#1346)

### Security

- Vote Escrow: `update_escrow_config` now checks the caller against the stored admin and panics with the new `Unauthorized` error (#1190). The SDK's `VoteEscrowErrorCode` numbering is aligned with the contract: `ArithmeticOverflow = 8`, `Unauthorized = 9`.

- XSS Protection: comprehensive input sanitization and output encoding implemented across frontend to prevent cross-site scripting attacks
- Authorization Audit: verified all invoke_contract calls have proper require_auth() checks or documented exceptions (see rust.yml audit step)
- Scout Integration: CoinFabrik Scout security scanner enabled in CI with configurable suppression support via .scout.toml

### Removed

- Test artifacts: untracked generated snapshots and coverage output (#1326)

[Unreleased]: https://github.com/nebgov/nebgov/commits/main
