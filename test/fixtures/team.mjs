import { fileURLToPath } from 'node:url';
export const fixtureConfig=fileURLToPath(new URL('./team.json',import.meta.url));

// Migration fixtures create a current database, then reconstruct its older schema.
export const stripScoredWakeSql='DROP TABLE scored_wake_delivery; ALTER TABLE messages DROP COLUMN urgency; ALTER TABLE messages DROP COLUMN urgency_reason; ALTER TABLE messages DROP COLUMN immediate;';
