import { timestamp } from '../../core/src/index.js';
import type { HistogramSnapshot, MetricKind, MetricSnapshot, MetricsSnapshot } from './types.js';

interface MetricState {
  kind: MetricKind;
  value: number;
  samples: number[];
  labels: Record<string, string>;
  updatedAt: string;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function histogram(samples: number[]): HistogramSnapshot {
  if (!samples.length) return { count: 0, sum: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
  return { count: samples.length, sum: samples.reduce((sum, value) => sum + value, 0), min: Math.min(...samples), max: Math.max(...samples), p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), p99: percentile(samples, 0.99) };
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, MetricState>();
  constructor(private readonly maxSamples = 10_000) {}

  counter(name: string, delta = 1, labels: Record<string, string> = {}): number {
    const metric = this.ensure(name, 'counter', labels);
    metric.value += delta;
    metric.updatedAt = timestamp();
    return metric.value;
  }

  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const metric = this.ensure(name, 'gauge', labels);
    metric.value = value;
    metric.updatedAt = timestamp();
  }

  histogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const metric = this.ensure(name, 'histogram', labels);
    metric.samples.push(value);
    if (metric.samples.length > this.maxSamples) metric.samples.splice(0, metric.samples.length - this.maxSamples);
    metric.value = value;
    metric.updatedAt = timestamp();
  }

  get(name: string, labels: Record<string, string> = {}): MetricSnapshot | undefined {
    const state = this.metrics.get(this.key(name, labels));
    return state ? this.toSnapshot(name, state) : undefined;
  }

  snapshot(): MetricsSnapshot {
    return { generatedAt: timestamp(), metrics: [...this.metrics.entries()].map(([key, state]) => this.toSnapshot(key.split('|')[0] ?? key, state)) };
  }

  json(): string { return JSON.stringify(this.snapshot(), null, 2); }

  prometheus(): string {
    return this.snapshot().metrics.map((metric) => {
      const labels = Object.entries(metric.labels).map(([key, value]) => `${key}="${value.replaceAll('"', '\\"')}"`).join(',');
      const labelSuffix = labels ? `{${labels}}` : '';
      if (metric.kind !== 'histogram') return `${metric.name}${labelSuffix} ${metric.value}`;
      const value = metric.value as HistogramSnapshot;
      return [`${metric.name}_count${labelSuffix} ${value.count}`, `${metric.name}_sum${labelSuffix} ${value.sum}`, `${metric.name}_p50${labelSuffix} ${value.p50}`, `${metric.name}_p95${labelSuffix} ${value.p95}`, `${metric.name}_p99${labelSuffix} ${value.p99}`].join('\n');
    }).join('\n');
  }

  clear(): void { this.metrics.clear(); }

  private ensure(name: string, kind: MetricKind, labels: Record<string, string>): MetricState {
    const key = this.key(name, labels);
    const existing = this.metrics.get(key);
    if (existing) {
      if (existing.kind !== kind) throw new Error(`metric ${name} already registered as ${existing.kind}`);
      return existing;
    }
    const state: MetricState = { kind, value: 0, samples: [], labels: { ...labels }, updatedAt: timestamp() };
    this.metrics.set(key, state);
    return state;
  }

  private key(name: string, labels: Record<string, string>): string { return `${name}|${JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))}`; }

  private toSnapshot(name: string, state: MetricState): MetricSnapshot { return { name, kind: state.kind, value: state.kind === 'histogram' ? histogram(state.samples) : state.value, labels: { ...state.labels }, updatedAt: state.updatedAt }; }
}
