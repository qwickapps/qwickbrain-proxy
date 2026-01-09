import { EventEmitter } from 'events';
import { ConnectionState } from '../types/mcp.js';
import type { Config } from '../types/config.js';
import type { QwickBrainClient } from './qwickbrain-client.js';

export class ConnectionManager extends EventEmitter {
  private state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private qwickbrainClient: QwickBrainClient;
  private config: Config['connection'];
  private isStopped = false;
  private executionLock: Promise<void> = Promise.resolve();

  constructor(qwickbrainClient: QwickBrainClient, config: Config['connection']) {
    super();
    this.qwickbrainClient = qwickbrainClient;
    this.config = config;
  }

  getState(): ConnectionState {
    return this.state;
  }

  setState(state: ConnectionState): void {
    const previousState = this.state;
    this.state = state;

    if (previousState !== state) {
      this.emit('stateChange', { from: previousState, to: state });
    }
  }

  async start(): Promise<void> {
    this.isStopped = false;
    // Start health check in background (don't block server startup)
    this.healthCheck().catch(err => {
      console.error('Initial health check error:', err);
    });
    this.scheduleHealthCheck();
  }

  stop(): void {
    this.isStopped = true;
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setState('offline');
  }

  async healthCheck(): Promise<boolean> {
    const startTime = Date.now();

    try {
      const isHealthy = await this.qwickbrainClient.healthCheck();
      const latencyMs = Date.now() - startTime;

      if (isHealthy) {
        this.setState('connected');
        this.reconnectAttempts = 0;
        this.clearReconnectTimer();
        this.emit('connected', { latencyMs });
        return true;
      } else {
        throw new Error('Health check failed');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.setState('disconnected');
      this.emit('disconnected', { error: errorMessage });
      this.scheduleReconnect();
      return false;
    }
  }

  private scheduleHealthCheck(): void {
    // Don't schedule if stopped
    if (this.isStopped) {
      return;
    }

    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
    }

    this.healthCheckTimer = setTimeout(async () => {
      await this.healthCheck();
      // Check again before rescheduling to prevent leak after stop()
      if (!this.isStopped) {
        this.scheduleHealthCheck();
      }
    }, this.config.healthCheckInterval);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.setState('offline');
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    const delay = Math.min(
      this.config.reconnectBackoff.initial *
        Math.pow(this.config.reconnectBackoff.multiplier, this.reconnectAttempts),
      this.config.reconnectBackoff.max
    );

    this.reconnectAttempts++;
    this.setState('reconnecting');

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.healthCheck();
    }, delay);

    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  recordFailure(): void {
    if (this.state === 'connected') {
      this.setState('disconnected');
      this.scheduleReconnect();
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Wait for any ongoing state transitions to complete
    await this.executionLock;

    // Atomically check state and execute
    if (this.state !== 'connected') {
      throw new Error(`QwickBrain unavailable (state: ${this.state})`);
    }

    try {
      return await fn();
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }
}
