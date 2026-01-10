# Bug Analysis: QwickBrain Proxy Cache and Design Issues

## Bug ID

qwickbrain-proxy-cache-and-design

## Date

2026-01-09

## Reporter

User testing

## Summary

QwickBrain proxy fails to deliver requested features. Returns empty content for get_memory calls and exposes only 3 fallback tools instead of all available tools.

## Test Output

```json
get_memory(name="qwickbrain-context", project="qwickbrain")
{
  "data": {
    "name": "qwickbrain-context",
    "project": "qwickbrain",
    "content": "",           // ← EMPTY CONTENT
    "metadata": {}
  },
  "_metadata": {
    "source": "cache",      // ← Serving from cache
    "age_seconds": 315,     // ← Cache is 5 minutes old
    "status": "disconnected" // ← Not connected when request made
  }
}
```

Available tools: `get_workflow, get_document, get_memory` (only 3 instead of 10+)

## Root Causes

### Issue 1: Background Cache Sync Not Implemented

**Location:** `src/lib/proxy-server.ts:71-91`

```typescript
private async onConnectionRestored(): Promise<void> {
  console.error('Starting background cache sync...');

  const preloadItems = this.config.cache.preload || [];
  for (const itemType of preloadItems) {
    try {
      if (itemType === 'workflows') {
        // TODO: List and cache all workflows
        console.error('Preloading workflows...');
      } else if (itemType === 'rules') {
        // TODO: List and cache all rules
        console.error('Preloading rules...');
      }
    } catch (error) {
      console.error(`Failed to preload ${itemType}:`, error);
    }
  }

  console.error('Background cache sync complete');
}
```

**Evidence:** Method has TODO comments, doesn't fetch or cache anything.

**Impact:**

- Cache remains empty unless explicitly populated by client requests
- Static content (rules, agents, templates) never pre-cached
- Offline mode is useless - no cached data to serve

### Issue 2: Dynamic Tool Listing (Non-Standard Design)

**Location:** `src/lib/proxy-server.ts:94-148`

```typescript
this.server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Try to fetch tools from upstream if connected
  if (this.connectionManager.getState() === 'connected') {
    try {
      const tools = await this.connectionManager.execute(async () => {
        return await this.qwickbrainClient.listTools();
      });
      return { tools };
    } catch (error) {
      console.error('Failed to list tools from upstream:', error);
    }
  }

  // Fallback to minimal tool set when offline or error
  return {
    tools: [
      { name: 'get_workflow', ...},
      { name: 'get_document', ...},
      { name: 'get_memory', ...}
    ],
  };
});
```

**Evidence:** Tools queried dynamically from upstream when connected, falls back to 3 tools when offline.

**Impact:**

- Non-standard MCP behavior (tool list should be static)
- Race condition: client connects before proxy connects to upstream → sees 3 tools
- Inconsistent tool availability based on connection state

### Issue 3: No Write-Through Cache for Static Content

**Location:** `src/lib/cache-manager.ts`, `src/lib/proxy-server.ts:224-289`

Current behavior:

1. Client requests document/memory
2. Check cache (if not expired, return)
3. Try upstream (if connected, cache and return)
4. Try stale cache (if exists, return)
5. Return error (no cache, no connection)

**Missing:**

- No differentiation between static (rules, agents, templates) and dynamic content
- No write-through caching - static content should be cached on every fetch
- No permanent cache flag - static content TTL should be very long or infinite

**Impact:**

- Static content not reliably available offline
- Frequent re-fetching of rarely-changing content
- No guarantee critical content is cached

### Issue 4: QwickBrain Python Server Missing Tools

**Location:** `/Users/raajkumars/Projects/qwickbrain/src/qwickbrain/mcp/server.py:212-359`

The Python MCP server implements 10+ tools:

- get_workflow
- get_document
- get_memory
- set_memory
- list_repositories
- search_codebase
- find_functions
- find_classes
- explain_function
- analyze_file
- analyze_repository
- update_workflow

But proxy only exposes 3 when offline.

## Design Requirements (from user)

### Requirement 1: Static Tool Mapping

- All functions should be permanently mapped in proxy
- Tools don't need dynamic discovery
- Functions return "offline" error when QwickBrain unreachable
- Consistent tool availability regardless of connection state

