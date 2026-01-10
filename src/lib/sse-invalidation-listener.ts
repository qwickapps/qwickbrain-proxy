import { EventSource } from 'eventsource';
import type { CacheManager } from './cache-manager.js';

interface InvalidationEvent {
  type: 'document' | 'memory';
  docType?: string; // For document invalidation
  name: string;
  project?: string;
}

export class SSEInvalidationListener {
  private eventSource: EventSource | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectDelay = 5000; // 5 seconds
  private isActive = false;

  constructor(
    private url: string,
    private cacheManager: CacheManager,
    private apiKey?: string
  ) {}

  /**
   * Start listening for SSE invalidation events
   */
  async start(): Promise<void> {
    if (this.isActive) {
      return;
    }

    this.isActive = true;
    this.connect();
  }

  private connect(): void {
    if (!this.isActive) {
      return;
    }

    try {
      // Build SSE endpoint URL
      const sseUrl = new URL('/sse/cache-invalidation', this.url);

      // Configure EventSource with auth header if needed
      const eventSourceInitDict: any = {
        headers: {},
      };

      if (this.apiKey) {
        eventSourceInitDict.headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      this.eventSource = new EventSource(sseUrl.toString(), eventSourceInitDict);

      this.eventSource.onopen = () => {
        console.error('SSE invalidation listener connected');
        // Clear reconnect timeout on successful connection
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
      };

      this.eventSource.onerror = (error: any) => {
        console.error('SSE invalidation listener error:', error);
        this.eventSource?.close();
        this.eventSource = null;

        // Schedule reconnection
        if (this.isActive && !this.reconnectTimeout) {
          console.error(`SSE reconnecting in ${this.reconnectDelay}ms...`);
          this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect();
          }, this.reconnectDelay);
        }
      };

      // Listen for document invalidation events
      this.eventSource.addEventListener('document:invalidate', (event: MessageEvent) => {
        this.handleInvalidationEvent(event.data);
      });

      // Listen for memory invalidation events
      this.eventSource.addEventListener('memory:invalidate', (event: MessageEvent) => {
        this.handleInvalidationEvent(event.data);
      });

      // Listen for batch invalidation events (multiple items)
      this.eventSource.addEventListener('cache:invalidate:batch', (event: MessageEvent) => {
        this.handleBatchInvalidation(event.data);
      });
    } catch (error) {
      console.error('Failed to connect SSE invalidation listener:', error);
      // Schedule retry
      if (this.isActive && !this.reconnectTimeout) {
        this.reconnectTimeout = setTimeout(() => {
          this.reconnectTimeout = null;
          this.connect();
        }, this.reconnectDelay);
      }
    }
  }

  private async handleInvalidationEvent(data: string): Promise<void> {
    try {
      const event: InvalidationEvent = JSON.parse(data);

      if (event.type === 'document') {
        if (!event.docType) {
          console.error('Invalid document invalidation event: missing docType');
          return;
        }
        await this.cacheManager.invalidateDocument(event.docType, event.name, event.project);
        console.error(`Cache invalidated via SSE: ${event.docType}:${event.name}`);
      } else if (event.type === 'memory') {
        await this.cacheManager.invalidateMemory(event.name, event.project);
        console.error(`Cache invalidated via SSE: memory:${event.name}`);
      }
    } catch (error) {
      console.error('Failed to parse invalidation event:', error);
    }
  }

  private async handleBatchInvalidation(data: string): Promise<void> {
    try {
      const events: InvalidationEvent[] = JSON.parse(data);

      // Process invalidations in parallel
      await Promise.all(
        events.map(async (event) => {
          if (event.type === 'document' && event.docType) {
            await this.cacheManager.invalidateDocument(event.docType, event.name, event.project);
          } else if (event.type === 'memory') {
            await this.cacheManager.invalidateMemory(event.name, event.project);
          }
        })
      );

      console.error(`Batch cache invalidation: ${events.length} items`);
    } catch (error) {
      console.error('Failed to parse batch invalidation event:', error);
    }
  }

  /**
   * Stop listening for SSE events
   */
  stop(): void {
    this.isActive = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    console.error('SSE invalidation listener stopped');
  }

  /**
   * Check if listener is active
   */
  isListening(): boolean {
    return this.isActive && this.eventSource !== null && this.eventSource.readyState === EventSource.OPEN;
  }
}
