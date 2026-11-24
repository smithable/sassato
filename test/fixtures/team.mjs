import { fileURLToPath } from 'node:url';
export const fixtureConfig=fileURLToPath(new URL('./team.json',import.meta.url));

// Migration fixtures create a current database, then reconstruct its older schema.
// Undoes migrations 11 to 16, for tests that build an older database from a current one.
export const stripNewerSql='ALTER TABLE facts DROP COLUMN expires_at; DROP TABLE rule_loads; DROP TABLE rule_versions; DROP TABLE rule_proposals; DROP INDEX feedback_open; DROP TABLE feedback; ALTER TABLE tasks DROP COLUMN spare; DROP TABLE scored_wake_delivery; ALTER TABLE messages DROP COLUMN urgency; ALTER TABLE messages DROP COLUMN urgency_reason; ALTER TABLE messages DROP COLUMN immediate;';
