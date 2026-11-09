// Compatibility for databases and command names created before generic workspace setup.
// New workspace defaults and public examples do not use these values.
import { homedir } from 'node:os';
import { join } from 'node:path';
export const legacyHuman = 'johan';
export const legacyImportTimezone = 'Europe/Mariehamn';
export const legacyStopFile = (): string => join(homedir(),'repos','stop');
export const legacyRoleAliases: Record<string,string> = {'human assistant':'hassist','human assistance':'hassist'};
export const legacyTimezoneAliases: Record<string,string> = {Mariehamn:legacyImportTimezone};
