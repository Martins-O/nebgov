# tools/simulation: Governance Simulation Testing Framework

A TypeScript simulation harness for NebGov's governance contracts. This framework enables in-memory testing of proposal lifecycles, voting mechanics, and edge cases without deploying to a network.

## Overview

The simulation framework provides two modes:

- **Mock Mode** (default): In-memory mock contracts for rapid iteration and comprehensive scenario testing
- **Testnet Mode**: Live contracts deployed to Stellar's testnet for integration testing

All test scenarios inherit from `BaseScenario` and integrate with `SimulationHarness` to manage contract state, advance ledgers, and capture proposal results.

## Quick Start

### Running Tests

```bash
# Run all simulation tests
pnpm test:simulation

# Run a specific test
pnpm test:simulation -- rate-limit.sim.ts

# Run with coverage
pnpm test:simulation -- --coverage
```

### Project Structure

```
tools/simulation/
├── src/
│   ├── scenarios/          # Reusable test scenario classes
│   │   ├── base.ts         # BaseScenario abstract class
│   │   ├── lifecycle.ts    # Full propose→vote→queue→execute flow
│   │   ├── defeat.ts       # Proposal fails quorum/majority
│   │   ├── veto.ts         # Guardian veto of queued proposal
│   │   ├── rate-limit.ts   # Proposer rate-limiting enforcement
│   │   ├── expiry.ts       # Proposal expiration logic
│   │   ├── co_sponsorship_draft.ts # Draft pooling into a governor proposal
│   │   ├── optimistic_challenge.ts # Optimistic propose→challenge window→execute
│   │   └── treasury_streams.ts # Treasury stream create→spend→top-up→drain
│   ├── harness.ts          # SimulationHarness: contract management & lifecycle
│   ├── actors.ts           # Mock actors with keypairs
│   ├── ledger.ts           # Ledger clock simulation
│   ├── state.ts            # Contract state snapshots
│   ├── mock/               # Mock contract implementations
│   │   ├── governor-executor.ts
│   │   ├── timelock-executor.ts
│   │   ├── token-votes-executor.ts
│   │   ├── optimistic-governor-executor.ts
│   │   └── ...
│   └── assertions/         # Helper assertions
└── tests/
    ├── lifecycle.sim.ts    # End-to-end proposal flow
    ├── defeat.sim.ts       # Quorum/majority failure cases
    ├── veto.sim.ts         # Guardian veto scenarios
    ├── rate-limit.sim.ts   # Proposer cooldown enforcement
    ├── expiry.sim.ts       # Expiration edge cases
    ├── co_sponsorship_draft.sim.ts # Co-sponsorship draft pooling
    ├── optimistic_challenge.sim.ts # Optimistic challenge-window lifecycle
    ├── treasury_streams.sim.ts # Treasury budget-stream lifecycle
    └── helpers.ts          # Test setup helpers
```

## Writing a Scenario

### 1. Create a Scenario Class

Extend `BaseScenario` and implement the `run()` method:

```typescript
import { ProposalState } from "@nebgov/sdk";
import { SimulationHarness } from "../harness";
import { BaseScenario, SimulationResult } from "./base";

export interface MyScenarioConfig {
  proposer: Actor;
  voters: Array<{ actor: Actor; support: VoteSupport }>;
  description: string;
  targets: string[];
  fnNames: string[];
  calldatas: Buffer[];
}

export class MyScenario extends BaseScenario {
  constructor(
    harness: SimulationHarness,
    private config: MyScenarioConfig,
  ) {
    super(harness);
  }

  async run(): Promise<SimulationResult> {
    const startLedger = this.harness.clock.sequence;
    const { governorClient } = this.harness;

    // 1. Propose
    const proposalId = await governorClient.propose(
      this.config.proposer.keypair,
      this.config.description,
      "0".repeat(64),           // description hash
      "ipfs://simulation",       // metadata URI
      this.config.targets,
      this.config.fnNames,
      this.config.calldatas,
    );

    // 2. Advance past voting delay
    const settings = await governorClient.getSettings();
    await this.harness.advanceLedgers(settings.votingDelay + 1);

    // 3. Vote
    for (const { actor, support } of this.config.voters) {
      await actor.vote(governorClient, proposalId, support);
    }

    // 4. Advance past voting period
    await this.harness.advanceLedgers(settings.votingPeriod + 1);

    // 5. Check final state
    const finalState = await governorClient.getProposalState(proposalId);

    return {
      success: finalState === ProposalState.Succeeded,
      proposalId,
      finalState,
      ledgersElapsed: this.harness.clock.sequence - startLedger,
      errors: [],
    };
  }
}
```

### 2. SimulationResult Contract

Every scenario's `run()` method returns a `SimulationResult`:

```typescript
interface SimulationResult {
  success: boolean;              // Did the scenario complete successfully?
  proposalId?: bigint;           // Created proposal ID (if applicable)
  finalState?: ProposalState;    // Proposal's terminal state
  optimisticState?: OptimisticProposalState; // Terminal state on the optimistic track
  ledgersElapsed: number;        // Ledgers advanced during the scenario
  errors: string[];              // Captured errors (e.g., contract reverts)
}
```

### 3. Export the Scenario

Add the scenario to `src/index.ts`:

```typescript
export { MyScenario } from "./scenarios/my-scenario";
export type { MyScenarioConfig } from "./scenarios/my-scenario";
```

### 4. Write a Test

Use the scenario in a test file:

```typescript
import { MyScenario } from "../src";
import { buildTestSetup, PLACEHOLDER_CALLDATA } from "./helpers";

describe("My scenario (mock runtime)", () => {
  let harness: SimulationHarness;
  let addresses: DeployedContracts;
  let setup: ReturnType<typeof buildTestSetup>;

  beforeAll(async () => {
    setup = buildTestSetup({ proposers: 1, voters: 5 });
    harness = new SimulationHarness(setup.config);
    harness.registerActors(setup.actors);
    addresses = await harness.boot();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it("completes successfully", async () => {
    const result = await harness.run(MyScenario, {
      proposer: setup.actors.proposers[0],
      voters: [
        { actor: setup.actors.voters[0], support: VoteSupport.For },
        { actor: setup.actors.voters[1], support: VoteSupport.For },
      ],
      description: "Test proposal",
      targets: [addresses.governor],
      fnNames: ["noop"],
      calldatas: [PLACEHOLDER_CALLDATA],
    });

    expect(result.success).toBe(true);
    expect(result.finalState).toBe(ProposalState.Succeeded);
    expect(result.errors).toEqual([]);
  });
});
```

## Worked Example: DefeatScenario

The `DefeatScenario` demonstrates a proposal that fails to reach quorum or majority:

### Scenario Logic

1. **Propose**: Create a proposal
2. **Advance voting delay**: Wait `votingDelay` ledgers so voting opens
3. **Vote insufficiently**: Cast votes but below the quorum threshold
4. **Advance voting period**: Wait `votingPeriod` ledgers for voting to close
5. **Assert defeated**: Verify the proposal state is `Defeated`

### Source Code

```typescript
async run(): Promise<SimulationResult> {
  const startLedger = this.harness.clock.sequence;
  const { governorClient } = this.harness;

  const proposalId = await governorClient.propose(
    this.config.proposer.keypair,
    this.config.description,
    "0".repeat(64),
    "ipfs://simulation",
    this.config.targets,
    this.config.fnNames,
    this.config.calldatas,
  );

  const settings = await governorClient.getSettings();
  await this.harness.advanceLedgers(settings.votingDelay + 1);

  // Vote insufficiently (config.voters is intentionally below quorum)
  for (const { actor, support } of this.config.voters) {
    await actor.vote(governorClient, proposalId, support);
  }

  await this.harness.advanceLedgers(settings.votingPeriod + 1);

  const finalState = await governorClient.getProposalState(proposalId);
  return {
    success: finalState === ProposalState.Defeated,
    proposalId,
    finalState,
    ledgersElapsed: this.harness.clock.sequence - startLedger,
    errors: [],
  };
}
```

### Test Usage

In `tests/defeat.sim.ts`:

```typescript
it("proposal fails if votes do not reach quorum", async () => {
  const result = await harness.run(DefeatScenario, {
    proposer: setup.actors.proposers[0],
    voters: [
      // Only 1 voter out of many; below quorum
      { actor: setup.actors.voters[0], support: VoteSupport.For },
    ],
    description: "Below-quorum proposal",
    targets: [addresses.governor],
    fnNames: ["noop"],
    calldatas: [PLACEHOLDER_CALLDATA],
  });

  expect(result.success).toBe(true);
  expect(result.finalState).toBe(ProposalState.Defeated);
  expect(result.errors).toEqual([]);
});
```

## Worked Example: TreasuryStreamsScenario

The `TreasuryStreamsScenario` drives one treasury budget stream end to end — no
proposal is needed, because `create_stream`/`top_up_stream` are gated directly
by the harness's `treasuryGovernor` and `stream_spend` by the stream owner:

1. **Create**: governance allocates a budget (`totalAllocated`) with a spend
   limit, a cooldown between withdrawals, and a ledger window
2. **Partial spend**: the owner withdraws part of the budget; an immediate
   second withdrawal is rejected with `StreamCooldownNotElapsed`
3. **Top-up**: governance raises `totalAllocated` after the cooldown elapses
4. **Final spend**: the owner withdraws what is left, which marks the stream
   inactive (spent out, not revoked)

Every step asserts the stream, its spend records, the derived budget
report/summary, and the recipient/treasury balances on the single token ledger
the harness models.

