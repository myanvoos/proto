# protofs

> Vendored into the proto repository. See `UPSTREAM.md` for the source commit and local rebrand
> changes. Build it from the proto repository root with `bun run build:protofs`.

Checkouts for agents: isolated, copy-on-write views of any folder, a git
repository or not, opened without copying it. Agents work in
the checkout; you review with `diff` and merge back with a three-way `apply`.
Checkouts can be snapshotted, forked, and attached to another machine, where
their content arrives on first read.

One daemon serves every checkout as a folder of a single mount: NFSv3 on
macOS, FUSE on Linux, SMB or WinFsp on Windows. No root, and no kernel
extension beyond WinFsp where you install it.

## Install

This vendored copy is built by proto:

```sh
cd <proto-repo>
bun run build:protofs
```

That writes `packages/coding-agent/binaries/protofs-<target>`; release installs ship it beside
`proto`. Building directly needs Go (see `go.mod`):

```sh
go build -o bin/protofs .
```

protofs runs git, and on Linux needs `fusermount3` (the `fuse3` package). `protofs version` prints
the build.

## Quick start

```sh
cd ~/src/app
cd "$(protofs new)"              # starts the daemon, prints the checkout's path
git status                     # same status as ~/src/app; nothing is written there
# ...let the agent work...
protofs diff app -p              # what changed
protofs apply app                # merge it back into ~/src/app
cd ~/src/app && protofs rm app   # remove the checkout; its snapshots stay
```

More, from `~/src/app`:

```sh
protofs run -- make test         # a disposable checkout: run, then remove
protofs new --rev main           # start from a revision instead of the working tree
protofs attach app --to devbox   # the same checkout on another machine, fetched lazily
protofs grep 'TODO' app          # search in the daemon, without traversing the mount
protofs glob '*.go' app          # matching paths, recursively and ignore-aware
```

`protofs help` lists every verb. Verbs start the daemon when none is running;
`start`, `stop` and `status` manage it, `serve` runs it in the foreground.

## How it works

Opening a folder sorts every path into a class. `source` paths are captured:
they are what `diff`, `apply` and snapshots see, and the only bytes that leave
the machine. `cache` and `local` paths (build outputs, ignored files, secrets)
show the live folder, read-only. `hidden` paths are absent. Built-in rules
handle the common cases; `.proto/protofs.yml` and `--rule` override them, and
`protofs explain PATH` says which rule decided.

Writes go to the checkout's own copy-on-write layer, so the folder is never
written until you `apply`. In a git repository the checkout gets a private git
directory: commit freely, then `apply --branch NAME` to bring the commits back.

protofs isolates files, not processes: it is not a sandbox.

## Documentation

- [Configuration](docs/configuration.md): classes, rules, `.proto/protofs.yml`, where state and checkouts live
- [Checkouts](docs/checkouts.md): `--rev`, `--take`, `run`, snapshots, forks, `diff` and `apply`
- [Remote checkouts](docs/remote.md): `attach`, `pull`, `share`, the mesh
- [Platforms](docs/platforms.md): NFS, FUSE, SMB and WinFsp frontends
- [Internals](docs/internals.md): admin protocol for embedding, persistence, memory tiers
- [Limitations](docs/limitations.md)
- [Development](docs/development.md): tests and benchmarks

## License

[MIT](LICENSE)