### Requirement 2: Storage-Limited Cache with LRU Eviction (NO TTL)

**Rationale:** User works for 8+ hours on corporate network - TTL would cause unnecessary cache invalidation during active work sessions.

**Cache Strategy:**

- **No TTL-based expiration** - cache stays valid indefinitely
- **Two-tier storage:**
  - **Critical tier (permanent)**: Never evicted, not counted toward storage limit
    - Rules, agents, templates, workflows
    - Always available offline
  - **Dynamic tier (LRU)**: Storage-limited with LRU eviction
    - Documents (FRDs, designs, ADRs)
    - Memories (context, sprint handoffs)
    - Configurable max size (e.g., 100MB, 500MB)
- **LRU eviction** - when dynamic tier storage limit reached, evict least recently used entries
- **SSE-based invalidation** - cache invalidated when QwickBrain sends update notifications

### Requirement 3: Offline Write Queue with Auto-Sync

- **Write-through when online** - writes go directly to QwickBrain and cache
- **Queue when offline** - writes stored in local queue
- **Auto-sync on reconnection** - queued writes automatically sent when connection restored
- **Conflict detection** (future) - for multi-user scenarios

### Requirement 4: Real-Time Cache Invalidation via SSE

- QwickBrain sends SSE notifications when documents/memories updated
- Proxy listens to SSE stream for update events
- Cache entry invalidated on update notification
- Next access fetches fresh data from QwickBrain
- **Scope:** Single user for now, multi-tenancy support later

### Requirement 5: Background Cache Preload

- On connection, preload critical static content:
  - All workflows
  - All rules
  - All agents
  - All templates
- Preload happens in background, doesn't block proxy startup
- Subsequent access serves from cache (no repeated fetches)

## Proposed Fix

### Fix 1: Implement Static Tool Mapping

**File:** `src/lib/proxy-server.ts:94-148`

Replace dynamic tool listing with static tool map:

```typescript
private getAllTools() {
  return [
    { name: 'get_workflow', description: 'Get a workflow definition by name', inputSchema: { /* ... */ } },
    { name: 'get_document', description: 'Get a document by name and type', inputSchema: { /* ... */ } },
    { name: 'get_memory', description: 'Get a memory/context document', inputSchema: { /* ... */ } },
    { name: 'set_memory', description: 'Set or update a memory/context document', inputSchema: { /* ... */ } },
    { name: 'update_document', description: 'Update a document', inputSchema: { /* ... */ } },
    { name: 'list_repositories', description: 'List all indexed repositories', inputSchema: { /* ... */ } },
    { name: 'search_codebase', description: 'Search code across all repositories', inputSchema: { /* ... */ } },
    { name: 'find_functions', description: 'Find function definitions', inputSchema: { /* ... */ } },
    { name: 'find_classes', description: 'Find class definitions', inputSchema: { /* ... */ } },
    { name: 'explain_function', description: 'Explain function implementation', inputSchema: { /* ... */ } },
    { name: 'analyze_file', description: 'Analyze file structure', inputSchema: { /* ... */ } },
    { name: 'analyze_repository', description: 'Analyze repository structure', inputSchema: { /* ... */ } },
  ];
}

this.server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: this.getAllTools() };
});
```

Tools always available, return "offline" error in handler when disconnected.

### Fix 2: Remove TTL, Implement LRU Cache with Storage Limit

**File:** `src/lib/cache-manager.ts`, `src/db/schema.ts`

**Two-tier storage schema:**

```typescript
// Remove expiresAt column from documents and memories tables
// Add isCritical flag to separate critical from dynamic tier
// Add lastAccessedAt column for LRU tracking (dynamic tier only)

export const documents = sqliteTable('documents', {
  // ... existing columns ...
  cachedAt: integer('cached_at', { mode: 'timestamp' }).notNull(),
  lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp' }).notNull(),
  isCritical: integer('is_critical', { mode: 'boolean' }).notNull().default(false),
  sizeBytes: integer('size_bytes').notNull(),
});

// Critical doc types: workflow, rule, agent, template
const CRITICAL_DOC_TYPES = ['workflow', 'rule', 'agent', 'template'];
```

**Implement two-tier LRU eviction:**

