import type { RewindEvent } from "./events.js";
import { MigrationError } from "./errors.js";

export const CURRENT_SCHEMA_VERSION = 1;

export type EventMigration = (event: RewindEvent) => RewindEvent;

const migrations = new Map<number, EventMigration>();

export function registerMigration(fromVersion: number, migration: EventMigration): void {
  if (fromVersion >= CURRENT_SCHEMA_VERSION) {
    throw new MigrationError("Migration source must be older than the current schema", {
      fromVersion,
      current: CURRENT_SCHEMA_VERSION
    });
  }
  migrations.set(fromVersion, migration);
}

export function migrateEvent(event: RewindEvent): RewindEvent {
  let migrated = event;
  while (migrated.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const migration = migrations.get(migrated.schemaVersion);
    if (!migration) {
      throw new MigrationError("No migration registered for event schema", {
        schemaVersion: migrated.schemaVersion,
        current: CURRENT_SCHEMA_VERSION
      });
    }
    migrated = migration(migrated);
  }
  if (migrated.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new MigrationError("Cannot read a newer event schema", {
      schemaVersion: migrated.schemaVersion,
      current: CURRENT_SCHEMA_VERSION
    });
  }
  return migrated;
}
