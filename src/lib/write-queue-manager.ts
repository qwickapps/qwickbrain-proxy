import { eq, and, or } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { syncQueue } from '../db/schema.js';
import type { QwickBrainClient } from './qwickbrain-client.js';

interface QueuedOperation {
  id: number;
  operation: string;
  payload: string;
  createdAt: Date;
  status: string;
  error: string | null;
  attempts: number;
  lastAttemptAt: Date | null;
}

interface CreateDocumentPayload {
  docType: string;
  name: string;
  content: string;
  project?: string;
  metadata?: Record<string, unknown>;
}

interface SetMemoryPayload {
  name: string;
  content: string;
  project?: string;
  metadata?: Record<string, unknown>;
}

interface DeleteDocumentPayload {
  docType: string;
  name: string;
  project?: string;
}

interface DeleteMemoryPayload {
  name: string;
  project?: string;
}

type OperationPayload =
  | CreateDocumentPayload
  | SetMemoryPayload
  | DeleteDocumentPayload
  | DeleteMemoryPayload;

export class WriteQueueManager {
  private maxAttempts = 3;
  private isSyncing = false;

  constructor(
    private db: DB,
    private qwickbrainClient: QwickBrainClient
  ) {}

  /**
   * Queue a write operation for later sync
   */
  async queueOperation(operation: string, payload: OperationPayload): Promise<void> {
    await this.db.insert(syncQueue).values({
      operation,
      payload: JSON.stringify(payload),
      status: 'pending',
      attempts: 0,
    });

    console.error(`Queued operation: ${operation}`);
  }

  /**
   * Get count of pending operations
   */
  async getPendingCount(): Promise<number> {
    const result = await this.db
      .select()
      .from(syncQueue)
      .where(eq(syncQueue.status, 'pending'));

    return result.length;
  }

  /**
   * Sync all pending operations
   * Returns number of operations synced successfully
   */
  async syncPendingOperations(): Promise<{ synced: number; failed: number }> {
    if (this.isSyncing) {
      console.error('Sync already in progress, skipping');
      return { synced: 0, failed: 0 };
    }

    this.isSyncing = true;
    let synced = 0;
    let failed = 0;

    try {
      // Get all pending operations, ordered by creation time (FIFO)
      const pending = await this.db
        .select()
        .from(syncQueue)
        .where(eq(syncQueue.status, 'pending'))
        .orderBy(syncQueue.createdAt);

      console.error(`Syncing ${pending.length} pending operations...`);

      for (const item of pending) {
        try {
          await this.executeOperation(item);

          // Mark as completed
          await this.db
            .update(syncQueue)
            .set({ status: 'completed' })
            .where(eq(syncQueue.id, item.id));

          synced++;
          console.error(`Synced operation ${item.id}: ${item.operation}`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const newAttempts = item.attempts + 1;

          if (newAttempts >= this.maxAttempts) {
            // Max attempts reached, mark as failed
            await this.db
              .update(syncQueue)
              .set({
                status: 'failed',
                error: errorMessage,
                attempts: newAttempts,
                lastAttemptAt: new Date(),
              })
              .where(eq(syncQueue.id, item.id));

            failed++;
            console.error(`Operation ${item.id} failed after ${newAttempts} attempts: ${errorMessage}`);
          } else {
            // Increment attempts, keep as pending
            await this.db
              .update(syncQueue)
              .set({
                attempts: newAttempts,
                lastAttemptAt: new Date(),
                error: errorMessage,
              })
              .where(eq(syncQueue.id, item.id));

            console.error(`Operation ${item.id} failed (attempt ${newAttempts}/${this.maxAttempts}): ${errorMessage}`);
          }
        }
      }

      // Clean up completed operations (keep failed ones for inspection)
      await this.cleanupCompleted();

      console.error(`Sync complete: ${synced} synced, ${failed} failed`);
      return { synced, failed };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Execute a single queued operation
   */
  private async executeOperation(item: QueuedOperation): Promise<void> {
    const payload = JSON.parse(item.payload);

    switch (item.operation) {
      case 'create_document':
      case 'update_document': {
        const p = payload as CreateDocumentPayload;
        await this.qwickbrainClient.createDocument(
          p.docType,
          p.name,
          p.content,
          p.project,
          p.metadata
        );
        break;
      }

      case 'set_memory':
      case 'update_memory': {
        const p = payload as SetMemoryPayload;
        await this.qwickbrainClient.setMemory(p.name, p.content, p.project, p.metadata);
        break;
      }

      case 'delete_document': {
        const p = payload as DeleteDocumentPayload;
        await this.qwickbrainClient.deleteDocument(p.docType, p.name, p.project);
        break;
      }

      case 'delete_memory': {
        const p = payload as DeleteMemoryPayload;
        await this.qwickbrainClient.deleteMemory(p.name, p.project);
        break;
      }

      default:
        throw new Error(`Unknown operation: ${item.operation}`);
    }
  }

  /**
   * Clean up completed operations
   */
  private async cleanupCompleted(): Promise<void> {
    await this.db.delete(syncQueue).where(eq(syncQueue.status, 'completed'));
  }

  /**
   * Get failed operations for inspection
   */
  async getFailedOperations(): Promise<QueuedOperation[]> {
    return await this.db
      .select()
      .from(syncQueue)
      .where(eq(syncQueue.status, 'failed'))
      .orderBy(syncQueue.createdAt);
  }

  /**
   * Retry a specific failed operation
   */
  async retryOperation(id: number): Promise<void> {
    await this.db
      .update(syncQueue)
      .set({
        status: 'pending',
        attempts: 0,
        error: null,
        lastAttemptAt: null,
      })
      .where(eq(syncQueue.id, id));

    console.error(`Operation ${id} reset to pending for retry`);
  }

  /**
   * Clear all failed operations
   */
  async clearFailed(): Promise<number> {
    const failed = await this.getFailedOperations();
    await this.db.delete(syncQueue).where(eq(syncQueue.status, 'failed'));
    console.error(`Cleared ${failed.length} failed operations`);
    return failed.length;
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{
    pending: number;
    failed: number;
    total: number;
  }> {
    const all = await this.db.select().from(syncQueue);
    const pending = all.filter(item => item.status === 'pending').length;
    const failed = all.filter(item => item.status === 'failed').length;

    return {
      pending,
      failed,
      total: all.length,
    };
  }
}
