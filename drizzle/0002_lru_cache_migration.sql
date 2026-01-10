-- Migration: Remove TTL, add LRU fields (two-tier storage)
-- Phase 2: LRU Cache Implementation

-- Create new documents table with LRU fields
CREATE TABLE `documents_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_type` text NOT NULL,
	`name` text NOT NULL,
	`project` text,
	`content` text NOT NULL,
	`metadata` text,
	`cached_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_accessed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`is_critical` integer DEFAULT false NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`synced` integer DEFAULT true NOT NULL
);
--> statement-breakpoint

-- Copy data from old table, calculating size and critical flag
INSERT INTO `documents_new` (
	id, doc_type, name, project, content, metadata, cached_at, last_accessed_at, is_critical, size_bytes, synced
)
SELECT
	id,
	doc_type,
	name,
	project,
	content,
	metadata,
	cached_at,
	cached_at as last_accessed_at, -- Initialize with cached_at
	CASE
		WHEN doc_type IN ('workflow', 'rule', 'agent', 'template') THEN true
		ELSE false
	END as is_critical,
	length(content) as size_bytes, -- Calculate size in bytes
	synced
FROM `documents`;
--> statement-breakpoint

-- Drop old table
DROP TABLE `documents`;
--> statement-breakpoint

-- Rename new table
ALTER TABLE `documents_new` RENAME TO `documents`;
--> statement-breakpoint

-- Recreate unique index
CREATE UNIQUE INDEX `documents_doc_type_name_project_unique` ON `documents` (`doc_type`,`name`,`project`);
--> statement-breakpoint

-- Create new memories table with LRU fields
CREATE TABLE `memories_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`project` text,
	`content` text NOT NULL,
	`metadata` text,
	`cached_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_accessed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`synced` integer DEFAULT true NOT NULL
);
--> statement-breakpoint

-- Copy data from old table, calculating size
INSERT INTO `memories_new` (
	id, name, project, content, metadata, cached_at, last_accessed_at, size_bytes, synced
)
SELECT
	id,
	name,
	project,
	content,
	metadata,
	cached_at,
	cached_at as last_accessed_at, -- Initialize with cached_at
	length(content) as size_bytes, -- Calculate size in bytes
	synced
FROM `memories`;
--> statement-breakpoint

-- Drop old table
DROP TABLE `memories`;
--> statement-breakpoint

-- Rename new table
ALTER TABLE `memories_new` RENAME TO `memories`;
--> statement-breakpoint

-- Recreate unique index
CREATE UNIQUE INDEX `memories_name_project_unique` ON `memories` (`name`,`project`);
