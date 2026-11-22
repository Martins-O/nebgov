"use client";

/**
 * Create proposal page with simulation support.
 * Four-step proposal wizard: basics → actions (optional) → review → success.
 * Updated with SHA-256 hashing and metadata URI support.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import {
  ChevronDown,
  ChevronUp,
  Share2,
  Loader2,
  Link as LinkIcon,
  AlertCircle,
  Copy,
} from "lucide-react";
import {
  GovernorClient,
  VotesClient,
  ReputationClient,
  ProposalBondsClient,
  hashDescription,
  uploadProposalMetadata,
  type CanProposeResult,
  type GovernorSettings,
} from "@nebgov/sdk";
import {
  calldataArgRowToScVal,
  encodeGovernorCalldataBytes,
  newArgRow,
  type CalldataArgRow,
} from "../../lib/treasury-calldata";
import { useWallet } from "../../lib/wallet-context";
import { CountdownTimer } from "../../components/CountdownTimer";
import { ProposalImpactPreview } from "../../components/ProposalImpactPreview";
import { useProposalSimulation } from "../../hooks/useProposalSimulation";

// Wizard Constants
const TITLE_MIN = 10;
const TITLE_MAX = 100;
const DESC_MIN = 20;
const DESC_MAX = 10000;
const STORAGE_KEY = "nebgov_proposal_draft";
const DRAFT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

const STEPS = [
  { id: 1, label: "Content" },
  { id: 2, label: "Actions" },
  { id: 3, label: "Review" },
  { id: 4, label: "Success" },
];

interface WizardAction {
  id: string;
  target: string;
  fnName: string;
  args: CalldataArgRow[];
  simulateOk: boolean | null;
  simulateError?: string;
}

interface DraftState {
  title: string;
  description: string;
  descriptionHash: string;
  ipfsRef: string;
  actions: WizardAction[];
  savedAt: number;
  currentStep: number;
}

function newAction(): WizardAction {
  return {
    id: Math.random().toString(36).substring(7),
    target: "",
    fnName: "",
    args: [],
    simulateOk: null,
  };
}

// Helpers
const LEDGER_SECONDS = 5;

function ledgerToTimeEstimate(ledgers: number): string {
  const totalSeconds = ledgers * LEDGER_SECONDS;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `~${hours} hr${remainingMinutes > 0 ? ` ${remainingMinutes} min` : ''}`;
  const days = Math.floor(hours / 24);
  return `~${days} day${days > 1 ? 's' : ''} ${hours % 24} hr`;
}

function isReasonableIpfsRef(s: string): boolean {
  if (!s) return true; // Optional
  const v = s.trim().toLowerCase();
  return (
    v.startsWith("ipfs://") ||
    v.startsWith("http://") ||
    v.startsWith("https://") ||
    (v.length >= 46 && !v.includes(" ")) // CID check
  );
}

function explorerTxUrl(txHash: string): string {
  const network = process.env.NEXT_PUBLIC_NETWORK || "testnet";
  const base =
    network === "mainnet"
      ? "https://stellar.expert/explorer/public"
      : "https://stellar.expert/explorer/testnet";
  return `${base}/tx/${txHash}`;
}

function getClients() {
  const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
  const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
  const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
  const proposalBondsAddress = process.env.NEXT_PUBLIC_PROPOSAL_BONDS_ADDRESS;
  const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as
    | "mainnet"
    | "testnet"
    | "futurenet";
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
  if (!governorAddress || !timelockAddress || !votesAddress) return null;
  const cfg = {
    governorAddress,
    timelockAddress,
    votesAddress,
    network,
    ...(rpcUrl ? { rpcUrl } : {}),
  };
  return {
    governor: new GovernorClient(cfg),
    votes: new VotesClient(cfg),
    reputation: new ReputationClient(cfg),
    governorAddress,
    // Bonding is optional — only constructed when a bonds contract is
    // configured, so proposing continues to work for deployments that
    // haven't opted into Issue #996's bonding layer.
    proposalBonds: proposalBondsAddress
      ? new ProposalBondsClient({ ...cfg, proposalBondsAddress })
      : null,
  };
}

function buildDescription(title: string, desc: string, ipfs: string): string {
  // We store the title + description content on-chain as a single string
  // and we also store the IPFS link for rich metadata access.
  const base = `${title}\n\n${desc}`;
  if (ipfs) {
    return `${base}\n\n<!-- ipfs:${ipfs} -->`;
  }
  return base;
}

function buildPayload(actions: WizardAction[], governorAddress: string) {
  const targets: string[] = [];
  const fnNames: string[] = [];
  const calldatas: Uint8Array[] = [];

  for (const a of actions) {
    targets.push(a.target.trim() || governorAddress);
    fnNames.push(a.fnName.trim() || "proposal_count"); // Placeholder if empty
    calldatas.push(encodeGovernorCalldataBytes(a.args));
  }

  // If no actions, we still need a signal action for the governor to accept the proposal
  if (targets.length === 0) {
    targets.push(governorAddress);
    fnNames.push("proposal_count");
    calldatas.push(new Uint8Array(0));
  }

  return { targets, fnNames, calldatas };
}

function getActionCalldataHex(args: CalldataArgRow[]): string {
  try {
    const bytes = encodeGovernorCalldataBytes(args);
    if (bytes.length === 0) return "0x";
    return "0x" + Buffer.from(bytes).toString("hex");
  } catch {
    return "Encoding error";
  }
}

function ProposeWizardInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isConnected, publicKey, signTransaction } = useWallet();
  const clients = useMemo(() => getClients(), []);

  const stepParam = searchParams.get("step");
  const successIdParam = searchParams.get("id");
  const step = Number(stepParam) || 1;

  const [hydrated, setHydrated] = useState(false);
  const [draft, setDraft] = useState<DraftState>({
    title: "",
    description: "",
    descriptionHash: "",
    ipfsRef: "",
    actions: [],
    savedAt: 0,
    currentStep: 1,
  });
  const [savedDraftExists, setSavedDraftExists] = useState(false);
  const [savedDraftData, setSavedDraftData] = useState<DraftState | null>(null);
  const [showRestoreBanner, setShowRestoreBanner] = useState(false);

  const [isHashing, setIsHashing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [stepErrors, setStepErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Simulation / review data
  const [votes, setVotes] = useState<bigint | null>(null);
  const [threshold, setThreshold] = useState<bigint | null>(null);
  // Reputation-adjusted threshold (Issue #771) — what propose() actually
  // enforces. Falls back to the flat threshold if reputation is disabled or
  // the fetch fails, so behavior degrades gracefully.
  const [effectiveThreshold, setEffectiveThreshold] = useState<bigint | null>(
    null,
  );
  const [canProposeResult, setCanProposeResult] =
    useState<CanProposeResult | null>(null);
  const [estimate, setEstimate] = useState<{
    cpuInsns?: string;
    memBytes?: string;
  } | null>(null);
  const [estimateErr, setEstimateErr] = useState<string | null>(null);
  const [simBusy, setSimBusy] = useState<string | null>(null);

  // Early eligibility check for step 1
  const [earlyEligibility, setEarlyEligibility] =
    useState<CanProposeResult | null>(null);
  const [eligibilityLoading, setEligibilityLoading] = useState(false);

  // Extended review data for threshold/delegate check
  const [baseVotes, setBaseVotes] = useState<bigint | null>(null);
  const [delegatee, setDelegatee] = useState<string | null>(null);
  const [delegateBusy, setDelegateBusy] = useState(false);
  const [settings, setSettings] = useState<GovernorSettings | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);

  const {
    results: impactResults,
    loading: impactLoading,
    error: impactError,
    anyActionWouldRevert: impactAnyActionWouldRevert,
    previewDraft: previewImpact,
    reset: resetImpact,
  } = useProposalSimulation();

  const reviewDataReady =
    votes !== null &&
    threshold !== null &&
    canProposeResult !== null &&
    estimate !== null &&
    baseVotes !== null &&
    delegatee !== null;

  // Hydration / Persistence
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as DraftState;
        const now = Date.now();
        if (now - parsed.savedAt < DRAFT_EXPIRY_MS) {
          setSavedDraftData(parsed);
          setSavedDraftExists(true);
          setShowRestoreBanner(true);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch (e) {
        console.error("Failed to load draft:", e);
      }
    }
    setHydrated(true);
  }, []);

  const restoreDraft = useCallback(() => {
    if (savedDraftData) {
      setDraft(savedDraftData);
      const q = new URLSearchParams(searchParams.toString());
      q.set("step", String(savedDraftData.currentStep || 1));
      if (savedDraftData.currentStep !== 4) q.delete("id");
      router.push(`/propose?${q.toString()}`);
      setShowRestoreBanner(false);
    }
  }, [savedDraftData, router, searchParams]);

  const discardDraft = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setSavedDraftData(null);
    setSavedDraftExists(false);
    setShowRestoreBanner(false);
    setDraft({
      title: "",
      description: "",
      descriptionHash: "",
      ipfsRef: "",
      actions: [],
      savedAt: 0,
      currentStep: 1,
    });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const draftWithTimestamp: DraftState = {
      ...draft,
      savedAt: Date.now(),
      currentStep: step,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draftWithTimestamp));
  }, [draft, hydrated, step]);

  // Auto-hash description when it changes
  useEffect(() => {
    if (!draft.description.trim()) return;

    const timer = setTimeout(async () => {
      setIsHashing(true);
      try {
        const hash = await hashDescription(draft.description);
        setDraft((d) => ({ ...d, descriptionHash: hash }));
      } catch (err) {
        console.error("Hashing failed:", err);
      } finally {
        setIsHashing(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [draft.description]);

  const setStep = useCallback(
    (n: number) => {
      const q = new URLSearchParams(searchParams.toString());
      q.set("step", String(n));
      if (n !== 4) q.delete("id");
      router.push(`/propose?${q.toString()}`);
    },
    [router, searchParams],
  );

  async function handleIpfsUpload() {
    if (!draft.description.trim()) {
      setStepErrors(["Please enter a description first."]);
      return;
    }

    // Try to get JWT from sessionStorage (only for current session, cleared on tab close)
    let pinataKey = sessionStorage.getItem("pinata_jwt") || "";
    if (!pinataKey) {
      const key = prompt("Please enter your Pinata JWT (or API Key):");
      if (!key) return;
      // Store only in sessionStorage (cleared on browser tab close) - NEVER in localStorage
      sessionStorage.setItem("pinata_jwt", key);
      pinataKey = key;
    }

    setIsUploading(true);
    setStepErrors([]);
    try {
      // Call the server-side API route that handles Pinata uploads securely
      const response = await fetch("/api/upload-metadata", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          description: draft.description,
          pinataJwt: pinataKey,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `Upload failed: ${response.status}`);
      }

      const { uri, hash } = await response.json();
      setDraft((d) => ({ ...d, ipfsRef: uri, descriptionHash: hash }));
    } catch (err) {
      console.error("IPFS upload failed:", err);
      setStepErrors([
        err instanceof Error ? err.message : "IPFS upload failed",
      ]);
    } finally {
      setIsUploading(false);
    }
  }

  function validateStep1(): string[] {
    const err: string[] = [];
    const t = draft.title.trim();
    if (t.length < TITLE_MIN || t.length > TITLE_MAX) {
      err.push(`Title must be ${TITLE_MIN}–${TITLE_MAX} characters.`);
    }
    const d = draft.description.trim();
    if (d.length < DESC_MIN || d.length > DESC_MAX) {
      err.push(`Description must be ${DESC_MIN}–${DESC_MAX} characters.`);
    }
    if (!isReasonableIpfsRef(draft.ipfsRef)) {
      err.push(
        "IPFS reference must be a gateway URL, ipfs:// link, or raw CID.",
      );
    }
    if (!draft.descriptionHash && draft.description.trim()) {
      err.push("Waiting for description hash computation...");
    }
    return err;
  }

  function validateStep2(): string[] {
    const err: string[] = [];
    for (const a of draft.actions) {
      if (!a.target.trim() || !a.fnName.trim()) {
        err.push("Each action needs a target and function name.");
        break;
      }
      const hasArgs = a.args.some((r) => r.value.trim() !== "");
      if (hasArgs && a.simulateOk !== true) {
        err.push("Simulate every action that has arguments before continuing.");
        break;
      }
    }
    return err;
  }

  async function runReviewLoads() {
    if (!clients || !publicKey) return;
    setReviewLoading(true);
    setEstimate(null);
    setEstimateErr(null);
    try {
      const [v, t, cp, bv, del, s, et] = await Promise.all([
        clients.votes.getVotes(publicKey),
        clients.governor.proposalThreshold(),
        clients.governor.canPropose(publicKey),
        clients.votes.getBaseVotes(publicKey),
        clients.votes.getDelegatee(publicKey),
        clients.governor.getSettings(publicKey).catch(() => null),
        clients.reputation.getEffectiveThreshold(publicKey).catch(() => null),
      ]);
      setVotes(v);
      setThreshold(t);
      setCanProposeResult(cp);
      setBaseVotes(bv);
      setDelegatee(del);
      setSettings(s);
      setEffectiveThreshold(et);

      const description = buildDescription(
        draft.title,
        draft.description,
        draft.ipfsRef,
      );
      const { targets, fnNames, calldatas } = buildPayload(
        draft.actions,
        clients.governorAddress,
      );
      if (draft.actions.length > 0) {
        void previewImpact(targets, fnNames, calldatas, draft.descriptionHash);
      } else {
        resetImpact();
      }
      const est = await clients.governor.estimateProposeResources(
        publicKey,
        description,
        draft.descriptionHash,
        draft.ipfsRef,
        targets,
        fnNames,
        calldatas,
      );
      if (!est.ok) {
        setEstimateErr(est.error ?? "Could not estimate proposal cost.");
        return;
      }
      setEstimate({ cpuInsns: est.cpuInsns, memBytes: est.memBytes });
    } catch (e) {
      console.error("Review loads failed:", e);
    } finally {
      setReviewLoading(false);
    }
  }

  useEffect(() => {
    if (step !== 3 || !clients || !publicKey) return;
    void runReviewLoads();
  }, [step, publicKey, clients, draft]);

  // Load early eligibility check when wallet connects or changes
  useEffect(() => {
    if (!clients || !publicKey || !isConnected) {
      setEarlyEligibility(null);
      return;
    }

    async function checkEligibility() {
      setEligibilityLoading(true);
      try {
        const result = await clients!.governor.canPropose(publicKey!);
        setEarlyEligibility(result);
      } catch (e) {
        console.error("Failed to check eligibility:", e);
      } finally {
        setEligibilityLoading(false);
      }
    }

    void checkEligibility();
  }, [publicKey, isConnected, clients]);

  async function handleDelegateToSelf() {
    if (!clients || !publicKey) return;
    setDelegateBusy(true);
    try {
      if (!signTransaction) {
        throw new Error("Connect your wallet to sign the delegation.");
      }
      const txHash = await clients.votes.delegateWithSign(
        publicKey,
        publicKey,
        signTransaction,
      );
      toast.success(
        <div>
          Delegated to yourself!{" "}
          <a
            href={explorerTxUrl(txHash)}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            View on Explorer →
          </a>
        </div>,
        { duration: 8000 },
      );
      void runReviewLoads();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Delegation failed: ${msg}`);
    } finally {
      setDelegateBusy(false);
    }
  }

  async function simulateAction(act: WizardAction) {
    if (!clients || !publicKey) return;
    setSimBusy(act.id);
    try {
      const args = act.args
        .filter((r) => r.value.trim())
        .map(calldataArgRowToScVal);
      const res = await clients.governor.simulateTargetInvocation(
        publicKey,
        act.target.trim(),
        act.fnName.trim(),
        args,
      );
      setDraft((d) => ({
        ...d,
        actions: d.actions.map((x) =>
          x.id === act.id
            ? {
                ...x,
                simulateOk: res.ok,
                simulateError: res.ok ? undefined : res.error,
              }
            : x,
        ),
      }));
    } catch (e: unknown) {
      setDraft((d) => ({
        ...d,
        actions: d.actions.map((x) =>
          x.id === act.id
            ? {
                ...x,
                simulateOk: false,
                simulateError:
                  e instanceof Error ? e.message : "Simulation failed",
              }
            : x,
        ),
      }));
    } finally {
      setSimBusy(null);
    }
  }

  async function submitProposal() {
    if (!clients || !publicKey || !signTransaction) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const description = buildDescription(
        draft.title,
        draft.description,
        draft.ipfsRef,
      );
      const { targets, fnNames, calldatas } = buildPayload(
        draft.actions,
        clients.governorAddress,
      );
      const { proposalId, txHash } = await clients.governor.proposeWithSign(
        publicKey,
        description,
        draft.descriptionHash,
        draft.ipfsRef,
        targets,
        fnNames,
        calldatas,
        signTransaction,
      );
      toast.success(
        <div>
          Proposal submitted!{" "}
          <a
            href={explorerTxUrl(txHash)}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            View on Explorer →
          </a>
        </div>,
        { duration: 8000 },
      );

      // Bonding (Issue #996) is a second, separate transaction correlated
      // by the same description hash — best-effort: the proposal above has
      // already succeeded on-chain, so a bond-lock failure is surfaced but
      // must not block navigating to the success step.
      if (clients.proposalBonds) {
        try {
          await clients.proposalBonds.lockBondWithSign(
            publicKey,
            draft.descriptionHash,
            signTransaction,
          );
          toast.success("Proposal bond locked.");
        } catch (bondError: unknown) {
          toast.error(
            `Proposal submitted, but locking the bond failed: ${
              bondError instanceof Error ? bondError.message : String(bondError)
            }`,
          );
        }
      }

      sessionStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY);
      setDraft({
        title: "",
        description: "",
        descriptionHash: "",
        ipfsRef: "",
        actions: [],
        savedAt: 0,
        currentStep: 1,
      });
      router.push(`/propose?step=4&id=${proposalId.toString()}`);
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  function goNext() {
    setStepErrors([]);
    if (step === 1) {
      const e = validateStep1();
      if (e.length) {
        setStepErrors(e);
        return;
      }
      // Check early eligibility
      if (isConnected && earlyEligibility && !earlyEligibility.allowed) {
        setStepErrors([
          earlyEligibility.reason ?? "Cannot propose at this time",
        ]);
        return;
      }
    }
    if (step === 2) {
      const e = validateStep2();
      if (e.length) {
        setStepErrors(e);
        return;
      }
    }
    if (step === 3) {
      if (!isConnected || !publicKey) {
        setStepErrors(["Connect your wallet to submit."]);
        return;
      }
      if (votes === null || threshold === null) {
        setStepErrors(["Still loading voting power. Try again in a moment."]);
        return;
      }
      const requiredThreshold = effectiveThreshold ?? threshold;
      if (votes < requiredThreshold) {
        const shortfall = (
          Number(requiredThreshold - votes) /
          10 ** 7
        ).toLocaleString();
        setStepErrors([
          `Insufficient voting power — need ${(Number(requiredThreshold) / 10 ** 7).toLocaleString()} GOV, have ${(Number(votes) / 10 ** 7).toLocaleString()} GOV (shortfall: ${shortfall} GOV).`,
        ]);
        return;
      }
      if (canProposeResult && !canProposeResult.allowed) {
        setStepErrors([canProposeResult.reason ?? "Rate limit active."]);
        return;
      }
      void submitProposal();
      return;
    }
    setStep(step + 1);
  }

  if (!clients) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm">
          Set <span className="font-mono">NEXT_PUBLIC_GOVERNOR_ADDRESS</span>,{" "}
          <span className="font-mono">NEXT_PUBLIC_TIMELOCK_ADDRESS</span>, and{" "}
          <span className="font-mono">NEXT_PUBLIC_VOTES_ADDRESS</span> in{" "}
          <span className="font-mono">.env.local</span>.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
        New proposal
      </h1>
      <p className="text-gray-500 dark:text-gray-400 mb-8">
        Step-by-step flow with validation, previews, and on-chain simulation.
      </p>

      {/* Restore Draft Banner */}
      {showRestoreBanner && savedDraftData && (
        <div className="mb-6 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-amber-800 dark:text-amber-200 text-sm">
              You have an unsaved draft from{" "}
              {new Date(savedDraftData.savedAt).toLocaleDateString()}. Restore
              it?
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={restoreDraft}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
            >
              Restore
            </button>
            <button
              onClick={discardDraft}
              className="px-4 py-2 text-gray-600 dark:text-gray-300 text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* Progress */}
      <ol className="flex items-center gap-2 mb-10 text-sm">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2 flex-1 min-w-0">
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-semibold ${
                step >= s.id
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
              }`}
            >
              {s.id}
            </span>
            <span
              className={`truncate hidden sm:inline ${
                step === s.id
                  ? "font-semibold text-gray-900 dark:text-white"
                  : "text-gray-500 dark:text-gray-400"
              }`}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="h-px flex-1 bg-gray-200 min-w-[12px] hidden md:block" />
            )}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <div className="space-y-6">
          {/* Early eligibility warning */}
          {isConnected && earlyEligibility && !earlyEligibility.allowed && (
            <div className="flex items-start gap-3 text-amber-800 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-300 p-4 rounded-xl text-sm border border-amber-200 dark:border-amber-800">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Cannot create proposal</p>
                <p className="mt-1">{earlyEligibility.reason}</p>
                {earlyEligibility.cooldownEndsAt && (
                  <p className="mt-2 text-xs font-mono opacity-80">
                    <CountdownTimer
                      label="Cooldown ends in"
                      targetLedger={earlyEligibility.cooldownEndsAt}
                    />
                  </p>
                )}
                {earlyEligibility.reason.includes("threshold") && (
                  <div className="mt-2 text-xs">
                    <p>
                      Your voting power:{" "}
                      {(
                        Number(earlyEligibility.votingPower) /
                        10 ** 7
                      ).toLocaleString()}{" "}
                      GOV
                    </p>
                    <p>
                      Required:{" "}
                      {(
                        Number(earlyEligibility.threshold) /
                        10 ** 7
                      ).toLocaleString()}{" "}
                      GOV
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {isConnected && eligibilityLoading && (
            <div className="flex items-center gap-2 text-gray-500 text-sm bg-gray-50 dark:bg-gray-900/50 p-3 rounded-xl">
              <Loader2 className="w-4 h-4 animate-spin" />
              Checking proposal eligibility...
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Title ({TITLE_MIN}–{TITLE_MAX} characters)
            </label>
            <input
              type="text"
              value={draft.title}
              onChange={(e) =>
                setDraft((d) => ({ ...d, title: e.target.value }))
              }
              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500"
              placeholder="Short, specific title"
              maxLength={TITLE_MAX + 5}
            />
            <p className="text-xs text-gray-400 mt-1">
              {draft.title.trim().length} / {TITLE_MAX} (min {TITLE_MIN})
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Description (Markdown, {DESC_MIN}–{DESC_MAX} chars)
              </label>
              <textarea
                value={draft.description}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, description: e.target.value.slice(0, DESC_MAX) }))
                }
                rows={12}
                maxLength={DESC_MAX}
                className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white font-mono focus:ring-2 focus:ring-indigo-500"
                placeholder="Full proposal narrative: context, options, risks…"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {draft.description.trim().length} / {DESC_MAX} (min {DESC_MIN})
              </p>
              {draft.description.trim() && (
                <div className="mt-2 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  {isHashing ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Computing content hash…
                    </span>
                  ) : draft.descriptionHash ? (
                    <>
                      <span className="font-mono truncate max-w-[280px]">
                        Content hash: 0x{draft.descriptionHash}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(`0x${draft.descriptionHash}`);
                          toast.success("Hash copied");
                        }}
                        className="text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 shrink-0"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : null}
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 flex items-center justify-between">
                Preview
                {isHashing && (
                  <span className="text-[10px] text-indigo-600 flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Hashing...
                  </span>
                )}
              </label>
              <div className="min-h-[18rem] border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50/80 dark:bg-gray-900/50 text-sm text-gray-800 dark:text-gray-200 overflow-auto prose-p:my-2 prose-ul:my-2 prose-ul:list-disc prose-ul:pl-5 prose-headings:font-semibold prose-a:text-indigo-600 dark:prose-invert">
                {draft.description.trim() ? (
                  <ReactMarkdown>{draft.description}</ReactMarkdown>
                ) : (
                  <span className="text-gray-400 dark:text-gray-500">
                    Nothing to preview yet.
                  </span>
                )}
              </div>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 flex items-center justify-between">
              Metadata Uri / IPFS Attachment
              <button
                type="button"
                onClick={handleIpfsUpload}
                disabled={isUploading || !draft.description.trim()}
                className="text-[10px] bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 px-2 py-0.5 rounded hover:bg-indigo-100 disabled:opacity-50 flex items-center gap-1"
              >
                {isUploading ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" /> Uploading...
                  </>
                ) : (
                  <>
                    <Share2 className="w-3 h-3" /> Upload to IPFS
                  </>
                )}
              </button>
            </label>
            <input
              type="text"
              value={draft.ipfsRef}
              onChange={(e) =>
                setDraft((d) => ({ ...d, ipfsRef: e.target.value }))
              }
              placeholder="ipfs://… or https://…"
              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 font-mono"
            />
            <p className="text-xs text-gray-400 mt-1">
              Points to the full proposal metadata. The description above will
              be hashed and stored on-chain.
            </p>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-6">
          <p className="text-sm text-gray-600">
            Optional on-chain actions after the vote passes. Leave empty to
            submit a governance-only signal (uses a safe{" "}
            <span className="font-mono">proposal_count</span> placeholder on the
            governor).
          </p>
          <button
            type="button"
            onClick={() =>
              setDraft((d) => ({ ...d, actions: [...d.actions, newAction()] }))
            }
            className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
          >
            + Add action
          </button>

          <ul className="space-y-4">
            {draft.actions.map((act, idx) => (
              <li
                key={act.id}
                className="border border-gray-200 dark:border-gray-700 rounded-xl p-4 bg-white dark:bg-gray-800 space-y-3"
              >
                <div className="flex justify-between items-center gap-2">
                  <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                    Action {idx + 1}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label="Move up"
                      disabled={idx === 0}
                      onClick={() =>
                        setDraft((d) => {
                          const a = [...d.actions];
                          [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]];
                          return { ...d, actions: a };
                        })
                      }
                      className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="Move down"
                      disabled={idx === draft.actions.length - 1}
                      onClick={() =>
                        setDraft((d) => {
                          const a = [...d.actions];
                          [a[idx + 1], a[idx]] = [a[idx], a[idx + 1]];
                          return { ...d, actions: a };
                        })
                      }
                      className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          actions: d.actions.filter((x) => x.id !== act.id),
                        }))
                      }
                      className="text-xs text-red-600 hover:text-red-800 ml-2"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-500">
                      Target (C… / G…)
                    </label>
                    <input
                      value={act.target}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDraft((d) => ({
                          ...d,
                          actions: d.actions.map((x) =>
                            x.id === act.id
                              ? { ...x, target: v, simulateOk: null }
                              : x,
                          ),
                        }));
                      }}
                      className="w-full mt-0.5 border rounded-lg px-2 py-1.5 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">
                      Function name
                    </label>
                    <input
                      value={act.fnName}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDraft((d) => ({
                          ...d,
                          actions: d.actions.map((x) =>
                            x.id === act.id
                              ? { ...x, fnName: v, simulateOk: null }
                              : x,
                          ),
                        }));
                      }}
                      className="w-full mt-0.5 border rounded-lg px-2 py-1.5 text-sm font-mono"
                    />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-500">Arguments</span>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          actions: d.actions.map((x) =>
                            x.id === act.id
                              ? {
                                  ...x,
                                  args: [...x.args, newArgRow()],
                                  simulateOk: null,
                                }
                              : x,
                          ),
                        }))
                      }
                      className="text-xs text-indigo-600"
                    >
                      + Arg
                    </button>
                  </div>
                  {act.args.map((row) => (
                    <div key={row.id} className="flex flex-wrap gap-2 mb-2">
                      <select
                        value={row.kind}
                        onChange={(e) => {
                          const kind = e.target.value as CalldataArgRow["kind"];
                          setDraft((d) => ({
                            ...d,
                            actions: d.actions.map((x) =>
                              x.id === act.id
                                ? {
                                    ...x,
                                    args: x.args.map((r) =>
                                      r.id === row.id ? { ...r, kind } : r,
                                    ),
                                    simulateOk: null,
                                  }
                                : x,
                            ),
                          }));
                        }}
                        className="bg-gray-50 border rounded text-xs px-1 py-1"
                      >
                        <option value="address">Address</option>
                        <option value="string">String</option>
                        <option value="u64">u64</option>
                        <option value="i128">i128</option>
                        <option value="bool">Bool</option>
                      </select>
                      <input
                        value={row.value}
                        onChange={(e) => {
                          const v = e.target.value;
                          setDraft((d) => ({
                            ...d,
                            actions: d.actions.map((x) =>
                              x.id === act.id
                                ? {
                                    ...x,
                                    args: x.args.map((r) =>
                                      r.id === row.id ? { ...r, value: v } : r,
                                    ),
                                    simulateOk: null,
                                  }
                                : x,
                            ),
                          }));
                        }}
                        placeholder="Value"
                        className="flex-1 min-w-[120px] border border-gray-200 rounded px-2 py-1 text-xs font-mono"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            actions: d.actions.map((x) =>
                              x.id === act.id
                                ? {
                                    ...x,
                                    args: x.args.filter((r) => r.id !== row.id),
                                    simulateOk: null,
                                  }
                                : x,
                            ),
                          }))
                        }
                        className="text-gray-400 hover:text-red-500"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div className="pt-2 flex items-center justify-between">
                  <button
                    type="button"
                    disabled={
                      !act.target.trim() ||
                      !act.fnName.trim() ||
                      simBusy === act.id
                    }
                    onClick={() => simulateAction(act)}
                    className="text-xs bg-gray-100 px-3 py-1.5 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                  >
                    {simBusy === act.id ? "Simulating..." : "Simulate action"}
                  </button>
                  {act.simulateOk === true && (
                    <span className="text-xs text-green-600 font-medium">
                      ✓ Ready
                    </span>
                  )}
                  {act.simulateOk === false && (
                    <span className="text-xs text-red-600 font-medium">
                      {act.simulateError
                        ? `Error: ${act.simulateError}`
                        : "Simulation failed"}
                    </span>
                  )}
                </div>
                {act.args.length > 0 &&
                  act.args.some((r) => r.value.trim() !== "") && (
                    <div className="mt-3 border-t border-gray-100 pt-3">
                      <p className="text-xs text-gray-500 mb-1">
                        Encoded calldata (hex)
                      </p>
                      <pre className="text-xs font-mono bg-gray-50 rounded-lg p-2 overflow-x-auto text-gray-700 break-all">
                        {getActionCalldataHex(act.args)}
                      </pre>
                      <p className="text-xs text-gray-400 mt-1">
                        {act.args.filter((r) => r.value.trim() !== "").length}{" "}
                        argument(s) encoded as XDR
                      </p>
                    </div>
                  )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-8">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-4">
              Review Content
            </h2>
            <div className="space-y-4">
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500 font-medium uppercase mb-1">
                  Title
                </p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">
                  {draft.title}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500 font-medium uppercase mb-1">
                  Description Hash (SHA-256)
                </p>
                <p className="text-sm font-mono text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-900 px-2 py-1 rounded">
                  {draft.descriptionHash || "Computing..."}
                </p>
              </div>
              <div className="prose prose-sm max-w-none text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900/50 p-4 rounded-xl dark:prose-invert">
                <ReactMarkdown>{draft.description}</ReactMarkdown>
              </div>
              {draft.ipfsRef && (
                <div className="flex items-center gap-2 text-xs text-indigo-600">
                  <LinkIcon className="w-3 h-3" />
                  <span className="font-medium">Metadata URI:</span>
                  <span className="font-mono">{draft.ipfsRef}</span>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-4">
              On-chain actions
            </h2>
            {draft.actions.length === 0 ? (
              <p className="text-sm text-gray-500 italic">
                No on-chain actions (signal only).
              </p>
            ) : (
              <ul className="space-y-4">
                {draft.actions.map((act, i) => (
                  <li
                    key={i}
                    className="text-sm font-mono bg-gray-50 dark:bg-gray-900 p-3 rounded-lg border border-gray-100 dark:border-gray-700"
                  >
                    <div className="text-indigo-600 dark:text-indigo-400 mb-1">
                      {act.target}
                    </div>
                    <div className="text-gray-900 dark:text-gray-200">
                      {act.fnName}({act.args.map((a) => a.value).join(", ")})
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {draft.actions.length > 0 && (
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
              <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-4">
                Preview Impact
              </h2>
              <ProposalImpactPreview
                results={impactResults}
                loading={impactLoading}
                error={impactError}
              />
            </div>
          )}

          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-6">
              Submission check
            </h2>
            <div className="space-y-6">
              {!isConnected ? (
                <div className="flex items-center gap-2 text-amber-700 bg-amber-50 p-4 rounded-xl text-sm">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  Please connect your wallet to verify permissions.
                </div>
              ) : reviewLoading && (votes === null || threshold === null) ? (
                <div className="flex items-center gap-2 text-gray-500 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Checking voting power...
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-6">
                    <div>
                      <p className="text-xs text-gray-400 dark:text-gray-500 font-medium uppercase mb-1">
                        Your Votes
                      </p>
                      <p className="text-xl font-bold text-gray-900 dark:text-white">
                        {votes === null
                          ? "..."
                          : (Number(votes) / 10 ** 7).toLocaleString()}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400 dark:text-gray-500 font-medium uppercase mb-1">
                        Threshold
                      </p>
                      <p className="text-xl font-bold text-gray-900 dark:text-white">
                        {threshold === null
                          ? "..."
                          : (
                              Number(effectiveThreshold ?? threshold) /
                              10 ** 7
                            ).toLocaleString()}
                      </p>
                    </div>
                  </div>

                  {threshold !== null &&
                    effectiveThreshold !== null &&
                    effectiveThreshold !== threshold &&
                    (() => {
                      const pctChange =
                        threshold === 0n
                          ? 0
                          : (Number(effectiveThreshold - threshold) /
                              Number(threshold)) *
                            100;
                      const isDiscount = pctChange < 0;
                      return (
                        <div
                          className={`text-sm p-3 rounded-xl border ${
                            isDiscount
                              ? "text-green-800 bg-green-50 border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-800"
                              : "text-rose-800 bg-rose-50 border-rose-200 dark:bg-rose-900/20 dark:text-rose-300 dark:border-rose-800"
                          }`}
                        >
                          Your reputation {isDiscount ? "discount" : "penalty"}:{" "}
                          {isDiscount ? "" : "+"}
                          {pctChange.toFixed(0)}% vs the flat threshold of{" "}
                          {(Number(threshold) / 10 ** 7).toLocaleString()} GOV.
                        </div>
                      );
                    })()}

                  {votes !== null &&
                    threshold !== null &&
                    votes < (effectiveThreshold ?? threshold) && (
                      <div className="flex items-start gap-3 text-amber-800 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-300 p-4 rounded-xl text-sm border border-amber-200 dark:border-amber-800">
                        <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                        <div>
                          <p className="font-semibold">
                            Insufficient voting power
                          </p>
                          <p className="mt-1">
                            You need{" "}
                            {(
                              Number(effectiveThreshold ?? threshold) /
                              10 ** 7
                            ).toLocaleString()}{" "}
                            GOV to create a proposal. Your current voting
                            power:{" "}
                            {(Number(votes) / 10 ** 7).toLocaleString()} GOV.
                          </p>
                          <p className="mt-2 text-sm font-medium">
                            Shortfall:{" "}
                            {(
                              Number((effectiveThreshold ?? threshold) - votes) /
                              10 ** 7
                            ).toLocaleString()}{" "}
                            GOV
                          </p>
                          <ul className="mt-2 text-xs list-disc list-inside space-y-0.5">
                            <li>Ask delegates to delegate to you</li>
                            <li>
                              Acquire more tokens and delegate to yourself
                            </li>
                          </ul>
                        </div>
                      </div>
                    )}

                  {baseVotes !== null &&
                    baseVotes > 0n &&
                    delegatee !== publicKey && (
                      <div className="flex items-center gap-3 text-blue-800 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-300 p-4 rounded-xl text-sm border border-blue-200 dark:border-blue-800">
                        <AlertCircle className="w-5 h-5 shrink-0" />
                        <p className="flex-1">
                          You have tokens but haven&apos;t delegated &mdash;
                          delegate to yourself first to activate your voting
                          power.
                        </p>
                        <button
                          type="button"
                          onClick={handleDelegateToSelf}
                          disabled={delegateBusy}
                          className="shrink-0 bg-indigo-600 text-white px-4 py-1.5 rounded-lg text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                        >
                          {delegateBusy
                            ? "Delegating..."
                            : "Delegate to yourself"}
                        </button>
                      </div>
                    )}
                </>
              )}

              {settings && (
                <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-xl p-4 space-y-2">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Rate limits
                  </p>
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Cooldown</span>
                      <span className="font-mono text-gray-900 dark:text-gray-200">
                        {ledgerToTimeEstimate(settings.proposalCooldown ?? 100)} ({settings.proposalCooldown ?? 100} ledgers)
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Max per period</span>
                      <span className="font-mono text-gray-900 dark:text-gray-200">
                        {settings.maxProposalsPerPeriod ?? 5}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Period</span>
                      <span className="font-mono text-gray-900 dark:text-gray-200">
                        {ledgerToTimeEstimate(settings.proposalPeriodDuration ?? 10_000)} ({settings.proposalPeriodDuration ?? 10_000} ledgers)
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {canProposeResult && !canProposeResult.allowed && (
                <div className="flex items-start gap-3 text-red-700 bg-red-50 dark:bg-red-900/20 dark:text-red-400 p-4 rounded-xl text-sm border border-red-100 dark:border-red-900/30">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">Rate limit active</p>
                    <p className="mt-1">{canProposeResult.reason}</p>
                    {canProposeResult.cooldownEndsAt && (
                      <p className="mt-2 text-xs">
                        <CountdownTimer
                          label="Estimated availability in"
                          targetLedger={canProposeResult.cooldownEndsAt}
                        />
                      </p>
                    )}
                  </div>
                </div>
              )}

              {estimate && (
                <div className="border-t border-gray-100 pt-6">
                  <p className="text-xs text-gray-400 font-medium uppercase mb-3">
                    Resource Estimate
                  </p>
                  <div className="flex gap-6 text-sm">
                    <div>
                      <span className="text-gray-500 mr-2">CPU:</span>
                      <span className="font-mono font-medium">
                        {Number(estimate.cpuInsns).toLocaleString()} cycles
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-500 mr-2">RAM:</span>
                      <span className="font-mono font-medium">
                        {(Number(estimate.memBytes) / 1024).toFixed(1)} KB
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {estimateErr && (
                <div className="p-3 bg-red-50 text-red-600 text-xs rounded-lg border border-red-100">
                  Simulation Warning: {estimateErr}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {step === 4 && successIdParam && (
        <div className="text-center space-y-4 py-12">
          <div className="bg-green-50 dark:bg-green-900/20 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6">
            <span className="text-3xl">🎉</span>
          </div>
          <p className="text-green-800 dark:text-green-400 font-semibold text-lg">
            Proposal created successfully
          </p>
          <p className="text-5xl font-mono font-bold text-gray-900 dark:text-white my-4">
            #{successIdParam}
          </p>
          <p className="text-gray-500 dark:text-gray-400 max-w-sm mx-auto mb-8">
            Your proposal is now live and waiting for the voting delay to pass
            before members can cast votes.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href={`/proposal/${successIdParam}`}
              className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-medium hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200 dark:shadow-none"
            >
              View Proposal
            </Link>
            <button
              onClick={() => router.push("/")}
              className="text-gray-600 dark:text-gray-300 px-8 py-3 rounded-xl font-medium hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              Back to dashboard
            </button>
          </div>
        </div>
      )}

      {step < 4 && (
        <div className="mt-12 flex items-center justify-between pt-6 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={() => step > 1 && setStep(step - 1)}
            disabled={step === 1 || submitting}
            className="text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-30"
          >
            Back
          </button>

          <div className="flex items-center gap-3">
            {stepErrors.length > 0 && (
              <span className="text-xs text-red-600 font-medium">
                {stepErrors[0]}
              </span>
            )}
            <button
              onClick={goNext}
              disabled={
                submitting ||
                (step === 3 &&
                  (!reviewDataReady ||
                    (votes !== null &&
                      threshold !== null &&
                      votes < (effectiveThreshold ?? threshold)) ||
                    (draft.actions.length > 0 &&
                      (impactLoading || impactAnyActionWouldRevert))))
              }
              className="bg-indigo-600 text-white px-8 py-2.5 rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors min-w-[120px]"
            >
              {submitting ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Submitting...
                </span>
              ) : step === 3 ? (
                "Submit Proposal"
              ) : (
                "Continue"
              )}
            </button>
          </div>
        </div>
      )}

      {submitError && (
        <div className="mt-6 p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm">
          {submitError}
        </div>
      )}
    </div>
  );
}

export default function ProposeWizard() {
  return (
    <Suspense
      fallback={
        <div className="p-8 text-center text-gray-500">Loading wizard...</div>
      }
    >
      <ProposeWizardInner />
    </Suspense>
  );
}
