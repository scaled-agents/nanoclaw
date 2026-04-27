/**
 * Types for the deterministic deploy ticker service.
 * Replaces monitor-deploy LLM task.
 */

// ─── Candidate Types ─────────────────────────────────────────────

export type CandidateSource =
  | 'kata_graduated'
  | 'roster_graduated'
  | 'qualifier'
  | 'untested'
  | 'competition_queue';

export interface DeployCandidate {
  strategy: string;
  strategy_path?: string;
  pair: string;
  timeframe: string;
  archetype: string;
  correlation_group: string;
  source: CandidateSource;
  quality: number;
  favorable_sharpe: number | null;
  gap_score: number;
  deployment_failures: number;
  ranked_score?: number;
}

// ─── Verification Types ──────────────────────────────────────────

export interface VerificationResult {
  passed: boolean;
  trade_count: number;
  win_rate: number;
  regime_blocked: boolean;
  reason?: string;
}

// ─── Tick Result ─────────────────────────────────────────────────

export interface DeployTickResult {
  deployed: number;
  verified: number;
  replaced: number;
  skipped_guard?: string;
  slot_summary: {
    graduated: number;
    trials: number;
    total: number;
    trial_room: number;
  };
}

// ─── Dependencies ────────────────────────────────────────────────

export interface DeployTickerDeps {
  startBotContainer: (req: {
    type: 'start_bot';
    deployment_id: string;
    strategy_name: string;
    pair: string;
    timeframe: string;
    group_folder: string;
    dry_run: boolean;
  }) => Promise<{
    deploymentId: string;
    containerName: string;
    port: number;
    startedAt: string;
  }>;
  stopBotContainer: (deploymentId: string) => Promise<void>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  chatJid: string;
}