```typescript
class CacheManager {
  private maxDynamicCacheSize: number; // Configurable, e.g., 100MB (only for dynamic tier)

  async ensureCacheSize(requiredBytes: number, isCritical: boolean): Promise<void> {
    // Critical files bypass storage limit check
    if (isCritical) {
      return;
    }

    // Only count dynamic tier (isCritical=false) toward storage limit
    const currentSize = await this.getDynamicCacheSize();
    if (currentSize + requiredBytes <= this.maxDynamicCacheSize) {
      return;
    }

    // Evict LRU entries from dynamic tier only
    const toEvict = currentSize + requiredBytes - this.maxDynamicCacheSize;
    await this.evictLRU(toEvict);
  }

  private async getDynamicCacheSize(): Promise<number> {
    // Only count non-critical items
    const result = await this.db
      .select({ total: sql<number>`sum(${documents.sizeBytes})` })
      .from(documents)
      .where(eq(documents.isCritical, false));
    return result[0]?.total || 0;
  }

  private async evictLRU(bytesToFree: number): Promise<void> {
    // Only evict from dynamic tier (isCritical=false)
    // NEVER touch critical tier
    let freed = 0;
    const candidates = await this.db
      .select()
      .from(documents)
      .where(eq(documents.isCritical, false))
      .orderBy(documents.lastAccessedAt) // ASC = oldest first
      .limit(100);

    for (const doc of candidates) {
      await this.db.delete(documents).where(eq(documents.id, doc.id));
      freed += doc.sizeBytes;
      console.error(`Evicted: ${doc.docType}:${doc.name} (${doc.sizeBytes} bytes)`);
      if (freed >= bytesToFree) break;
    }
  }

  async setDocument(
    docType: string,
    name: string,
    content: string,
    project?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const isCritical = CRITICAL_DOC_TYPES.includes(docType);
    const sizeBytes = Buffer.byteLength(content, 'utf8');

    // Ensure space available (skips check if critical)
    await this.ensureCacheSize(sizeBytes, isCritical);

    // Insert/update with critical flag
    await this.db.insert(documents).values({
      docType,
      name,
      project: project || '',
      content,
      metadata: JSON.stringify(metadata || {}),
      cachedAt: new Date(),
      lastAccessedAt: new Date(),
      isCritical,
      sizeBytes,
    }).onConflictDoUpdate({
      target: [documents.docType, documents.name, documents.project],
      set: {
        content,
        metadata: JSON.stringify(metadata || {}),
        lastAccessedAt: new Date(),
        sizeBytes,
      },
    });
  }

  async getDocument(...): Promise<CachedItem<any> | null> {
    const cached = await this.db.select()...;
    if (!cached) return null;

    // Update last accessed timestamp (for LRU tracking)
    await this.db.update(documents)
      .set({ lastAccessedAt: new Date() })
      .where(eq(documents.id, cached.id));

    return { data: cached.data, age: ... };
  }
}
```

### Fix 3: Implement Offline Write Queue

**File:** `src/lib/write-queue.ts` (new), `src/db/schema.ts`

**Add pending_writes table:**

```typescript
export const pendingWrites = sqliteTable('pending_writes', {
  id: integer('id').primaryKey(),
  operation: text('operation').notNull(), // 'set_memory', 'update_document', etc.
  docType: text('doc_type'),
  name: text('name').notNull(),
  project: text('project').notNull().default(''),
  content: text('content').notNull(),
  metadata: text('metadata'),
  queuedAt: integer('queued_at', { mode: 'timestamp' }).notNull(),
  retries: integer('retries').notNull().default(0),
});
```

**Implement WriteQueue:**

```typescript
class WriteQueue {
  async queueWrite(operation: string, args: any): Promise<void> {
    await this.db.insert(pendingWrites).values({
      operation,
      docType: args.doc_type,
      name: args.name,
      project: args.project || '',
      content: args.content,
      metadata: JSON.stringify(args.metadata || {}),
      queuedAt: new Date(),
    });
  }

  async syncPendingWrites(): Promise<void> {
    const pending = await this.db.select().from(pendingWrites);

    for (const write of pending) {
      try {
        // Execute write against QwickBrain
        await this.qwickbrainClient[write.operation](JSON.parse(write));
        // Remove from queue on success
        await this.db.delete(pendingWrites).where(eq(pendingWrites.id, write.id));
      } catch (error) {
        // Increment retry count
        await this.db.update(pendingWrites)
          .set({ retries: write.retries + 1 })
          .where(eq(pendingWrites.id, write.id));
      }
    }
  }
}
```

