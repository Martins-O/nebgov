import { OptimisticProposalState, ProposalState, VoteSupport } from "@nebgov/sdk";
import { Actor } from "../actors";
import { SimulationHarness } from "../harness";

/** Shared shape for the single-action proposals every scenario submits. */
export interface ProposalScenarioConfig {
  proposer: Actor;
  voters: Array<{ actor: Actor; support: VoteSupport }>;
  description: string;
  targets: string[];
  fnNames: string[];
  calldatas: Buffer[];
}

export interface SimulationResult {
  success: boolean;
  proposalId?: bigint;
  finalState?: ProposalState;
  /** Terminal state on the optimistic-governor track; unset for standard-governor scenarios. */
  optimisticState?: OptimisticProposalState;
  ledgersElapsed: number;
  errors: string[];
}

export abstract class BaseScenario {
  constructor(protected harness: SimulationHarness) {}
  abstract run(): Promise<SimulationResult>;
}
