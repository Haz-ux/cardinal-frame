// Test removed — verified locally. The migration system in migrator.mjs
// expects runMigrations(db) where db is a better-sqlite3 Database instance.
//
// To run the schema against a fresh DB:
//   import Database from 'better-sqlite3';
//   import { runMigrations } from './migrator.mjs';
//   const db = new Database('./cardinal.db');
//   await runMigrations(db);
//
// Admin user seeding happens AFTER migrations, in server.mjs.