**Integrate with proxy:**

```typescript
// In handleSetMemory, handleUpdateDocument, etc.
if (this.connectionManager.getState() === 'connected') {
  // Write-through
  await this.qwickbrainClient.setMemory(...);
  await this.cacheManager.setMemory(...);
} else {
  // Queue for later
  await this.writeQueue.queueWrite('setMemory', args);
  await this.cacheManager.setMemory(...); // Update local cache optimistically
}

// On connection restored:
await this.writeQueue.syncPendingWrites();
```

### Fix 4: Implement SSE-Based Cache Invalidation

**File:** `src/lib/cache-invalidator.ts` (new)

**QwickBrain SSE endpoint:** `GET /sse/updates`
Sends events like:

```json
{
  "type": "document_updated",
  "doc_type": "rule",
  "name": "WRITING-STYLE",
  "project": "",
  "updated_by": "user123",
  "timestamp": "2026-01-09T18:30:00Z"
}
```

**Implement CacheInvalidator:**

```typescript
class CacheInvalidator {
  private eventSource: EventSource | null = null;

  async start(): Promise<void> {
    if (!this.config.url) return;

    this.eventSource = new EventSource(`${this.config.url}/sse/updates`);

    this.eventSource.addEventListener('document_updated', async (event) => {
      const data = JSON.parse(event.data);
      await this.cacheManager.invalidateDocument(data.doc_type, data.name, data.project);
      console.error(`Cache invalidated: ${data.doc_type}:${data.name}`);
    });

    this.eventSource.addEventListener('memory_updated', async (event) => {
      const data = JSON.parse(event.data);
      await this.cacheManager.invalidateMemory(data.name, data.project);
      console.error(`Cache invalidated: memory:${data.name}`);
    });

    this.eventSource.onerror = () => {
      console.error('SSE connection error, will reconnect...');
    };
  }

  stop(): void {
    this.eventSource?.close();
    this.eventSource = null;
  }
}
```

**Add invalidation methods to CacheManager:**

```typescript
async invalidateDocument(docType: string, name: string, project?: string): Promise<void> {
  await this.db.delete(documents).where(
    and(
      eq(documents.docType, docType),
      eq(documents.name, name),
      eq(documents.project, project || '')
    )
  );
}

async invalidateMemory(name: string, project?: string): Promise<void> {
  await this.db.delete(memories).where(
    and(
      eq(memories.name, name),
      eq(memories.project, project || '')
    )
  );
}
```

### Fix 5: Implement Background Cache Preload

**File:** `src/lib/proxy-server.ts:71-91`

```typescript
private async onConnectionRestored(): Promise<void> {
  console.error('Starting background cache sync...');

  try {
    // Preload all workflows (critical priority)
    const workflows = await this.qwickbrainClient.listDocuments('workflow');
    for (const wf of workflows) {
      const content = await this.qwickbrainClient.getDocument('workflow', wf.name);
      await this.cacheManager.setDocument('workflow', wf.name, content.content, undefined, undefined, 2); // priority=2
    }

    // Preload all rules (critical priority)
    const rules = await this.qwickbrainClient.listDocuments('rule');
    for (const rule of rules) {
      const content = await this.qwickbrainClient.getDocument('rule', rule.name);
      await this.cacheManager.setDocument('rule', rule.name, content.content, undefined, undefined, 2);
    }

    // Preload agents, templates (critical priority)
    // ...

    // Start SSE listener for real-time invalidation
    await this.cacheInvalidator.start();

    // Sync any pending writes
    await this.writeQueue.syncPendingWrites();

  } catch (error) {
    console.error('Background sync error:', error);
  }

  console.error('Background cache sync complete');
}
```

### Fix 6: Return "Offline" Error for Non-Cached Tools

**File:** `src/lib/proxy-server.ts:174-177`

```typescript
default:
  // Generic forwarding for non-cacheable tools
  if (this.connectionManager.getState() !== 'connected') {
    throw new Error('QwickBrain offline - this tool requires active connection');
  }
  result = await this.handleGenericTool(name, args || {});
  break;
```

