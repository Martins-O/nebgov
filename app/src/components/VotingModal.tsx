"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { GovernorClient, VoteSupport, VoteType, computeQuadraticWeight, type Network } from "@nebgov/sdk";
import { useWallet } from "../lib/wallet-context";
import { useGovernorConfig } from "@/hooks/useGovernorConfig";

interface Props {
  open?: boolean;
  isOpen?: boolean;
  onClose: () => void;
  proposalId: bigint | string;
  preselectedSupport?: VoteSupport | null;
  delegatee?: string | null;
  votingPower?: bigint;
  onOpenDelegate?: () => void;
  onVoted?: () => void;
  onSuccess?: () => void;
  voteType?: VoteType;
  governorClient?: GovernorClient | null;
  proposalTitle?: string;
}

function getGovernorClientFromEnv(): GovernorClient {
  const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
  const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
  const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
  const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

  if (!governorAddress || !timelockAddress || !votesAddress) {
    throw new Error("Missing NEXT_PUBLIC_* contract addresses in .env.local");
  }

  return new GovernorClient({
    governorAddress,
    timelockAddress,
    votesAddress,
    network,
    ...(rpcUrl && { rpcUrl }),
  });
}

export function VotingModal({
  open,
  isOpen,
  onClose,
  proposalId,
  preselectedSupport,
  delegatee,
  votingPower,
  onOpenDelegate,
  onVoted,
  onSuccess,
  voteType,
  governorClient,
}: Props) {
  const { isConnected, connect, publicKey, signTransaction } = useWallet();
  const { divisor } = useGovernorConfig();
  const resolvedOpen = open ?? isOpen ?? false;
  const resolvedProposalId = typeof proposalId === "bigint" ? proposalId : BigInt(proposalId);
  const resolvedDelegatee = delegatee ?? publicKey ?? null;
  const resolvedVotingPower = votingPower ?? 0n;
  const [support, setSupport] = useState<VoteSupport | null>(preselectedSupport ?? null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [estimatingFee, setEstimatingFee] = useState(false);
  const [estimatedFeeStroops, setEstimatedFeeStroops] = useState<bigint | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);

  useEffect(() => setSupport(preselectedSupport ?? null), [preselectedSupport]);

  useEffect(() => {
    if (!resolvedOpen || support === null || !resolvedDelegatee) {
      setEstimatingFee(false);
      setEstimatedFeeStroops(null);
      setEstimateError(null);
      return;
    }

    let cancelled = false;

    async function loadEstimate() {
      setEstimatingFee(true);
      try {
        const client = governorClient ?? getGovernorClientFromEnv();
        const result = await client.estimateVoteGas(
          resolvedDelegatee,
          resolvedProposalId,
          support,
        );

        if (cancelled) return;
        if (result.ok) {
          setEstimatedFeeStroops(
            result.estimatedFeeStroops ? BigInt(result.estimatedFeeStroops) : null,
          );
          setEstimateError(null);
        } else {
          setEstimatedFeeStroops(null);
          setEstimateError(result.error ?? "Unable to estimate fee");
        }
      } catch (err) {
        if (cancelled) return;
        setEstimatedFeeStroops(null);
        setEstimateError(err instanceof Error ? err.message : "Unable to estimate fee");
      } finally {
        if (!cancelled) {
          setEstimatingFee(false);
        }
      }
    }

    void loadEstimate();

    return () => {
      cancelled = true;
    };
  }, [governorClient, resolvedDelegatee, resolvedOpen, resolvedProposalId, support]);

  // Focus management for modal
  useEffect(() => {
    if (resolvedOpen) {
      // Focus the modal when it opens
      const modal = document.getElementById('voting-modal');
      if (modal) {
        modal.focus();
      }
    }
  }, [resolvedOpen]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && resolvedOpen) {
        onClose();
      }
    };
    
    if (resolvedOpen) {
      document.addEventListener('keydown', handleEscape);
      // Prevent body scroll when modal is open
      document.body.style.overflow = 'hidden';
    }
    
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [resolvedOpen, onClose]);

  if (!resolvedOpen) return null;

  const tokenAmount = Number(resolvedVotingPower) / 1e6;
  const isQuadratic = voteType === VoteType.Quadratic;
  const quadraticWeight = isQuadratic ? computeQuadraticWeight(resolvedVotingPower) : null;

  const totalSupplyRaw = process.env.NEXT_PUBLIC_TOTAL_SUPPLY; // optional, in tokens (raw units)
  const percentOfSupply = (() => {
    try {
      if (!totalSupplyRaw) return null;
      const total = BigInt(totalSupplyRaw);
      if (total === 0n) return null;
      return Number((resolvedVotingPower * 10000n) / total) / 100; // two decimals
    } catch {
      return null;
    }
  })();
  const estimatedFeeXlm =
    estimatedFeeStroops !== null ? Number(estimatedFeeStroops) / divisor : null;

  async function handleConfirm() {
    if (support === null) {
      toast.error("Select a vote option first.");
      return;
    }

    if (!isConnected || !publicKey) {
      try {
        await connect();
      } catch (e) {
        toast.error("Please connect your wallet to continue.");
        return;
      }
    }

    if (!resolvedDelegatee) {
      toast.error("Delegate first before casting a vote.");
      return;
    }

    setSubmitting(true);
    try {
      const client = getGovernorClientFromEnv();
      if (!signTransaction) {
        throw new Error("Connect your wallet to sign the vote.");
      }
      await client.castVoteWithSign(
        publicKey,
        resolvedProposalId,
        support,
        signTransaction,
      );
      toast.success(
        "Vote submitted!",
        { duration: 8000 },
      );
      onVoted?.();
      onSuccess?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errStr = msg.toLowerCase();
      
      let errorMessage = `Failed to submit vote: ${msg}`;
      if (errStr.includes("proposalnotactive") || 
          errStr.includes("proposal not active") ||
          errStr.includes("error(contract, #28)")) {
        errorMessage = "Voting has ended for this proposal";
      }
      
      toast.error(errorMessage);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div 
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="voting-modal-title"
      aria-describedby="voting-modal-description"
    >
      <div 
        id="voting-modal"
        className="bg-white dark:bg-gray-800 rounded-2xl p-6 w-full max-w-lg shadow-xl"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 id="voting-modal-title" className="text-lg font-bold text-gray-900 dark:text-gray-100">Cast Your Vote</h2>
            <p id="voting-modal-description" className="text-sm text-gray-500 dark:text-gray-300">Confirm and sign your vote on-chain.</p>
          </div>
          <button 
            onClick={onClose} 
            className="text-gray-400 hover:text-gray-600 p-1 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
            aria-label="Close voting modal"
          >
            ✕
          </button>
        </div>

        {/* Delegation check */}
        <div className="bg-gray-50 dark:bg-gray-900 border border-gray-100 dark:border-gray-700 rounded-lg p-3 mb-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">Delegation</p>
          {resolvedDelegatee ? (
            <p className="text-sm text-gray-700 dark:text-gray-200 mt-1">Delegated to <span className="font-mono">{resolvedDelegatee}</span></p>
          ) : (
            <div className="mt-2 flex items-center gap-3">
              <p className="text-sm text-red-600">You have not delegated voting power yet.</p>
              <button
                onClick={onOpenDelegate}
                className="ml-auto text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                aria-label="Open delegation modal"
              >
                Delegate now
              </button>
            </div>
          )}
        </div>

        {/* Voting power */}
        <div className="mb-4">
          <p className="text-sm text-gray-500">Your voting power</p>
          {isQuadratic ? (
            <div>
              <p className="text-base font-medium text-gray-900 dark:text-gray-100">
                {tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })} tokens
                {percentOfSupply !== null ? (
                  <span className="text-sm text-gray-500"> ({percentOfSupply}%)</span>
                ) : null}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <p className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">
                  Vote weight: {quadraticWeight!.toLocaleString()} (quadratic)
                </p>
                <span
                  className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300 text-[10px] cursor-help focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  title="Quadratic voting: your vote weight is floor(√balance). A balance of 10,000 tokens gives a weight of 100, not 10,000. This reduces the influence of large token holders."
                  aria-label="Quadratic voting explanation"
                  tabIndex={0}
                >
                  ?
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                Formula: floor(√{tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })}) = {quadraticWeight!.toLocaleString()}
              </p>
            </div>
          ) : (
            <p className="text-base font-medium text-gray-900 dark:text-gray-100">
              {tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })} tokens
              {percentOfSupply !== null ? (
                <span className="text-sm text-gray-500"> ({percentOfSupply}%)</span>
              ) : null}
            </p>
          )}
        </div>

        <div className="mb-4 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Estimated fee
          </p>
          <p className="mt-1 text-sm text-gray-800">
            {estimatingFee
              ? "Estimating..."
              : estimatedFeeXlm !== null
                ? `~${estimatedFeeXlm.toFixed(6)} XLM`
                : estimateError ?? "Unavailable"}
          </p>
        </div>

        {/* Vote options */}
        <fieldset className="mb-4">
          <legend className="sr-only">Vote options</legend>
          <div className="flex gap-3" role="radiogroup" aria-label="Vote options">
            {[
              { label: "For", value: VoteSupport.For, color: "border-green-500 text-green-700 bg-green-50" },
              { label: "Against", value: VoteSupport.Against, color: "border-red-500 text-red-700 bg-red-50" },
              { label: "Abstain", value: VoteSupport.Abstain, color: "border-gray-400 text-gray-600 bg-gray-50" },
            ].map(({ label, value, color }) => (
              <button
                key={label}
                onClick={() => setSupport(value)}
                className={`flex-1 border-2 rounded-lg py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                  support === value ? color : "border-gray-200 text-gray-500 hover:border-gray-300"
                }`}
                role="radio"
                aria-checked={support === value}
                aria-label={`Vote ${label}`}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        <label htmlFor="vote-reason" className="block text-sm text-gray-600 dark:text-gray-300 mb-2">
          Optional reason <span className="text-xs text-gray-400">(max 256)</span>
        </label>
        <textarea
          id="vote-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 256))}
          placeholder="I support this because..."
          className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 mb-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          rows={4}
          aria-describedby="reason-help"
        />
        <div id="reason-help" className="sr-only">
          Optional field to provide reasoning for your vote. Maximum 256 characters.
        </div>
        
        <div className="flex items-center gap-3">
          <button
            onClick={handleConfirm}
              disabled={submitting || !isConnected || !resolvedDelegatee}
              className="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            aria-describedby={!resolvedDelegatee ? "delegation-required" : undefined}
          >
            {submitting ? "Submitting vote..." : "Confirm & Sign"}
          </button>
          <button 
            onClick={onClose} 
            className="px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            Cancel
          </button>
        </div>
        
        {!resolvedDelegatee && (
          <div id="delegation-required" className="sr-only">
            You must delegate your voting power before you can vote.
          </div>
        )}
      </div>
    </div>
  );
}
