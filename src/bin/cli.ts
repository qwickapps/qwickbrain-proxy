#!/usr/bin/env node

import { Command } from 'commander';
import { createDatabase, runMigrations } from '../db/client.js';
import { ProxyServer } from '../lib/proxy-server.js';
import { ConfigSchema, type Config } from '../types/config.js';
import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { VERSION } from '../version.js';

const DEFAULT_CONFIG_DIR = join(homedir(), '.qwickbrain');
const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, 'config.json');

function loadConfig(): Config {
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    return ConfigSchema.parse({});
  }

  try {
    const raw = readFileSync(DEFAULT_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return ConfigSchema.parse(parsed);
  } catch (error) {
    console.error('Failed to load config:', error);
    return ConfigSchema.parse({});
  }
}

function saveConfig(config: Config): void {
  mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
  writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

const program = new Command();

program
  .name('qwickbrain-proxy')
  .description('Local MCP proxy for QwickBrain with caching and resilience')
  .version(VERSION);

program
  .command('serve')
  .description('Start the MCP proxy server (stdio mode)')
  .action(async () => {
    try {
      const config = loadConfig();
      const { db } = createDatabase(config.cache.dir);

      // Run migrations to ensure database schema is up to date
      try {
        runMigrations(db);
      } catch (migrationError) {
        console.error('Failed to run database migrations:', migrationError);
        console.error('Please ensure the database directory is writable and try again.');
        process.exit(1);
      }

      const server = new ProxyServer(db, config);

      process.on('SIGINT', async () => {
        console.error('\nShutting down...');
        await server.stop();
        process.exit(0);
      });

      await server.start();
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Initialize configuration')
  .action(async () => {
    console.log('QwickBrain Proxy Configuration');
    console.log('==============================\n');

    // Simple init - create default config
    const config = ConfigSchema.parse({
      qwickbrain: {
        url: 'http://macmini-devserver.local:3000',
      },
    });

    saveConfig(config);
    console.log(`Configuration saved to: ${DEFAULT_CONFIG_PATH}`);
    console.log('\nDefault settings:');
    console.log(`  QwickBrain URL: ${config.qwickbrain.url}`);
    console.log(`  Cache directory: ${join(homedir(), '.qwickbrain', 'cache')}`);
    console.log('\nTo customize, edit the config file or use "qwickbrain-proxy config" commands.');
  });

const configCmd = program.command('config').description('Manage configuration');

configCmd
  .command('get <key>')
  .description('Get a configuration value')
  .action((key) => {
    const config = loadConfig();
    const value = key.split('.').reduce((obj: any, k: string) => obj?.[k], config);
    console.log(value !== undefined ? value : 'Not set');
  });

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action((key, value) => {
    const config = loadConfig();
    const keys = key.split('.');
    const lastKey = keys.pop()!;
    const target = keys.reduce((obj: any, k: string) => {
      if (!obj[k]) obj[k] = {};
      return obj[k];
    }, config);

    // Try to parse as JSON, otherwise use as string
    try {
      target[lastKey] = JSON.parse(value);
    } catch {
      target[lastKey] = value;
    }

    // Validate against schema to prevent bypassing validation
    try {
      const validatedConfig = ConfigSchema.parse(config);
      saveConfig(validatedConfig);
      console.log(`Updated ${key} = ${value}`);
    } catch (error) {
      console.error('Configuration validation failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

configCmd
  .command('show')
  .description('Show current configuration')
  .action(() => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
  });

program
  .command('status')
  .description('Show proxy status')
  .action(() => {
    const config = loadConfig();
    console.log('QwickBrain Proxy Status');
    console.log('======================\n');
    console.log(`Config file: ${DEFAULT_CONFIG_PATH}`);
    console.log(`Config exists: ${existsSync(DEFAULT_CONFIG_PATH) ? 'Yes' : 'No'}`);
    console.log(`QwickBrain URL: ${config.qwickbrain.url}`);
    console.log(`Cache directory: ${config.cache.dir || join(homedir(), '.qwickbrain', 'cache')}`);
  });

program.parse();
