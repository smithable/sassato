# Reproducible local benchmark

Measured 2026-11-09 on Node 24.21.0, SQLite 3.53.4, Linux/WSL2
6.6.87.2-microsoft-standard-WSL2, Intel Core Ultra 7 258V (8 logical CPUs),
19.5 GiB RAM. Load averages at completion: 3.22 / 2.71 / 3.42.
Database uses native project storage, WAL and synchronous FULL.

Dataset: 10,000 tasks, 100,000 messages, 10,000 facts and 120,000 audit events.
The source and audit rows produce 240,000 searchable documents. The checkpointed
initial database was 132,161,536 bytes. Synthetic bulk seeding took 15.1 seconds;
that bulk speed is not representative of individual durable writes.

| Operation | Samples | p50 ms | p95 ms |
| --- | ---: | ---: | ---: |
| Fresh-process CLI context | 12 | 80.593 | 109.068 |
| Indexed search | 100 | 3.557 | 4.966 |
| Status | 100 | 1.185 | 1.508 |
| Durable message + receipt + audit write | 100 | 2.154 | 6.131 |
| Search with concurrent writer | 200 | 4.058 | 6.470 |
| Status with concurrent writer | 200 | 1.489 | 3.242 |
| Write with concurrent readers | 100 | 3.235 | 11.634 |

Concurrent phase: two reader processes and one writer, 100 iterations each, 635 ms
elapsed. Total benchmark: 17.6 seconds. Search queries match about 2,400 documents
by indexed cohort token and return the top 20 ranked BM25 snippets. Broad terms
matching every document may cost more. Cold CLI means a fresh Node process, not
an evicted OS page cache. Measurements share a machine with other work and are
not a service-level guarantee. Final validation-only changes did not change the
measured search/status/write paths.

Run `npm run bench`. It creates an isolated synthetic database and JSON results under
`.artifacts/benchmark-<timestamp>/`. It never uses the default/live database. The script
records runtime, SQLite, machine, dataset, percentiles and method with every run.
The initial smaller seed without audit history is superseded by this measurement.

Conclusion: the measured CLI startup and query costs are small enough for startup
and task-transition checks. A daemon or in-memory cache is not justified. No constant
polling is necessary. Future workload evidence can revisit that choice.
