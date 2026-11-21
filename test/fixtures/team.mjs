import { fileURLToPath } from 'node:url';
export const fixtureConfig=fileURLToPath(new URL('./team.json',import.meta.url));

// Migration fixtures create a current database, then reconstruct its older schema.
// Undoes migrations 11 and 12, for tests that build an older database from a current one.
export const stripNewerSql='ALTER TABLE tasks DROP COLUMN spare; DROP TABLE scored_wake_delivery; ALTER TABLE messages DROP COLUMN urgency; ALTER TABLE messages DROP COLUMN urgency_reason; ALTER TABLE messages DROP COLUMN immediate;';