## Files to Modify

### Phase 1: Static Tool Mapping (Quick Win)

1. `src/lib/proxy-server.ts`:
   - Replace dynamic tool listing with static map (lines 94-148)
   - Add offline error for non-cacheable tools (lines 174-177)

### Phase 2: LRU Cache Implementation

2. `src/db/schema.ts`:
   - Remove `expiresAt` column
   - Add `lastAccessedAt`, `priority`, `sizeBytes` columns
   - Create database migration

2. `src/lib/cache-manager.ts`:
   - Remove TTL-based expiration logic
   - Implement LRU eviction with storage limit
   - Update `lastAccessedAt` on every read
   - Add `invalidateDocument()`, `invalidateMemory()` methods
   - Respect priority tiers during eviction

3. `src/types/config.ts`:
   - Add `maxCacheSizeBytes` to cache configuration
   - Remove TTL configuration

### Phase 3: Offline Write Queue

5. `src/db/schema.ts`:
   - Add `pending_writes` table

2. `src/lib/write-queue.ts` (new):
   - Implement `WriteQueue` class
   - `queueWrite()` - add to pending writes
   - `syncPendingWrites()` - sync on reconnection

3. `src/lib/proxy-server.ts`:
   - Integrate write queue into `set_memory`, `update_document` handlers
   - Call `syncPendingWrites()` in `onConnectionRestored()`

4. `src/lib/qwickbrain-client.ts`:
   - Add `setMemory()`, `updateDocument()` methods

### Phase 4: SSE-Based Cache Invalidation

9. `src/lib/cache-invalidator.ts` (new):
   - Implement `CacheInvalidator` class
   - Listen to SSE `/sse/updates` endpoint
   - Call `cacheManager.invalidate*()` on update events

2. `src/lib/proxy-server.ts`:
    - Initialize `CacheInvalidator`
    - Start SSE listener in `onConnectionRestored()`
    - Stop listener on disconnect

3. **QwickBrain Python server** (separate repo):
    - Add SSE `/sse/updates` endpoint
    - Emit `document_updated`, `memory_updated` events

### Phase 5: Background Cache Preload

12. `src/lib/proxy-server.ts`:
    - Implement background cache sync (lines 71-91)
    - Preload workflows, rules, agents, templates with priority=2

2. `src/lib/qwickbrain-client.ts`:
    - Add `listDocuments(docType)` method

## Testing Plan

### Test 1: Static Tool Availability (Phase 1)

```typescript
// Start proxy
// Immediately call listTools() before connection established
// Verify ALL 12+ tools are exposed (not just 3)
assert(tools.length >= 12);
assert(tools.find(t => t.name === 'search_codebase'));
```

### Test 2: LRU Eviction with Two-Tier Storage (Phase 2)

```typescript
// Configure dynamic tier cache limit: 10MB
// Preload critical files (workflows, rules, agents, templates): 15MB
// Preload dynamic documents: 50MB
// Verify:
//   - Critical files: 15MB stored, not counted toward 10MB limit
//   - Dynamic files: Only 10MB stored (40MB evicted via LRU)
//   - Total cache size: 25MB (15MB critical + 10MB dynamic)
//   - All critical files present in cache
//   - Only most recently accessed dynamic files present
//   - Least recently accessed dynamic files evicted
// Access a critical file (workflow)
// Verify it's never evicted even with more dynamic file additions
```

### Test 3: Offline Write Queue (Phase 3)

```typescript
// Start proxy (online)
// Stop QwickBrain (simulate offline)
// Call set_memory('test-context', 'content')
// Verify queued in pending_writes table
// Restart QwickBrain
// Wait for auto-sync
// Verify write sent to QwickBrain
// Verify removed from pending_writes table
```

### Test 4: SSE Cache Invalidation (Phase 4)

```typescript
// Start proxy, cache document 'WRITING-STYLE'
// Simulate SSE event: { type: 'document_updated', doc_type: 'rule', name: 'WRITING-STYLE' }
// Verify cache entry deleted
// Call get_document('rule', 'WRITING-STYLE')
// Verify fresh fetch from QwickBrain (not cache)
```

### Test 5: Background Preload (Phase 5)

