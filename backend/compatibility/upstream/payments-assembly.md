# Payments source assembly

`assemble_payments.py` creates a new owned payments build tree from the reviewed
original commit. It never edits that checkout, installs dependencies, compiles
the application, starts a service, runs a test, applies DDL or deploys anything.
It is implementation packaging; final parity/security/performance validation is
still required.

After all source adapters are integrated, use:

```sh
python3 compatibility/upstream/assemble_payments.py \
  --source-root /path/to/pinned-payments-checkout \
  --output /path/to/new-payments-build-tree
```

The source must remain at `434f3e438d1cb48c64e5723222c6efda506db571`.
The output parent must exist and the output path must be new and outside the
original checkout. The assembler exports committed bytes rather than copying
local configuration or untracked files. It checks each patch against its owned
manifest, then applies exchange, ordinary checkout and CSV/public/current-counter
composition in that order. The other-writer origin composer runs last, preserving
existing wrappers and adding genuine customer/provider/system confirmation and
the separate origin effects command.

The origin composer runs only its owned standard-library Go AST producer.
`POS_GO_BINARY` can select an installed reviewed Go executable; automatic
toolchain download, module proxy and checksum-network access are disabled.
No original Go application package is executed. Callers can also supply a
network-disabled producer runner to `assemble_payments(reference, output,
generate=...)`.

Assembly occurs in a separate temporary directory. A failed patch/producer leaves
no partially composed output. The resulting
`pos-composed-payments-manifest.json` records source revision, patch and composer
hashes, the origin manifest and each assembled file's digest. It explicitly marks
validation pending and contracts unselected. This file is not a release or parity
certificate. The separate existing and origin effects commands are build inputs,
not processes started by assembly.

Migration, trigger, grant, provider and key rollout remains a separate controlled
deployment step. The assembler injects no credentials or production contract
selectors. CLI events contain fixed module/resource/event IDs and per-invocation
request IDs; raw source/parser/compiler diagnostics and paths are not emitted.