```typescript
const result = await harness.run(TreasuryStreamsScenario, {
  governor: setup.actors.proposers[0],
  owner: setup.actors.voters[0],
  recipient: setup.actors.voters[1],
  token: addresses.votes,
});

expect(result.success).toBe(true);
expect(result.finalStream.totalSpent).toBe(result.finalStream.totalAllocated);
expect(result.finalStream.isActive).toBe(false);
```

The mock models stream spends by debiting `addresses.treasury` and crediting
the recipient on the `token-votes` balance ledger, so tests that run this
scenario must seed `config.treasuryBalance` with more than the amount the
stream will move (see `tests/treasury_streams.sim.ts`).

## Error Handling

Scenarios capture contract errors in the `errors` array. Always assert the specific error code, not just the array length:

### ✓ Correct

```typescript
expect(result.errors[0]).toContain("Error(Contract, #6)"); // ProposalRateLimited
```

### ✗ Incorrect

```typescript
expect(result.errors.length).toBeGreaterThan(0); // Too broad
```

## Available Helpers

### SimulationHarness

```typescript
class SimulationHarness {
  // Advance the ledger clock by N ledgers
  async advanceLedgers(ledgers: number): Promise<void>;

  // Register mock actors (proposers, voters, etc.)
  registerActors(actors: ActorSet): void;

  // Boot all contracts and return deployed addresses
  async boot(): Promise<DeployedContracts>;

  // Run a scenario with config
  async run<T extends BaseScenario>(
    ScenarioClass: new (harness: SimulationHarness, config: any) => T,
    config: any,
  ): Promise<SimulationResult>;

  // Clean up resources
  async teardown(): Promise<void>;
}
```

### Actor

```typescript
class Actor {
  constructor(
    public name: string,
    public keypair: Keypair,
    private governorClient: GovernorClient,
  ) {}

  // Cast a vote on a proposal
  async vote(
    governorClient: GovernorClient,
    proposalId: bigint,
    support: VoteSupport,
  ): Promise<void>;

  // Get current voting power
  async getVotingPower(
    tokenVotesClient: TokenVotesClient,
  ): Promise<bigint>;
}
```

### LedgerClock

```typescript
class LedgerClock {
  sequence: u32;  // Current ledger number

  // Advance ledger clock
  advance(ledgers: number): void;
}
```

## StateInspector

Inspect contract state at any point during a scenario:

```typescript
const inspector = new StateInspector(harness);

// Check proposal state
const state = await inspector.getProposalState(proposalId);
console.log(state); // "Active", "Succeeded", etc.

// Check vote counts
const votes = await inspector.getVoteCounts(proposalId);
console.log(votes); // { for: 100, against: 20, abstain: 5 }

// Check actor voting power
const power = await inspector.getActorVotingPower(actor);
console.log(power); // 1000
```

## Testing Best Practices

1. **One assertion per test**: Each test should verify one behavior
2. **Setup in beforeAll**: Initialize harness and actors once per test suite
3. **Advance ledger between tests**: Clear proposer cooldown between independent tests:
   ```typescript
   beforeEach(async () => {
     await harness.advanceLedgers(200); // Reset cooldown
   });
   ```
4. **Assert error codes**: Always check `result.errors[0].toContain(...)`, not just length
5. **Document expectations**: Use descriptive test names and scenario descriptions

## Common Scenarios

| Scenario | Purpose | Example Test |
| --- | --- | --- |
| `FullLifecycleScenario` | Complete propose→vote→queue→execute flow | `lifecycle.sim.ts` |
| `DefeatScenario` | Proposal fails quorum/majority | `defeat.sim.ts` |
| `GuardianVetoScenario` | Guardian veto of a queued proposal | `veto.sim.ts` |
| `RateLimitScenario` | Proposer rate-limiting enforcement | `rate-limit.sim.ts` |
| `ExpiryScenario` | Proposal expiration after grace period | `expiry.sim.ts` |
| `TreasuryStreamsScenario` | Stream create→spend→top-up→drain | `treasury_streams.sim.ts` |

## Debugging

Enable verbose logging by setting the `DEBUG` environment variable:

```bash
DEBUG=nebgov:* pnpm test:simulation
```

Or inspect the harness state within a test:

```typescript
const inspector = new StateInspector(harness);
console.log(await inspector.getProposalState(proposalId));
console.log(harness.clock.sequence);
```

## Contributing

When adding a new scenario:

1. Create `src/scenarios/my-scenario.ts` extending `BaseScenario`
2. Export from `src/index.ts`
3. Add a test file `tests/my-scenario.sim.ts`
4. Run `pnpm test:simulation` to verify
5. Update this README with the new scenario in the Common Scenarios table

## See Also

- [Root CONTRIBUTING.md](../../CONTRIBUTING.md) — overall contribution guidelines
- [SDK Architecture](../../docs/architecture.md) — contract interaction patterns
- [Governor Contract](../../contracts/governor/src/lib.rs) — core proposal logic
