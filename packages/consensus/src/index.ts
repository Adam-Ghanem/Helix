export type ConsensusStrategy = 'majority' | 'weighted-majority' | 'quorum' | 'leader' | 'jury' | 'confidence-weighted';

export interface Vote<T> {
  voterId: string;
  value: T;
  weight?: number;
  confidence?: number;
  evidence?: string[];
}

export interface ConsensusResult<T> {
  reached: boolean;
  value?: T;
  strategy: ConsensusStrategy;
  participation: number;
  support: number;
  threshold: number;
  votes: Vote<T>[];
}

export interface ConsensusOptions<T> {
  strategy: ConsensusStrategy;
  threshold?: number;
  quorum?: number;
  leaderId?: string;
  jurySize?: number;
  equals?: (left: T, right: T) => boolean;
}

export function decide<T>(votes: Vote<T>[], options: ConsensusOptions<T>): ConsensusResult<T> {
  if (!votes.length) return { reached: false, strategy: options.strategy, participation: 0, support: 0, threshold: options.threshold ?? 0.5, votes: [] };
  const equals = options.equals ?? ((left, right) => JSON.stringify(left) === JSON.stringify(right));
  const groups: Array<{ value: T; votes: Vote<T>[]; score: number }> = [];
  for (const vote of votes) {
    let group = groups.find((candidate) => equals(candidate.value, vote.value));
    if (!group) {
      group = { value: vote.value, votes: [], score: 0 };
      groups.push(group);
    }
    group.votes.push(vote);
    group.score += score(vote, options.strategy);
  }
  groups.sort((left, right) => right.score - left.score);
  const winner = groups[0]!;
  const total = groups.reduce((sum, group) => sum + group.score, 0);
  const support = total ? winner.score / total : 0;
  const threshold = options.threshold ?? (options.strategy === 'quorum' ? 0.66 : 0.5);
  const participation = votes.length;
  const quorumReached = participation >= Math.ceil((options.quorum ?? 0) * votes.length);
  const leaderOk = options.strategy !== 'leader' || winner.votes.some((vote) => vote.voterId === options.leaderId);
  const juryOk = options.strategy !== 'jury' || winner.votes.length >= (options.jurySize ?? 3);
  return { reached: support >= threshold && quorumReached && leaderOk && juryOk, value: winner.value, strategy: options.strategy, participation, support, threshold, votes: winner.votes.map((vote) => structuredClone(vote)) };
}

function score<T>(vote: Vote<T>, strategy: ConsensusStrategy): number {
  if (strategy === 'majority' || strategy === 'quorum' || strategy === 'jury' || strategy === 'leader') return 1;
  if (strategy === 'weighted-majority') return vote.weight ?? 1;
  return (vote.weight ?? 1) * (vote.confidence ?? 0.5);
}
