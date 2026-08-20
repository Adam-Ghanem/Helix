import { id, timestamp } from '../../core/src/index.js';

export interface Span {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'ok' | 'error';
  attributes: Record<string, string | number | boolean>;
  error?: string;
}

export interface Metric {
  name: string;
  value: number;
  timestamp: string;
  attributes: Record<string, string>;
}

export interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  attributes: Record<string, unknown>;
}

export class Telemetry {
  private readonly spans: Span[] = [];
  private readonly metrics: Metric[] = [];
  private readonly logs: LogRecord[] = [];

  startSpan(name: string, attributes: Span['attributes'] = {}, parent?: Span): Span {
    const span: Span = { id: id('span'), traceId: parent?.traceId ?? id('trace'), ...(parent ? { parentId: parent.id } : {}), name, startedAt: timestamp(), status: 'running', attributes: { ...attributes } };
    this.spans.push(span);
    return span;
  }

  endSpan(span: Span, status: 'ok' | 'error' = 'ok', error?: string): void {
    span.endedAt = timestamp();
    span.status = status;
    if (error) span.error = error;
  }

  recordMetric(name: string, value: number, attributes: Record<string, string> = {}): void {
    this.metrics.push({ name, value, timestamp: timestamp(), attributes: { ...attributes } });
  }

  log(level: LogRecord['level'], message: string, attributes: Record<string, unknown> = {}): void {
    this.logs.push({ level, message, timestamp: timestamp(), attributes: { ...attributes } });
  }

  snapshot(): { spans: Span[]; metrics: Metric[]; logs: LogRecord[] } {
    return { spans: structuredClone(this.spans), metrics: structuredClone(this.metrics), logs: structuredClone(this.logs) };
  }

  clear(): void {
    this.spans.length = 0;
    this.metrics.length = 0;
    this.logs.length = 0;
  }
}
