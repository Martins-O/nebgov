# NebGov Indexer

The NebGov indexer is a service that consumes on-chain governance events from the Stellar network and stores them in a PostgreSQL database. It exposes a REST API and WebSocket endpoint for historical governance analytics, enabling real-time tracking of proposals, votes, delegations, and other governance activities.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Event Flow](#event-flow)
- [Local Development Setup](#local-development-setup)
- [Docker Setup](#docker-setup)
- [Configuration](#configuration)
- [Event Types](#event-types)
- [Database Schema](#database-schema)
- [API Endpoints](#api-endpoints)
- [WebSocket Events](#websocket-events)
- [Monitoring](#monitoring)
- [Testing](#testing)

## Overview

The indexer performs the following functions:

- **Event Streaming**: Continuously polls the Stellar Soroban RPC for new governance events from the governor contract and related contracts (wrapper, treasury, liquidity)
- **Proposal State Tracking**: Maintains up-to-date state of all proposals including vote tallies, execution status, and cancellation status
- **Notification Triggers**: Broadcasts real-time events via WebSocket to connected clients
- **Historical Analytics**: Provides REST API endpoints for querying governance data with pagination and filtering

## Architecture

```mermaid
graph TB
    A[Stellar Network] -->|Soroban RPC| B[Indexer Service]
    B -->|Poll Events| A
    B -->|Store/Query| C[PostgreSQL Database]
    B -->|REST API| D[Backend/Frontend]
    B -->|WebSocket| E[Real-time Clients]
    
    subgraph "Indexer Components"
        B1[Event Processor]
        B2[REST API Server]
        B3[WebSocket Server]
        B4[Cache Layer]
    end
    
    B --> B1
    B --> B2
    B --> B3
    B --> B4
```

### Key Components

- **Event Processor** (`src/events.ts`): Fetches events from Stellar RPC, processes them based on event type, and updates the database
- **REST API Server** (`src/api.ts`): Express server providing HTTP endpoints for querying governance data
- **WebSocket Server** (`src/ws.ts`): Real-time event broadcasting to connected clients
- **Cache Layer** (`src/cache.ts`): In-memory caching for frequently accessed data
- **Database Layer** (`src/db.ts`): PostgreSQL connection and migration management

## Event Flow

```mermaid
sequenceDiagram
    participant S as Stellar Network
    participant I as Indexer
    participant D as PostgreSQL
    participant C as WebSocket Clients

    I->>S: Poll for events (every 5s)
    S-->>I: Return events batch
    loop For each event
        I->>I: Parse event type & data
        I->>D: Insert/update records
        I->>I: Invalidate cache
        I->>C: Broadcast via WebSocket
    end
    I->>D: Update last indexed ledger
```

## Local Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9.0.0+
- PostgreSQL 16+

### Step 1: Install Dependencies

```bash
# From repository root
pnpm install
```

### Step 2: Set Up Database

```bash
# Start PostgreSQL (using Docker or local installation)
docker run --name nebgov-postgres \
  -e POSTGRES_USER=nebgov \
  -e POSTGRES_PASSWORD=nebgov \
  -e POSTGRES_DB=nebgov \
  -p 5432:5432 \
  -d postgres:16-alpine
```

### Step 3: Configure Environment Variables

Create a `.env` file in `packages/indexer/`:

```bash
cd packages/indexer
cp .env.example .env
```

Edit `.env` with your configuration:

```env
DATABASE_URL=postgres://nebgov:nebgov@localhost:5432/nebgov
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
GOVERNOR_ADDRESS=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TIMELOCK_ADDRESS=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
WRAPPER_ADDRESS=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TREASURY_ADDRESS=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TREASURY_SIMULATION_ACCOUNT=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
LIQUIDITY_ADDRESS=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
POLL_INTERVAL_MS=5000
PORT=3001
HEALTH_LAG_THRESHOLD=100
```

### Step 4: Run Database Migrations

```bash
pnpm --filter @nebgov/indexer run migrate
```

To rollback migrations:

```bash
pnpm --filter @nebgov/indexer run migrate:down
```

### Step 5: Start the Indexer

```bash
pnpm --filter @nebgov/indexer run dev
```

The indexer will:
1. Connect to PostgreSQL and run migrations
2. Start the REST API on port 3001
3. Start the WebSocket server on `ws://localhost:3001/events`
4. Begin polling the Stellar network for events

### Step 6: Verify Health

```bash
curl http://localhost:3001/health
```

Expected response:

```json
{
  "status": "ok",
  "last_indexed_ledger": 12345,
  "current_ledger": 12350,
  "lag_ledgers": 5,
  "lag_seconds": 25,
  "total_proposals_indexed": 42,
  "total_votes_indexed": 1337,
  "total_delegates_indexed": 15,
  "uptime_seconds": 120,
  "timestamp": "2026-06-29T12:00:00.000Z"
}
```

## Docker Setup

### Using Docker Compose

The easiest way to run the full stack is with Docker Compose:

```bash
cd packages/indexer
docker-compose up -d
```

This will:
- Start PostgreSQL 16 on port 5432
- Build and start the indexer service on port 3001
- Automatically run database migrations
- Configure health checks

### Manual Docker Build

```bash
# Build the image
docker build -f packages/indexer/Dockerfile -t nebgov-indexer:latest .

# Run with environment file
docker run --env-file packages/indexer/.env \
  -p 3001:3001 \
  --network host \
  nebgov-indexer:latest
```

### Docker Compose Services

- **postgres**: PostgreSQL 16 database with health checks
- **indexer**: Multi-stage build with TypeScript compilation, runs the compiled Node.js application

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgres://nebgov:nebgov@localhost:5432/nebgov` | PostgreSQL connection string |
| `STELLAR_RPC_URL` | Yes | `https://soroban-testnet.stellar.org` | Stellar Soroban RPC endpoint |
| `GOVERNOR_ADDRESS` | Yes | - | Stellar contract address of the governor |
| `GOVERNOR_FACTORY_ADDRESS` | No | - | Governor-factory address; falls back to `FACTORY_ADDRESS` when set by the deployment scripts |
| `TIMELOCK_ADDRESS` | No | - | Stellar contract address of the timelock |
| `WRAPPER_ADDRESS` | No | - | Stellar contract address of the token wrapper |
| `TOKEN_VOTES_ADDRESS` | No | - | Stellar contract address of the token-votes contract (delegation registry events) |
| `TREASURY_ADDRESS` | No | - | Stellar contract address of the treasury |
| `TREASURY_SIMULATION_ACCOUNT` | When treasury is set | - | Funded Stellar account used to simulate treasury read calls for stream hydration |
| `LIQUIDITY_ADDRESS` | No | - | Stellar contract address of the liquidity pool |
| `SIGNAL_ANCHOR_ADDRESS` | No | - | Stellar contract address of the gasless-signaling result anchor |
| `TREASURY_STRATEGIES_ADDRESS` | No | - | Stellar contract address of the treasury yield-strategy allocator |
| `OPTIMISTIC_GOVERNOR_ADDRESS` | No | - | Stellar contract address of the optimistic-governance track |
| `VOTE_ESCROW_ADDRESS` | No | - | Stellar contract address of the vote-escrow contract (lock create, increase and withdraw events) |
| `GUARDIAN_COUNCIL_ADDRESS` | No | - | Stellar contract address of the guardian council (action proposals, approvals, membership rotations) |
| `VOTING_REWARDS_ADDRESS` | No | - | Stellar contract address of the voting-rewards contract (not indexed yet; kept in sync with the root `.env.example`) |
| `STELLAR_NETWORK_PASSPHRASE` | No | Testnet passphrase | Network passphrase used for treasury read simulations |
| `POLL_INTERVAL_MS` | No | `5000` | Milliseconds between event polling cycles |
| `PORT` | No | `3001` | HTTP server port |
| `HEALTH_LAG_THRESHOLD` | No | `100` | Ledger lag threshold for health check (ledgers) |

### Example .env File

```env
# Database
DATABASE_URL=postgres://nebgov:nebgov@localhost:5432/nebgov

# Stellar Network
STELLAR_RPC_URL=https://soroban-testnet.stellar.org

# Contract Addresses
GOVERNOR_ADDRESS=CDLZFC3SYJYDZT7S64ZDSBLDV4G6N7JPPG2RLFHRXVJMPWI33YCH4HVD
TIMELOCK_ADDRESS=CCTIMELOCKZ3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3
WRAPPER_ADDRESS=CA3D5KRYM6CB7OQ4O5K3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3
TOKEN_VOTES_ADDRESS=CBTOKENVOTESZ3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3
TREASURY_ADDRESS=CB3D5KRYM6CB7OQ4O5K3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3
LIQUIDITY_ADDRESS=CC3D5KRYM6CB7OQ4O5K3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3
SIGNAL_ANCHOR_ADDRESS=CDSIGNALANCHORZ3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3
TREASURY_STRATEGIES_ADDRESS=CETREASURYSTRATEGIESZ3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3
OPTIMISTIC_GOVERNOR_ADDRESS=CFOPTIMISTICGOVZ3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3
VOTE_ESCROW_ADDRESS=CVOTEESCROWZ3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3
GUARDIAN_COUNCIL_ADDRESS=CGUARDIANCOUNZ3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3

# Indexer Configuration
POLL_INTERVAL_MS=5000
PORT=3001
HEALTH_LAG_THRESHOLD=100
```

## Event Types

The indexer processes events from multiple contracts. Event topics are normalized to handle both legacy short-symbol formats (e.g., `prop_crtd`) and newer PascalCase formats (e.g., `ProposalCreated`).

### Governor Contract Events

| Event Type | Legacy Topic | Description | Database Table |
|------------|--------------|-------------|----------------|
| `ProposalCreated` | `prop_crtd` | New proposal created | `proposals` |
| `VoteCast` | `vote` | Vote cast without reason | `votes` |
| `VoteCastWithReason` | `vote_rsn` | Vote cast with reason | `votes` |
| `ProposalQueued` | `queued` | Proposal queued for execution | `proposals` |
| `ProposalExecuted` | `executed` | Proposal executed successfully | `proposals` |
| `ProposalCancelled` | `cancelled` | Proposal cancelled | `proposals`, `proposal_cancellations` |
| `DelegateChanged` | `delegate`, `del_chsh` | Voting delegation changed | `delegates` |
| `ConfigUpdated` | `config_updated` | Governor configuration updated | `config_updates` |
| `GovernorUpgraded` | `upgraded` | Governor contract upgraded | `governor_upgrades` |

### Wrapper Contract Events

| Event Type | Legacy Topic | Description | Database Table |
|------------|--------------|-------------|----------------|
| `Deposit` | `deposit` | Tokens deposited into wrapper | `wrapper_deposits` |
| `Withdraw` | `withdraw` | Tokens withdrawn from wrapper | `wrapper_withdrawals` |
| `DelegateChanged` | `DelegateChanged` | Delegation via wrapper | `delegates` |

### Treasury Contract Events

| Event Type | Legacy Topic | Description | Database Table |
|------------|--------------|-------------|----------------|
| `BatchTransfer` | `bat_xfer` | Batch transfer executed | `treasury_transfers` |

### Liquidity Contract Events

| Event Type | Description | Database Table |
|------------|-------------|----------------|
| `LiquidityAdded` | Liquidity added to pool | `liquidity_events` |
| `LiquidityRemoved` | Liquidity removed from pool | `liquidity_events` |
| `Swap` | Token swap executed | `swap_events` |
| `PoolFeeUpdated` | Pool fee updated | `pool_fee_updates` |

### Event Schemas

#### ProposalCreated

**Topics**: `[event_type, proposer]`  
**Value**: 
- Legacy: `[proposal_id, description, ..., start_ledger, end_ledger]`
- New: `{ proposal_id, proposer, description, start_ledger, end_ledger }`

#### VoteCast / VoteCastWithReason

**Topics**: `[event_type, voter]`  
**Value**: `[proposal_id, support, reason?, weight]`

- `support`: 1 = for, 0 = against, 2 = abstain
- `reason`: Optional string (only for VoteCastWithReason)

#### ProposalQueued

**Topics**: `[event_type, proposal_id]`

#### ProposalExecuted

**Topics**: `[event_type, proposal_id]`

#### ProposalCancelled

**Topics**: `[event_type, caller]`  
**Value**: `[proposal_id, queue_time, current_ledger]` or `{ proposal_id, caller }`

#### DelegateChanged

**Topics**: `[event_type, delegator]`  
**Value**: `[old_delegatee, new_delegatee]`

#### ConfigUpdated

**Value**: `{ old_settings, new_settings }`

Settings include:
- `voting_delay`: Number of ledgers to wait before voting starts
- `voting_period`: Number of ledgers for voting period
- `quorum_numerator`: Quorum threshold numerator
- `proposal_threshold`: Minimum voting power to propose
- `guardian`: Guardian address
- `proposal_grace_period`: Grace period after voting ends
- `use_dynamic_quorum`: Whether dynamic quorum is enabled
- `reflector_oracle`: Oracle address for dynamic quorum
- `min_quorum_usd`: Minimum quorum in USD
- `max_calldata_size`: Maximum calldata size
- `proposal_cooldown`: Cooldown between proposals
- `max_proposals_per_period`: Max proposals per period
- `proposal_period_duration`: Duration of proposal period

#### GovernorUpgraded

**Value**: `{ new_hash }`

#### Wrapper Deposit/Withdraw

**Topics**: `[event_type, account]`  
**Value**: `[_, amount]`

#### Treasury BatchTransfer

**Topics**: `[event_type, token_address]`  
**Value**: `[op_hash, recipient_count, total_amount]`

## Database Schema

### Tables

#### proposals

Stores proposal metadata and vote tallies.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGINT | Proposal ID (primary key) |
| `proposer` | TEXT | Proposer's Stellar address |
| `description` | TEXT | Proposal description |
| `start_ledger` | INT | Ledger when voting starts |
| `end_ledger` | INT | Ledger when voting ends |
| `votes_for` | BIGINT | Total votes for (default 0) |
| `votes_against` | BIGINT | Total votes against (default 0) |
| `votes_abstain` | BIGINT | Total votes abstain (default 0) |
| `executed` | BOOLEAN | Whether proposal was executed |
| `cancelled` | BOOLEAN | Whether proposal was cancelled |
| `queued` | BOOLEAN | Whether proposal is queued |
| `created_at` | TIMESTAMP | Record creation time |

**Indexes**: `created_at DESC`, `proposer`

#### votes

Stores individual votes on proposals.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Vote ID (primary key) |
| `proposal_id` | BIGINT | Reference to proposal (foreign key) |
| `voter` | TEXT | Voter's Stellar address |
| `support` | SMALLINT | Vote: 1=for, 0=against, 2=abstain |
| `weight` | BIGINT | Voting power used |
| `reason` | TEXT | Optional vote reason |
| `ledger` | INT | Ledger when vote was cast |
| `created_at` | TIMESTAMP | Record creation time |

**Indexes**: `proposal_id`, `voter`

**Unique Constraint**: `(proposal_id, voter)`

#### delegates

Stores delegation history.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Delegation ID (primary key) |
| `delegator` | TEXT | Delegator's address |
| `old_delegatee` | TEXT | Previous delegatee |
| `new_delegatee` | TEXT | New delegatee |
| `ledger` | INT | Ledger when delegation changed |
| `created_at` | TIMESTAMP | Record creation time |

**Indexes**: `delegator`, `ledger DESC`, `new_delegatee`

#### wrapper_deposits

Stores token wrapper deposits.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Deposit ID (primary key) |
| `account` | TEXT | Account address |
| `amount` | BIGINT | Deposit amount |
| `ledger` | INT | Ledger when deposit occurred |
| `created_at` | TIMESTAMPTZ | Record creation time |

**Indexes**: `account`

#### wrapper_withdrawals

Stores token wrapper withdrawals.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Withdrawal ID (primary key) |
| `account` | TEXT | Account address |
| `amount` | BIGINT | Withdrawal amount |
| `ledger` | INT | Ledger when withdrawal occurred |
| `created_at` | TIMESTAMPTZ | Record creation time |

**Indexes**: `account`

#### treasury_transfers

Stores treasury batch transfers.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Transfer ID (primary key) |
| `op_hash` | TEXT | Operation hash (unique) |
| `token` | TEXT | Token address |
| `recipient_count` | INT | Number of recipients |
| `total_amount` | BIGINT | Total amount transferred |
| `ledger` | INT | Ledger when transfer occurred |
| `created_at` | TIMESTAMPTZ | Record creation time |

#### config_updates

Stores governor configuration changes.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Update ID (primary key) |
| `ledger` | INT | Ledger when config changed |
| `old_settings` | JSONB | Previous configuration |
| `new_settings` | JSONB | New configuration |
| `ledger_closed_at` | TIMESTAMPTZ | Ledger close time |
| `created_at` | TIMESTAMPTZ | Record creation time |

**Indexes**: `ledger DESC`, `ledger_closed_at DESC`

#### governor_upgrades

Stores governor contract upgrades.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Upgrade ID (primary key) |
| `ledger` | INT | Ledger when upgrade occurred |
| `new_wasm_hash` | TEXT | New WASM hash |
| `created_at` | TIMESTAMPTZ | Record creation time |

**Indexes**: `ledger DESC`

#### proposal_cancellations

Stores proposal cancellation details.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Cancellation ID (primary key) |
| `proposal_id` | BIGINT | Reference to proposal (foreign key) |
| `cancelled_at_ledger` | INT | Ledger when cancelled |
| `caller` | TEXT | Address that cancelled |
| `created_at` | TIMESTAMPTZ | Record creation time |

**Indexes**: `cancelled_at_ledger DESC`, `caller`

#### indexer_state

Stores indexer state for resumption.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INT | Always 1 (primary key) |
| `last_ledger` | INT | Last indexed ledger |

**Initial State**: `(1, 0)`

#### liquidity_events

Stores liquidity pool events.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Event ID (primary key) |
| `event_type` | TEXT | 'add' or 'remove' |
| `provider` | TEXT | Provider address |
| `outcome_a` | INT | Outcome A identifier |
| `outcome_b` | INT | Outcome B identifier |
| `amount_a` | BIGINT | Amount of token A |
| `amount_b` | BIGINT | Amount of token B |
| `lp_tokens` | BIGINT | LP tokens minted/burned |
| `ledger` | INT | Ledger when event occurred |

#### swap_events

Stores swap events.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Event ID (primary key) |
| `trader` | TEXT | Trader address |
| `outcome_in` | INT | Input outcome identifier |
| `outcome_out` | INT | Output outcome identifier |
| `amount_in` | BIGINT | Input amount |
| `amount_out` | BIGINT | Output amount |
| `fee` | BIGINT | Swap fee |
| `ledger` | INT | Ledger when swap occurred |

#### pool_fee_updates

Stores pool fee changes.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Update ID (primary key) |
| `outcome_a` | INT | Outcome A identifier |
| `outcome_b` | INT | Outcome B identifier |
| `old_fee_bps` | INT | Old fee in basis points |
| `new_fee_bps` | INT | New fee in basis points |
| `ledger` | INT | Ledger when fee changed |

## API Endpoints

### Health & Stats

#### GET /health

Returns health status and indexing progress.

**Response**:
```json
{
  "status": "ok" | "degraded",
  "last_indexed_ledger": 12345,
  "current_ledger": 12350,
  "lag_ledgers": 5,
  "lag_seconds": 25,
  "total_proposals_indexed": 42,
  "total_votes_indexed": 1337,
  "total_delegates_indexed": 15,
  "uptime_seconds": 120,
  "timestamp": "2026-06-29T12:00:00.000Z"
}
```

**Status**: `ok` if lag ≤ `HEALTH_LAG_THRESHOLD`, otherwise `degraded`

#### GET /stats

Returns aggregate governance statistics.

**Response**:
```json
{
  "total_proposals": 42,
  "active_proposals": 5,
  "total_votes_cast": 1337,
  "unique_voters": 128,
  "total_delegates": 15,
  "participation_rate": 0.85,
  "last_updated": "2026-06-29T12:00:00.000Z"
}
```

### Governor Factory

#### GET /factory/governors

List indexed DAO deployments. Use `deployer` to filter by the address that
deployed them. `limit` defaults to 20 and is capped at 100; `offset` defaults
to 0.

### Proposals

#### GET /proposals

List proposals with pagination and filtering.

**Query Parameters**:
- `limit`: Number of results (default 20, max 100)
- `offset`: Offset for pagination (default 0)
- `before`: Cursor pagination - show proposals with ID < this value
- `after`: Cursor pagination - show proposals with ID > this value
- `page`: Page number for page-based pagination (1-indexed)
- `state`: Filter by state (`Active`, `Pending`, `Succeeded`, `Defeated`, `Queued`, `Executed`, `Cancelled`)
- `proposer`: Filter by proposer address
- `current_ledger`: Current ledger for state filtering

**Response (offset pagination)**:
```json
{
  "proposals": [...],
  "total": 42
}
```

**Response (cursor pagination)**:
```json
{
  "proposals": [...],
  "nextCursor": 10,
  "prevCursor": 20,
  "hasMore": true
}
```

#### GET /proposals/:id

Get a single proposal by ID.

**Response**:
```json
{
  "id": 1,
  "proposer": "G...",
  "description": "...",
  "start_ledger": 1000,
  "end_ledger": 2000,
  "votes_for": "1000000",
  "votes_against": "500000",
  "votes_abstain": "100000",
  "executed": false,
  "cancelled": false,
  "queued": false,
  "created_at": "2026-06-29T12:00:00.000Z"
}
```

#### GET /proposals/:id/votes

Get votes for a specific proposal.

**Response**:
```json
{
  "votes": [
    {
      "id": 1,
      "proposal_id": 1,
      "voter": "G...",
      "support": 1,
      "weight": "1000000",
      "reason": "Good proposal",
      "ledger": 1500,
      "created_at": "2026-06-29T12:00:00.000Z"
    }
  ]
}
```

### Delegates

#### GET /delegates?top=20

Get delegation leaderboard.

**Query Parameters**:
- `top`: Number of top delegates to return (default 20, max 100)

**Response**:
```json
{
  "delegates": [
    {
      "address": "G...",
      "delegator_count": 42
    }
  ]
}
```

### Profile

#### GET /profile/:address

Get governance profile for an address.

**Response**:
```json
{
  "address": "G...",
  "proposalsCreated": 5,
  "votesCast": 23,
  "totalVotingPowerUsed": "5000000",
  "currentDelegatee": "G...",
  "wrapper": {
    "depositTotal": "10000000",
    "withdrawalTotal": "5000000",
    "wrappedBalance": "5000000"
  }
}
```

### Wrapper

#### GET /wrapper/deposits

Get wrapper deposit history.

**Query Parameters**:
- `account`: Filter by account address
- `limit`: Number of results (default 50, max 200)
- `offset`: Offset for pagination

**Response**:
```json
{
  "data": [...],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "hasMore": true
  }
}
```

#### GET /wrapper/withdrawals

Get wrapper withdrawal history.

**Query Parameters**: Same as `/wrapper/deposits`

**Response**: Same format as `/wrapper/deposits`

### Treasury

#### GET /treasury/transfers

Get treasury transfer history.

**Query Parameters**:
- `limit`: Number of results (default 20, max 100)
- `offset`: Offset for pagination

**Response**:
```json
{
  "data": [...],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "hasMore": true
  }
}
```

#### GET /streams

List indexed budget streams. Use `owner` to filter by stream owner. `limit`
defaults to 20 and is capped at 100; `offset` defaults to 0.

#### GET /streams/:id

Get the current indexed state of one budget stream.

#### GET /streams/:id/spends

Get complete spend records, including memo and executor, ordered by spend
index. `limit` defaults to 50 and is capped at 200.

#### GET /treasury/stream-events

Get lifecycle history for `stream_id`. This is the endpoint used by
`TreasuryClient.getStreamHistory`.

#### GET /treasury/budget-summary

Get stream counts and exact allocated, spent, and remaining amounts grouped by
token. Soroban integer values are returned as decimal strings.

### Voting Rewards

#### GET /voting-rewards/epochs/:id/claims

Get paginated claim history for an indexed epoch, together with the epoch's
total reward, total claimed, and swept amount. `limit` defaults to 50 and is
capped at 200.

### Configuration & Upgrades

#### GET /config-history

Get governor configuration change history.

**Query Parameters**:
- `limit`: Number of results (default 20, max 100)
- `offset`: Offset for pagination

**Response**:
```json
{
  "data": [
    {
      "id": 42,
      "ledger": 987654,
      "old_settings": { "voting_delay": 10 },
      "new_settings": { "voting_delay": 20 },
      "ledger_closed_at": "2026-06-01T12:00:00.000Z",
      "created_at": "2026-06-01T12:00:03.000Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "hasMore": false
  }
}
```

#### GET /upgrade-history

Get governor upgrade history.

**Query Parameters**: Same as `/config-history`

**Response**:
```json
{
  "data": [
    {
      "id": 1,
      "ledger": 100000,
      "new_wasm_hash": "abc123...",
      "created_at": "2026-06-01T12:00:00.000Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "hasMore": false
  }
}
```

### Timelock

The timelock endpoints return the latest indexed state for an operation or
batch. IDs are lowercase hexadecimal encodings of the contract's `Bytes`
identifiers.

#### GET /timelock/operations/:opId

Get a scheduled, executed, or cancelled timelock operation.

#### GET /timelock/batches/:batchOpId

Get a scheduled, executed, or cancelled batch operation.

#### GET /timelock/batches/:batchOpId/dag

Get the batch's latest dependency-DAG validation result.

#### GET /timelock/batches/:batchOpId/partial-state

Get the latest partial-execution or recovery state for a batch.

Each endpoint returns `404` when no indexed record exists for the supplied ID.

### Leaderboard

#### GET /leaderboard/voters

Get voters ranked by participation.

**Query Parameters**:
- `limit`: Number of results (default 20, max 100)
- `offset`: Offset for pagination

**Response**:
```json
{
  "voters": [
    {
      "voter": "G...",
      "proposals_voted": 42,
      "total_voting_weight": "50000000",
      "for_count": 30,
      "against_count": 10,
      "abstain_count": 2
    }
  ],
  "total": 128,
  "limit": 20,
  "offset": 0,
  "hasMore": true
}
```

### Documentation

#### GET /docs

Interactive Swagger UI documentation.

#### GET /openapi.json

OpenAPI specification in JSON format.

## WebSocket Events

The indexer broadcasts real-time events via WebSocket at `ws://localhost:3001/events`.

### Connection

```javascript
const ws = new WebSocket('ws://localhost:3001/events');

// Subscribe to specific event types
ws.send(JSON.stringify({
  types: ['proposal_created', 'vote_cast']
}));

// Subscribe to specific proposal
ws.send(JSON.stringify({
  proposalId: '42'
}));
```

### Event Types

| Event Type | Data Fields |
|------------|-------------|
| `proposal_created` | `id`, `proposer`, `description`, `start_ledger`, `end_ledger` |
| `vote_cast` | `proposal_id`, `voter`, `support`, `weight`, `reason` |
| `proposal_queued` | `proposal_id` |
| `proposal_executed` | `proposal_id` |
| `proposal_cancelled` | `proposal_id`, `cancelled_at_ledger`, `caller` |
| `delegate_changed` | `delegator`, `old_delegatee`, `new_delegatee`, `ledger` |
| `config_updated` | `ledger`, `old_settings`, `new_settings` |
| `governor_upgraded` | `ledger`, `new_wasm_hash` |
| `wrapper_deposit` | `account`, `amount`, `ledger` |
| `wrapper_withdrawal` | `account`, `amount`, `ledger` |
| `liquidity_added` | `provider`, `outcome_a`, `outcome_b`, `amount_a`, `amount_b`, `lp_tokens`, `ledger` |
| `liquidity_removed` | `provider`, `outcome_a`, `outcome_b`, `amount_a`, `amount_b`, `lp_tokens`, `ledger` |
| `swap` | `trader`, `outcome_in`, `outcome_out`, `amount_in`, `amount_out`, `fee`, `ledger` |
| `pool_fee_updated` | `outcome_a`, `outcome_b`, `old_fee_bps`, `new_fee_bps`, `ledger` |
| `stream_created` | `stream_id`, `name`, `owner`, `ledger` |
| `stream_spend` | `stream_id`, `recipient`, `amount`, `ledger` |
| `stream_batch` | `stream_id`, `total_amount`, `recipient_count`, `ledger` |
| `stream_revoked` | `stream_id`, `caller`, `unspent_returned`, `ledger` |
| `stream_extended` | `stream_id`, `old_end_ledger`, `new_end_ledger`, `ledger` |
| `stream_topped_up` | `stream_id`, `additional_amount`, `new_total_amount`, `ledger` |
| `stream_exhausted` | `stream_id`, `ledger` |
| `stream_expired` | `stream_id`, `unspent`, `ledger` |

### Example Event

```json
{
  "type": "vote_cast",
  "data": {
    "proposal_id": "42",
    "voter": "GABCD...",
    "support": 1,
    "weight": "1000000",
    "reason": "Support this proposal"
  }
}
```

## Monitoring

### Health Checks

The `/health` endpoint provides comprehensive health information:

- **Status**: `ok` or `degraded` based on ledger lag
- **Lag Metrics**: Current ledger lag in ledgers and seconds
- **Indexed Counts**: Total proposals, votes, and delegates indexed
- **Uptime**: Service uptime in seconds

### Monitoring Recommendations

1. **Poll `/health` every 30-60 seconds** to track indexer progress
2. **Alert on `status: "degraded"`** which indicates lag > `HEALTH_LAG_THRESHOLD`
3. **Monitor `lag_ledgers`** to ensure indexer is keeping up with network
4. **Track `total_proposals_indexed`** to verify events are being processed

### Log Monitoring

The indexer logs key events:

- Startup and initialization
- Ledger indexing progress (`Indexed up to ledger {n}`)
- Event processing errors
- Database connection status

### Rate Limiting

The API includes rate limiting to prevent abuse:

- **General endpoints**: 100 requests per 15 minutes per IP
- **Sensitive endpoints** (`/delegates`, `/profile/:address`): 30 requests per 15 minutes per IP

Rate limit headers are included in responses:
- `X-RateLimit-Limit`: Request limit
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Unix timestamp when window resets
- `Retry-After`: Seconds to wait when rate limited (HTTP 429)

## Testing

### Unit Tests

```bash
pnpm --filter @nebgov/indexer run test
```

### Integration Tests

Integration tests require a running PostgreSQL instance and Stellar RPC access.

```bash
# Start test dependencies
docker-compose up -d postgres

# Run integration tests
pnpm --filter @nebgov/indexer run test -- --testPathPattern=int
```

### Test Coverage

- `api.test.ts`: REST API endpoint tests
- `cache.test.ts`: Cache layer tests
- `health.test.ts`: Health check tests
- `ws.test.ts`: WebSocket server tests
- `governor-events.int.test.ts`: Governor event processing integration tests
- `wrapper-events.int.test.ts`: Wrapper event processing integration tests
- `genesis-replay.int.test.ts`: Genesis ledger replay tests

## Troubleshooting

### Indexer Not Starting

1. Check PostgreSQL is running: `docker ps` or `pg_isready`
2. Verify `DATABASE_URL` is correct in `.env`
3. Check migrations ran: `pnpm --filter @nebgov/indexer run migrate`

### High Ledger Lag

1. Check network connectivity to Stellar RPC
2. Reduce `POLL_INTERVAL_MS` to poll more frequently
3. Check database performance (slow queries)
4. Verify contract addresses are correct

### Missing Events

1. Verify contract addresses in `.env` match deployed contracts
2. Check Stellar RPC is returning events for the contract
3. Review indexer logs for event processing errors
4. Ensure `last_ledger` in `indexer_state` is not corrupted

### WebSocket Connection Issues

1. Verify port 3001 is accessible
2. Check firewall rules allow WebSocket connections
3. Review browser console for WebSocket errors

## Development

### Project Structure

```
packages/indexer/
├── src/
│   ├── index.ts          # Main entry point
│   ├── events.ts         # Event processing logic
│   ├── api.ts            # REST API endpoints
│   ├── ws.ts             # WebSocket server
│   ├── db.ts             # Database connection
│   ├── cache.ts          # Cache layer
│   ├── migrate.ts        # Migration runner
│   └── openapi.ts        # OpenAPI spec generation
├── migrations/
│   ├── 001_initial_schema.sql
│   ├── 002_reputation_table.sql
│   ├── ...
│   ├── 019_add_config_update_history_columns.sql
│   └── 020_add_proposal_cancellations.sql
├── Dockerfile
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

### Adding New Event Handlers

1. Add event type to `TOPIC_MAP` in `src/events.ts`
2. Create handler function following existing pattern
3. Add case to appropriate switch statement
4. Create database migration if new table needed
5. Add WebSocket broadcast if real-time notification desired
6. Add cache invalidation if affects cached data
7. Write tests for the new handler

### Running in Production

- Use `pnpm --filter @nebgov/indexer run build` to compile TypeScript
- Use `pnpm --filter @nebgov/indexer run start` to run compiled code
- Set `NODE_ENV=production` for production optimizations
- Use process manager (PM2, systemd) for daemonization
- Configure proper logging and monitoring
- Use secrets management for sensitive environment variables
