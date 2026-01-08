import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConnectionManager } from '../connection-manager.js';
import type { QwickBrainClient } from '../qwickbrain-client.js';
import type { Config } from '../../types/config.js';

describe('ConnectionManager', () => {
  let mockClient: QwickBrainClient;
  let connectionManager: ConnectionManager;
  let config: Config['connection'];

  beforeEach(() => {
    config = {
      healthCheckInterval: 100, // Short interval for testing
      timeout: 5000,
      maxReconnectAttempts: 3,
      reconnectBackoff: {
        initial: 50,
        multiplier: 2,
        max: 500,
      },
    };

    mockClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
    } as unknown as QwickBrainClient;

    connectionManager = new ConnectionManager(mockClient, config);
  });

  afterEach(() => {
    connectionManager.stop();
  });

  describe('getState', () => {
    it('should return initial state as disconnected', () => {
      expect(connectionManager.getState()).toBe('disconnected');
    });
  });

  describe('start and healthCheck', () => {
    it('should transition to connected on successful health check', async () => {
      await connectionManager.start();

      expect(connectionManager.getState()).toBe('connected');
      expect(mockClient.healthCheck).toHaveBeenCalled();
    });

    it('should transition to reconnecting after failed health check', async () => {
      mockClient.healthCheck = vi.fn().mockRejectedValue(new Error('Connection failed'));

      await connectionManager.start();

      // After health check fails, it immediately schedules reconnect
      expect(connectionManager.getState()).toBe('reconnecting');
    });

    it('should emit stateChange event on state transition', async () => {
      const stateChangeListener = vi.fn();
      connectionManager.on('stateChange', stateChangeListener);

      await connectionManager.start();

      expect(stateChangeListener).toHaveBeenCalledWith({
        from: 'disconnected',
        to: 'connected',
      });
    });

    it('should emit connected event with latency', async () => {
      const connectedListener = vi.fn();
      connectionManager.on('connected', connectedListener);

      await connectionManager.start();

      expect(connectedListener).toHaveBeenCalled();
      const call = connectedListener.mock.calls[0][0];
      expect(call).toHaveProperty('latencyMs');
      expect(typeof call.latencyMs).toBe('number');
    });

    it('should emit disconnected event on failure', async () => {
      mockClient.healthCheck = vi.fn().mockRejectedValue(new Error('Failed'));
      const disconnectedListener = vi.fn();
      connectionManager.on('disconnected', disconnectedListener);

      await connectionManager.start();

      expect(disconnectedListener).toHaveBeenCalled();
      expect(disconnectedListener.mock.calls[0][0]).toHaveProperty('error');
    });
  });

  describe('stop', () => {
    it('should transition to offline state', () => {
      connectionManager.stop();

      expect(connectionManager.getState()).toBe('offline');
    });

    it('should stop health check timer', async () => {
      await connectionManager.start();
      const healthCheckCount = (mockClient.healthCheck as any).mock.calls.length;

      connectionManager.stop();

      // Wait longer than health check interval
      await new Promise(resolve => setTimeout(resolve, 300));

      // Health check should not have been called again
      expect((mockClient.healthCheck as any).mock.calls.length).toBe(healthCheckCount);
    });
  });

  describe('reconnection logic', () => {
    it('should attempt to reconnect on health check failure', async () => {
      let callCount = 0;
      mockClient.healthCheck = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Failed'));
        }
        return Promise.resolve(true);
      });

      const reconnectingListener = vi.fn();
      connectionManager.on('reconnecting', reconnectingListener);

      await connectionManager.start();

      // Wait for reconnect attempt
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(reconnectingListener).toHaveBeenCalled();
      expect(reconnectingListener.mock.calls[0][0]).toHaveProperty('attempt');
      expect(reconnectingListener.mock.calls[0][0]).toHaveProperty('delay');
    });

    it('should use exponential backoff for reconnection', async () => {
      mockClient.healthCheck = vi.fn().mockRejectedValue(new Error('Failed'));

      const reconnectingListener = vi.fn();
      connectionManager.on('reconnecting', reconnectingListener);

      await connectionManager.start();

      // Wait for multiple reconnect attempts
      await new Promise(resolve => setTimeout(resolve, 500));

      const delays = reconnectingListener.mock.calls.map(call => call[0].delay);

      // Delays should increase exponentially
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThan(delays[i - 1]);
      }
    });

    it('should emit maxReconnectAttemptsReached after max attempts', async () => {
      mockClient.healthCheck = vi.fn().mockRejectedValue(new Error('Failed'));

      const maxAttemptsListener = vi.fn();
      connectionManager.on('maxReconnectAttemptsReached', maxAttemptsListener);

      await connectionManager.start();

      // Wait for all reconnect attempts
      await new Promise(resolve => setTimeout(resolve, 2000));

      expect(maxAttemptsListener).toHaveBeenCalled();
      expect(connectionManager.getState()).toBe('offline');
    });

    it('should reset reconnect attempts on successful connection', async () => {
      let callCount = 0;
      mockClient.healthCheck = vi.fn().mockImplementation(() => {
        callCount++;
        // Fail first two, then succeed
        if (callCount <= 2) {
          return Promise.reject(new Error('Failed'));
        }
        return Promise.resolve(true);
      });

      await connectionManager.start();

      // Wait for reconnection
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(connectionManager.getState()).toBe('connected');
    });
  });

  describe('execute', () => {
    it('should execute function when connected', async () => {
      await connectionManager.start();

      const testFn = vi.fn().mockResolvedValue('result');
      const result = await connectionManager.execute(testFn);

      expect(result).toBe('result');
      expect(testFn).toHaveBeenCalled();
    });

    it('should throw error when not connected', async () => {
      const testFn = vi.fn();

      await expect(connectionManager.execute(testFn)).rejects.toThrow('QwickBrain unavailable');
      expect(testFn).not.toHaveBeenCalled();
    });

    it('should record failure if execution throws', async () => {
      await connectionManager.start();

      const testFn = vi.fn().mockRejectedValue(new Error('Execution failed'));

      await expect(connectionManager.execute(testFn)).rejects.toThrow('Execution failed');

      // Should transition to reconnecting after failure
      expect(connectionManager.getState()).toBe('reconnecting');
    });

    it('should wait for state transitions to complete (race condition test)', async () => {
      await connectionManager.start();

      // Simulate rapid state changes
      connectionManager.setState('disconnected');
      connectionManager.setState('connected');

      const testFn = vi.fn().mockResolvedValue('result');

      // This should wait for state transitions to settle
      const result = await connectionManager.execute(testFn);

      expect(result).toBe('result');
    });
  });

  describe('recordFailure', () => {
    it('should transition to reconnecting when connected', () => {
      connectionManager['state'] = 'connected';

      connectionManager.recordFailure();

      // After failure, it immediately schedules reconnect
      expect(connectionManager.getState()).toBe('reconnecting');
    });

    it('should not affect offline state', () => {
      connectionManager.stop();

      connectionManager.recordFailure();

      expect(connectionManager.getState()).toBe('offline');
    });
  });
});
