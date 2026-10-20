import { OptimisticProposalState } from "@nebgov/sdk";
import { Actor } from "../actors";
import { SimulationHarness } from "../harness";
import { BaseScenario, SimulationResult } from "./base";

export interface OptimisticChallengeScenarioConfig {
  proposer: Actor;
  /** Permissionless caller for `finalize`/`execute`. Defaults to the proposer. */
  executor?: Actor;
  target: string;
  fnName: string;
  calldata: Buffer;
  /** Hex-encoded 32-byte description hash. Defaults to all zeroes. */
  descriptionHash?: string;
}

/**
 * Drives an optimistic-governance proposal end to end on the unchallenged
 * path: submission opens the challenge window, early finalization is
 * rejected while the window is live, and once the window elapses with no
 * objections the proposal is finalized (`Passed`) and executed.
 * Asserts the proposal's on-chain state at every step.
 */
export class OptimisticChallengeScenario extends BaseScenario {
  constructor(
    harness: SimulationHarness,
    private config: OptimisticChallengeScenarioConfig,
  ) {
    super(harness);
  }

  async run(): Promise<SimulationResult> {
    const startLedger = this.harness.clock.sequence;
    const client = this.harness.optimisticGovernorClient;
    const descriptionHash = this.config.descriptionHash ?? "0".repeat(64);

    const settings = await client.getConfig();
    const proposalId = await client.propose(
      this.config.proposer.keypair,
      this.config.target,
      this.config.fnName,
      this.config.calldata,
      descriptionHash,
    );

    // Phase 1: submission opens the challenge window.
    let proposal = await client.getProposal(proposalId);
    if (proposal.state !== "ChallengeWindow" || proposal.objectionVotes !== 0n) {
      throw new Error("Submitted proposal must open in ChallengeWindow with zero objections");
    }
    if (
      proposal.proposer !== this.config.proposer.publicKey ||
      proposal.target !== this.config.target ||
      proposal.fnName !== this.config.fnName ||
      Buffer.compare(Buffer.from(proposal.calldata), this.config.calldata) !== 0
    ) {
      throw new Error("Submitted proposal did not preserve the proposed action");
    }
    if (
      proposal.createdLedger !== this.harness.clock.sequence ||
      proposal.challengeEndLedger !== proposal.createdLedger + settings.challengeWindowLedgers
    ) {
      throw new Error("Challenge window bounds are incorrect for the configured window length");
    }

    // Phase 2: finalization must be rejected while the window is still open.
    const executor = this.config.executor ?? this.config.proposer;
    let earlyFinalizeRejected = false;
    try {
      await client.finalize(executor.keypair, proposalId);
    } catch {
      earlyFinalizeRejected = true;
    }
    if (!earlyFinalizeRejected) {
      throw new Error("finalize must fail before the challenge window elapses");
    }

    // Phase 3: advance to the end of the challenge window, still unobjected.
    await this.harness.advanceLedgers(proposal.challengeEndLedger - this.harness.clock.sequence);
    proposal = await client.getProposal(proposalId);
    if (proposal.state !== "ChallengeWindow" || proposal.objectionVotes !== 0n) {
      throw new Error("An unobjected proposal must stay in ChallengeWindow until finalized");
    }

    // Phase 4: permissionless finalize transitions it to Passed.
    const { state: passedState } = await client.finalize(executor.keypair, proposalId);
    if (passedState !== "Passed") {
      throw new Error("finalize after the challenge window must transition the proposal to Passed");
    }

    // Phase 5: execution completes the optimistic lifecycle.
    await client.execute(executor.keypair, proposalId);
    proposal = await client.getProposal(proposalId);
    if (proposal.state !== "Executed") {
      throw new Error("execute on a Passed proposal must transition it to Executed");
    }

    const finalState: OptimisticProposalState = proposal.state;
    return {
      success: true,
      proposalId: BigInt(proposalId),
      optimisticState: finalState,
      ledgersElapsed: this.harness.clock.sequence - startLedger,
      errors: [],
    };
  }
}
