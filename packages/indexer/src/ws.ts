import { IncomingMessage, Server as HttpServer } from "http";
import { WebSocket, WebSocketServer } from "ws";

export type WsEventType =
  | "proposal_created"
  | "vote_cast"
  | "proposal_queued"
  | "proposal_executed"
  | "proposal_cancelled"
  | "delegate_changed"
  | "config_updated"
  | "governor_upgraded"
  | "wrapper_deposit"
  | "wrapper_withdrawal"
  | "liquidity_added"
  | "liquidity_removed"
  | "swap"
  | "pool_fee_updated"
  | "draft_created"
  | "co_sponsored"
  | "co_sponsorship_withdrawn"
  | "draft_finalized"
  | "draft_cancelled"
  | "draft_expired"
  | "delegation_registered"
  | "delegation_revoked"
  | "delegation_depth_limit_updated"
  | "analytics_snapshot_taken"
  | "reputation_updated"
  | "effective_threshold_changed"
  | "delegated_by_sig"
  | "permits_invalidated"
  | "relayer_whitelist_updated"
  | "split_delegated"
  | "split_undelegated"
  | "timelock_operation_scheduled"
  | "timelock_operation_executed"
  | "timelock_operation_cancelled"
  | "timelock_batch_operation_scheduled"
  | "timelock_batch_operation_executed"
  | "timelock_batch_operation_cancelled"
  | "timelock_min_delay_updated"
  | "timelock_dependency_dag_validated"
  | "timelock_cycle_detected"
  | "timelock_partial_batch_started"
  | "timelock_partial_op_succeeded"
  | "timelock_partial_op_failed"
  | "timelock_batch_recovery_entered"
  | "timelock_failed_op_retried"
  | "timelock_failed_op_skipped"
  | "timelock_batch_fully_complete"
  | "stream_created"
  | "stream_spend"
  | "stream_batch"
  | "stream_revoked"
  | "stream_extended"
  | "stream_topped_up"
  | "stream_exhausted"
  | "stream_expired"
  | "treasury_stream_completed"
  | "conviction_proposal_created"
  | "conviction_stake_updated"
  | "conviction_conviction_updated"
  | "conviction_proposal_executed"
  | "conviction_proposal_cancelled"
  | "bond_locked"
  | "bond_refunded"
  | "bond_slashed"
  | "optimistic_proposal_created"
  | "optimistic_objection_cast"
  | "optimistic_proposal_objected"
  | "optimistic_proposal_passed"
  | "optimistic_proposal_executed"
  | "optimistic_proposal_cancelled"
  | "result_anchored"
  | "strategy_registered"
  | "strategy_deactivated"
  | "strategy_deposited"
  | "strategy_withdrawal_requested"
  | "strategy_withdrawal_claimed"
  | "vote_escrow_lock_created"
  | "vote_escrow_lock_increased"
  | "vote_escrow_lock_extended"
  | "vote_escrow_lock_withdrawn"
  | "action_proposed"
  | "action_approved"
  | "approval_revoked"
  | "action_executed"
  | "membership_rotated"
  | "threshold_updated"
  | "action_ttl_updated";

export interface WsEvent {
  type: WsEventType;
  data: Record<string, unknown>;
}

interface SubscriptionFilter {
  types?: WsEventType[];
  proposalId?: string;
  streamId?: string;
  state?: string;
}

interface SubscribedClient {
  socket: WebSocket;
  filter: SubscriptionFilter;
  missedPings: number;
}

const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_MISSED_PINGS = 3;

const clients = new Set<SubscribedClient>();

/**
 * Proposal lifecycle state implied by each event type. Succeeded/Defeated/Expired
 * are derived purely from ledger time rather than an on-chain event, so they have
 * no entry here and can't be matched by a `state` filter.
 */
const EVENT_STATE: Partial<Record<WsEventType, string>> = {
  proposal_created: "Pending",
  vote_cast: "Active",
  proposal_queued: "Queued",
  proposal_executed: "Executed",
  proposal_cancelled: "Cancelled",
};

function matchesFilter(event: WsEvent, filter: SubscriptionFilter): boolean {
  if (filter.types && filter.types.length > 0) {
    if (!filter.types.includes(event.type)) return false;
  }
  if (filter.proposalId !== undefined) {
    const pid = (event.data as any).proposal_id ?? (event.data as any).id;
    if (String(pid) !== filter.proposalId) return false;
  }
  if (filter.streamId !== undefined) {
    const streamId = (event.data as any).stream_id;
    if (String(streamId) !== filter.streamId) return false;
  }
  if (filter.state !== undefined) {
    if (EVENT_STATE[event.type] !== filter.state) return false;
  }
  return true;
}

export function broadcast(event: WsEvent): void {
  const payload = JSON.stringify(event, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  for (const client of clients) {
    if (
      client.socket.readyState === WebSocket.OPEN &&
      matchesFilter(event, client.filter)
    ) {
      client.socket.send(payload);
    }
  }
}

export function createWsServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/events" });

  wss.on("connection", (socket: WebSocket, _req: IncomingMessage) => {
    const entry: SubscribedClient = { socket, filter: {}, missedPings: 0 };
    clients.add(entry);

    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          types?: WsEventType[];
          proposalId?: string;
          streamId?: string;
          subscribe?: "proposal" | "stream" | "state";
          proposal_id?: string | number;
          stream_id?: string | number;
          state?: string;
        };
        if (Array.isArray(msg.types)) entry.filter.types = msg.types;
        if (typeof msg.proposalId === "string")
          entry.filter.proposalId = msg.proposalId;
        if (typeof msg.streamId === "string")
          entry.filter.streamId = msg.streamId;

        // { subscribe: "proposal", proposal_id: 42 } / { subscribe: "state", state: "Active" }
        if (msg.subscribe === "proposal" && msg.proposal_id !== undefined) {
          entry.filter.proposalId = String(msg.proposal_id);
        } else if (msg.subscribe === "stream" && msg.stream_id !== undefined) {
          entry.filter.streamId = String(msg.stream_id);
        } else if (msg.subscribe === "state" && typeof msg.state === "string") {
          entry.filter.state = msg.state;
        }
      } catch {
        /* ignore malformed filter messages */
      }
    });

    socket.on("pong", () => {
      entry.missedPings = 0;
    });

    socket.on("close", () => {
      clients.delete(entry);
    });

    socket.on("error", () => {
      clients.delete(entry);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.missedPings >= MAX_MISSED_PINGS) {
        client.socket.terminate();
        clients.delete(client);
        continue;
      }
      if (client.socket.readyState === WebSocket.OPEN) {
        client.missedPings += 1;
        client.socket.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  wss.on("close", () => {
    clearInterval(heartbeat);
  });

  return wss;
}

export function getConnectedClientCount(): number {
  return clients.size;
}

export function clearClients(): void {
  clients.clear();
}
