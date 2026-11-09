# Security

Sassato is a local coordination tool. Its roles are workflow safeguards, not authentication
between mutually untrusted processes sharing an OS account. See
[permissions and limits](docs/permissions.md) before storing workspace data.

## Reporting a vulnerability

Use the repository's [private vulnerability reporting form](https://github.com/smithable/sassato/security/advisories/new)
when available. If private reporting is unavailable, open an issue requesting a private
contact method without including the vulnerability details or sensitive data.

Include the Sassato build (`sassato --version`), Node version, operating system, affected
command, and a minimal reproduction using fake data. Do not attach a real workspace
database, credentials or provider transcripts.

Security fixes target the latest released version. This is an early 0.x project;
older versions do not have a separate maintenance commitment.
