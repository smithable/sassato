# Contributing

Bug reports, documentation improvements and focused pull requests are welcome.
Please discuss larger behavior changes in an issue before implementing them.

## Development

Use Node.js 24.13+ and install dependencies with `npm ci`. Before submitting a change:

```sh
npm run lint
npm run typecheck
npm test
npm run smoke
```

CI runs these checks on Node 24 and 26. Add meaningful regression tests for changes to
persistence, permissions, routing or process lifecycle behavior. Use temporary databases
and fixture providers; never run tests against your real workspace or launch real agents.

Explain the problem, resulting behavior and validation in the pull request. Preserve
existing workspace data and command compatibility where practical. Document intentional
changes to defaults. Keep generated packages, databases, logs and local configuration out
of commits. Do not paste secrets into issues or test fixtures.

## Contribution terms

Contributions are made under the project's MIT license. No DCO sign-off or separate
contributor agreement is required.

Report security issues using [SECURITY.md](SECURITY.md).