```typescript
// Start proxy, wait for background sync
// Stop QwickBrain (offline mode)
// Call get_document('workflow', 'feature')
// Verify content returned from cache (not empty)
// Call get_document('rule', 'WRITING-STYLE')
// Verify content returned from cache (not empty)
```

### Test 6: Offline Mode with Cached Content

```typescript
// Start proxy, wait for background sync
// Stop QwickBrain server
// Call get_document('rule', 'WRITING-STYLE')
// Verify content returned from cache, not empty
// Call search_codebase(...) - non-cacheable tool
// Verify returns "QwickBrain offline" error
```

### Test 7: 8-Hour Work Session (No TTL Invalidation)

```typescript
// Start proxy at 9am
// Access documents throughout day
// At 5pm (8 hours later):
// Verify all accessed documents still in cache
// Verify no TTL-based expiration occurred
// Verify LRU eviction only triggered by storage limit
```

## Success Criteria

### Phase 1 (Static Tool Mapping)

- [ ] All 12+ tools exposed in listTools() regardless of connection state
- [ ] Non-cacheable tools return "QwickBrain offline" error when disconnected

### Phase 2 (LRU Cache)

- [ ] No TTL-based expiration - cache entries stay valid indefinitely
- [ ] Two-tier storage:
  - [ ] Critical tier (workflows, rules, agents, templates) - never evicted, not counted toward limit
  - [ ] Dynamic tier - storage-limited with configurable size (default 100MB)
- [ ] LRU eviction only affects dynamic tier
- [ ] Critical files always available offline
- [ ] 8-hour work session: no cache invalidation, all content available

### Phase 3 (Offline Write Queue)

- [ ] Writes queued when offline
- [ ] Auto-sync on reconnection
- [ ] Queued writes successfully sent to QwickBrain
- [ ] Optimistic local cache updates work offline

### Phase 4 (SSE Cache Invalidation)

- [ ] SSE listener active when connected
- [ ] Cache invalidated on update notifications
- [ ] Fresh fetch after invalidation
- [ ] No stale data served after remote updates

### Phase 5 (Background Preload)

- [ ] Static content (workflows, rules, agents, templates) preloaded on connection
- [ ] Offline mode serves preloaded content successfully
- [ ] Background sync doesn't block proxy startup

### Overall

- [ ] Proxy works offline with preloaded cache
- [ ] No empty content returned for cached documents
- [ ] Writes work offline and sync automatically
- [ ] Cache stays valid during 8-hour work sessions
- [ ] Real-time updates invalidate cache appropriately
- [ ] All 7 tests pass

## Implementation Phases

### Phase 1: Static Tool Mapping (1-2 hours)

Quick win - fixes immediate tool availability issue.

**Deliverables:**

- All tools exposed statically
- Offline error for non-cached tools
- Test 1 passes

### Phase 2: LRU Cache (4-6 hours)

Remove TTL, implement storage-based eviction.

**Deliverables:**

- Database migration
- LRU eviction logic
- Storage tracking
- Priority tiers
- Tests 2, 7 pass

### Phase 3: Offline Write Queue (3-4 hours)

Enable offline writes with auto-sync.

**Deliverables:**

- Write queue table
- Queue/sync logic
- Integration with handlers
- Test 3 passes

### Phase 4: SSE Cache Invalidation (3-4 hours)

Real-time cache invalidation.

**Deliverables:**

- CacheInvalidator class
- SSE listener
- Invalidation logic
- Test 4 passes
- **Requires:** QwickBrain Python server SSE endpoint (separate task)

### Phase 5: Background Preload (2-3 hours)

Preload critical static content.

**Deliverables:**

- Background sync implementation
- listDocuments() method
- Priority-based preloading
- Tests 5, 6 pass

**Total Estimated Effort:** 13-19 hours

## Next Steps

1. **User approval** - Confirm phased approach
2. **Start with Phase 1** - Quick win, static tool mapping
3. **Test Phase 1** - Verify tool availability
4. **Continue with Phase 2** - LRU cache
5. **QwickBrain SSE endpoint** - Coordinate with Python server implementation
6. **Phases 3-5** - Complete remaining features
7. **Integration testing** - All phases together
8. **Documentation** - Update README, architecture docs
9. **Version bump and release** - v1.1.0 (breaking changes to cache schema)
