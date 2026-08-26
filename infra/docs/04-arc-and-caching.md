# 04 - ARC runners, shared caches, and egress policy

This is the last setup step. By now the node runs k3s with the `kata-qemu`
RuntimeClass ([02-kata-runtime.md](02-kata-runtime.md)) and the preloaded runner
image has been imported into the cluster containerd ([03-runner-image.md](03-runner-image.md)).
Here we install **actions-runner-controller (ARC)**, register an ephemeral
**scale set** whose pods each boot inside their own Kata microVM, stand up the
runner cache PVC, and lock down runner egress with a NetworkPolicy. See
[README.md](README.md) for the architecture overview.

Everything below is read against the live cluster; set the kubeconfig once:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```

ARC's `gha-runner-scale-set` flavour has three moving parts:

- **Controller** (`arc` release, ns `arc-systems`) - watches `AutoscalingRunnerSet`
  custom resources and reconciles them.
- **Listener** (one pod per scale set, ns `arc-systems`) - long-polls the GitHub
  Actions service for jobs targeting the scale set's `runs-on` label.
- **Scale set** (`proto-kata` release, ns `arc-runners`) - the `AutoscalingRunnerSet`
  plus the pod template; the controller turns assigned jobs into ephemeral runner
  pods here.

---

## 1. GitHub App and the `arc-github` secret

The listener authenticates to GitHub. The durable option is a **GitHub App**
(no expiring user token, scoped to exactly the repos you install it on).

1. Create the App at **GitHub - Settings - Developer settings - GitHub Apps - New GitHub App**.
   - **Repository permissions**: `Administration: Read and write` (register/remove
     self-hosted runners) and `Metadata: Read-only` (granted automatically).
   - No webhook is needed for the scale-set flavour; uncheck **Active** under Webhook.
   - Generate and download a **private key** (`.pem`).
2. **Install** the App on the target repo or org (App page - **Install App** -
   pick `<OWNER>/<REPO>` or "All repositories"). Note the **App ID** and the
   **Installation ID** (the trailing number in the install settings URL,
   `.../installations/<id>`).
3. Create the secret in the runners namespace. The three key names below are
   exactly what the chart reads:

   ```bash
   kubectl create namespace arc-runners

   kubectl -n arc-runners create secret generic arc-github \
     --from-literal=github_app_id=<GITHUB_APP_ID> \
     --from-literal=github_app_installation_id=<GITHUB_APP_INSTALLATION_ID> \
     --from-literal=github_app_private_key=<GITHUB_APP_PRIVATE_KEY>
   ```

   `<GITHUB_APP_PRIVATE_KEY>` is the full PEM body (use `--from-file=github_app_private_key=key.pem`
   to avoid shell-quoting the multi-line value).

Verify the live secret carries those three keys (names only - never print values):

```bash
kubectl -n arc-runners get secret arc-github \
  -o go-template='{{range $k,$v := .data}}{{$k}}{{"\n"}}{{end}}'
# github_app_id
# github_app_installation_id
# github_app_private_key
```

**Token alternative.** ARC also accepts a single-key secret with a classic PAT
(scope `repo`) or a fine-grained PAT (`Administration: RW` + `Metadata: R`):

```bash
kubectl -n arc-runners create secret generic arc-github \
  --from-literal=github_token=<GITHUB_PAT>
```

The App is preferred: it does not expire, it is scoped per-installation, and one
installation covers every repo you grant it (useful for [adding another repo](#7-operate)).
Whichever you choose, the `githubConfigSecret` value in step 3's chart points at
this secret by name.

---

## 2. Install ARC (controller + scale set)

ARC ships as OCI Helm charts; no `helm repo add` is required. Both the controller
and the scale set are pinned to the same chart version, **0.14.2** (matches the
live `helm list -A`).

**Controller** (installed with chart defaults - `helm get values arc` is empty):

```bash
helm install arc \
  --namespace arc-systems --create-namespace \
  --version 0.14.2 \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller
```

**Scale set** (`proto-kata`), using the runner cache PVC and values file from step 3:
```bash
helm install proto-kata \
  --namespace arc-runners --create-namespace \
  --version 0.14.2 \
  -f arc-proto-values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

Confirm both releases and the running controller image:

```bash
helm list -A
# arc       arc-systems   deployed  gha-runner-scale-set-controller-0.14.2  0.14.2
# proto-kata  arc-runners   deployed  gha-runner-scale-set-0.14.2             0.14.2

kubectl -n arc-systems get deploy arc-gha-rs-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
# ghcr.io/actions/gha-runner-scale-set-controller:0.14.2
```

Within a few seconds the controller spawns the listener in `arc-systems`:

```bash
kubectl -n arc-systems get pods
# arc-gha-rs-controller-xxxxxxxxxx-xxxxx   1/1   Running
# proto-kata-<hash>-listener                 1/1   Running
```

---

## 3. Scale-set values (`arc-proto-values.yaml`)

Create the namespace-local PVC before installing or upgrading the scale set. This
is the shared mutable filesystem cache for data whose tools already validate
against the lockfile: Bun's global package store and Cargo's registry cache.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: runner-cache
  namespace: arc-runners
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: local-path
  resources:
    requests:
      storage: 100Gi
```

Apply it once:

```bash
kubectl apply -f runner-cache-pvc.yaml
```

This is the live `arc-proto-values.yaml` verbatim, with only the repo owner/name in
`githubConfigUrl` redacted:

```yaml
githubConfigUrl: "https://github.com/<OWNER>/<REPO>"
githubConfigSecret: arc-github
runnerScaleSetName: proto-kata
minRunners: 0
maxRunners: 8
# none: each job runs inside the runner container, which itself lives in a Kata microVM
containerMode:
  type: ""
template:
  spec:
    runtimeClassName: kata-qemu
    securityContext:
      fsGroup: 1001
      fsGroupChangePolicy: OnRootMismatch
    containers:
      - name: runner
        image: proto-kata-runner:2026-07-27-072222
        imagePullPolicy: IfNotPresent
        command: ["/home/runner/run.sh"]
        envFrom:
          # Legacy-named infra-presence marker. The name predates the Bazel
          # removal; .github/actions/bun-install probes $BAZEL_REMOTE_USER to
          # detect proto-kata pods. It carries no build-system function anymore.
          - secretRef:
              name: bazel-remote-ci
        volumeMounts:
          - name: runner-cache
            mountPath: /home/runner/.bun/install/cache
            subPath: bun-store
          - name: runner-cache
            mountPath: /home/runner/.cargo/registry/cache
            subPath: cargo-registry/cache
          - name: runner-cache
            mountPath: /home/runner/.cargo/registry/index
            subPath: cargo-registry/index
        resources:
          # Burstable on purpose: requests bin-pack 8 runners onto the
          # 32-vCPU / 125 GiB host; limits are each Kata VM's hotplug
          # ceiling. Keep sum(memory limits) under host RAM.
          requests:
            cpu: "3"
            memory: "10Gi"
          limits:
            cpu: "8"
            memory: "14Gi"
    volumes:
      - name: runner-cache
        persistentVolumeClaim:
          claimName: runner-cache
```

Field by field:

- **`githubConfigUrl`** - the repo (or org) the scale set serves. Jobs reach it
  with `runs-on: proto-kata`.
- **`githubConfigSecret: arc-github`** - the auth secret from [step 1](#1-github-app-and-the-arc-github-secret).
- **`runnerScaleSetName: proto-kata`** - the runner label. This is the string that
  goes in a workflow's `runs-on:`.
- **`minRunners: 0` / `maxRunners: 8`** - **scale-to-zero**. With no queued jobs
  there are zero runner microVMs. Runner pods are **burstable**: a small
  request (3 vCPU / 10 GiB) bin-packs eight runners onto the reference host,
  while the limit (8 vCPU / 14 GiB) is each Kata VM's hotplug ceiling, so a
  lone heavy job still gets 8 vCPUs. Keep the sum of memory *limits* under
  host RAM — host OOM under Kata kills VMs unpredictably. (The original
  guaranteed sizing, 4 x 8 vCPU / 24 GiB requests=limits, reserved the whole
  host and queued every >4-job workflow fan-out for minutes.)
- **`containerMode.type: ""`** - **none**. The default chart offers `dind`
  (Docker-in-Docker sidecar) or `kubernetes` mode for job-container isolation;
  both are unnecessary here because the *whole runner pod* is already isolated in
  a microVM. The job runs directly in the runner container - no privileged dind
  sidecar, no extra attack surface.
- **`template.spec.runtimeClassName: kata-qemu`** - the critical line. It binds
  the pod to the Kata QEMU runtime ([02-kata-runtime.md](02-kata-runtime.md)), so
  every runner boots its own KVM microVM with a guest kernel distinct from the host.
- **`image` / `imagePullPolicy: IfNotPresent`** - the locally built, dependency-baked
  runner image ([03-runner-image.md](03-runner-image.md)). `IfNotPresent` uses the
  copy already imported into cluster containerd; there is no registry. Bump the tag
  here when you rebuild the image (see [Operate](#7-operate)).
- **`command: ["/home/runner/run.sh"]`** - the stock actions-runner entrypoint;
  overridden explicitly because the custom image keeps the upstream layout.
- **`envFrom.secretRef`** - injects the `bazel-remote-ci` secret into every
  runner pod. This is a **legacy-named infra-presence marker**: the name predates
  the Bazel removal, and its only consumer today is
  [`.github/actions/bun-install`](../../.github/actions/bun-install/action.yml),
  which probes `$BAZEL_REMOTE_USER` to detect that a job runs on proto-kata infra
  (and should use the mounted PVC caches). Keep the `envFrom` injection; it has
  no build-system function anymore.
- **`securityContext.fsGroup: 1001`** - makes the mounted PVC writable by the
  image's `runner` user without replacing image-owned `~/.cargo/bin` or `~/.rustup`.
- **`initContainers.prepare-runner-cache`** - uses the same locally imported image
  to create the PVC subdirectories as root before the runner starts. This avoids
  relying on kubelet's subPath auto-create permissions and does not pull another
  image.
- **`volumeMounts`** - mounts the shared PVC only at `~/.bun/install/cache` and
  `~/.cargo/registry`. `node_modules`, Cargo `target/`, and Cargo git checkouts
  stay inside the throwaway VM filesystem.
- **`volumes[].persistentVolumeClaim.claimName: runner-cache`** - binds those
  mounts to the `arc-runners/runner-cache` PVC. `ReadWriteOnce` is enough on this
  single-node k3s host; use a RWX-capable storage class before spreading runners
  across nodes.
- **`resources`** - requests `3` CPU / `10Gi`, limits `8` CPU / `14Gi`
  (burstable; see the `maxRunners` bullet above). Kata sizes the guest from
  these: every VM boots at the fixed floor from the runtime config
  (`default_vcpus: 2`, `default_memory: 4096` — deliberately at or below the
  pod request so boot stays cheap) and hotplugs beyond it toward the pod
  **limits**, with `default_maxvcpus: 0` allowing up to all host CPUs.
  Effectively the **boot shape is a fixed floor**, the **requests are the
  scheduler's bin-packing unit**, and the **limits are the hotplug ceiling**.
  See [02-kata-runtime.md](02-kata-runtime.md) for the runtime knobs and
  [`infra/tune-kata-runtime.sh`](../tune-kata-runtime.sh) for the SSH-driven
  patch helper.

---

## 4. Job lifecycle and the no-permission ServiceAccount

One job runs in one fresh microVM that is destroyed afterward:

1. The **listener** (ns `arc-systems`) long-polls the GitHub Actions service for
   jobs whose `runs-on` matches `proto-kata`.
2. When jobs are assigned, the controller reconciles the `AutoscalingRunnerSet`
   and creates an **`EphemeralRunnerSet`** sized to the demand (bounded by
   `minRunners`/`maxRunners`).
3. Each replica becomes an **ephemeral runner pod** registered **just-in-time
   (JIT)** with GitHub - a per-runner registration secret is minted, not a
   long-lived token.
4. Because the pod's `runtimeClassName` is `kata-qemu`, it **boots a microVM**,
   pulls the one assigned job, runs it, and exits.
5. ARC **deletes the pod** (and its microVM); a clean VM is created for the next
   job. There is no VM templating - state never leaks between jobs.

Observe the chain live:

```bash
kubectl -n arc-runners get autoscalingrunnerset proto-kata
kubectl -n arc-runners get ephemeralrunnerset
kubectl -n arc-runners get pods -o wide      # one pod per in-flight job; empty when idle
```

**No-permission ServiceAccount.** The scale-set chart runs every runner pod under
a ServiceAccount with no RBAC bindings:

```bash
kubectl -n arc-runners get sa
# default
# proto-kata-gha-rs-no-permission
```

Job code therefore has no Kubernetes API rights - it cannot read secrets, list
pods, or touch the cluster, even though it executes inside the cluster. Combined
with microVM isolation and the egress policy ([step 6](#6-runner-egress-lockdown)),
a compromised job is boxed into a throwaway VM with no cluster reach.

---

## 5. Shared caches (runner PVC)

GitHub's hosted cache backend is only reachable over the node's NAT egress, so on
a busy matrix (many concurrent jobs) it becomes the bottleneck. This setup keeps
the hot paths inside the cluster:

- **`runner-cache` PVC** is mounted into every runner for Bun's global package
  store and Cargo's crates.io registry cache/index.

### 5a. Retired: the bazel-remote service

The repo previously deployed an in-cluster **bazel-remote** server (namespace
`bazel-cache`) as the Bazel action/CAS cache for the native pipeline. The Bazel
build system is gone — Rust validation runs plain cargo and addons build via
`scripts/build-natives.sh` with an actions/cache entry in `rust_validate` — so
the deployment configs (`infra/bazel-remote/`) were removed from the repo. If
the namespace still exists on your host, tear it down:

```bash
kubectl delete namespace bazel-cache          # removes the bazel-remote deploy, svc, PVC
# then drop the tcp/9092 egress rule for the bazel-cache namespace from
# runner-egress-lockdown (see step 6) and `helm upgrade` nothing — the policy
# is applied directly.
```

The `bazel-remote-ci` secret in `arc-runners` is deliberately KEPT despite its
name: it is envFrom-injected into every runner pod, and
[`.github/actions/bun-install`](../../.github/actions/bun-install/action.yml)
probes `$BAZEL_REMOTE_USER` as its "am I on infra?" signal to decide between the
mounted PVC caches and actions/cache. It is a legacy-named marker with zero
Bazel function; do not delete the secret or the `envFrom` entry.

### 5b. The cache consumers

**(a) Cargo registry cache** - the scale-set pod template mounts only the
immutable download cache and sparse index at
`/home/runner/.cargo/registry/cache` and `/home/runner/.cargo/registry/index`.
Source extraction, lock files, Cargo git checkouts, and `target/` remain
job-local; virtio-fs does not propagate Cargo's file locks safely across VMs.
(The `rust_validate` CI job additionally saves/restores a workspace `target/`
snapshot through stock `actions/cache`, keyed on the `Cargo.lock` hash.)

**(b) Bun package store** -
[`.github/actions/bun-install`](../../.github/actions/bun-install/action.yml)
wraps `bun install --frozen-lockfile`. On proto-kata, the pod template mounts
`runner-cache` at Bun's default store path
(`/home/runner/.bun/install/cache`), so the action only ensures the directory
exists before running Bun. Off-infra it still uses stock `actions/cache@v4` for
the same store path.

`node_modules` is deliberately not shared. It is lockfile-, platform-, script-,
and workspace-state-sensitive, and concurrent jobs would write through the same
tree. The clean VM still runs `bun install --frozen-lockfile`; it just reuses the
package tarball/extract store.

### 5c. Poisoning boundary and pressure

Untrusted code never reaches these caches: `ci.yml` routes every pull-request
job to GitHub-hosted runners (`runs-on` resolves to `proto-kata` only for
`push`/main, manual dispatch, and release). That expression lives in the base
workflow, which GitHub uses verbatim for `pull_request` events, so a fork cannot
override it. As defense in depth, set the repo's **Settings -> Actions -> Fork
pull request workflows** policy to *Require approval for all outside
collaborators* (or all forks). GitHub's public-repo default only gates
first-time contributors.

The mounted-cache design narrows the blast radius of trusted runs: no shared
`node_modules`, no shared Cargo `target/` through the PVC, Bun installs from
`bun.lock`, and Cargo registry entries are checked against lockfile/source
checksums.

Pressure is mostly self-managing; coarse manual cleanup is to scale `proto-kata`
to zero, delete `bun-store/` or `cargo-registry/` from the bound local-path
volume, and let the next jobs repopulate it.

---

## 6. Runner egress lockdown

Runner pods reach the public internet (GitHub, package registries, crates.io,
npm) but must **not** reach the host's own services, the LAN, the tailnet, or
arbitrary cluster workloads. A single NetworkPolicy in `arc-runners` enforces
this. Because the pod template sets no special labels, the policy uses
`podSelector: {}` to cover **every** pod in the namespace.

> k3s ships a built-in NetworkPolicy controller (kube-router based) that enforces
> policies even though the CNI is Flannel - so this policy actually takes effect.
> Do not start k3s with `--disable-network-policy` ([01-host-and-cluster.md](01-host-and-cluster.md)),
> or the lockdown silently becomes a no-op.

Live spec (captured with `kubectl get networkpolicy -n arc-runners runner-egress-lockdown -o yaml`;
server-managed metadata omitted, host public IP redacted):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: runner-egress-lockdown
  namespace: arc-runners
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  egress:
    # 1. Cluster DNS only (CoreDNS + kube-system).
    - to:
        - ipBlock:
            cidr: 10.43.0.10/32
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # 2. Public internet, MINUS all private/infra ranges and the host's own public IP.
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
              - 169.254.0.0/16
              - 100.64.0.0/10
              - <PUBLIC_IP>/32
    # 3. RustFS shared cache (S3) - legacy, removed together with sccache;
    #    drop this rule when the legacy namespace is torn down.
    - to:
        - ipBlock:
            cidr: 10.43.0.0/16
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: sccache
      ports:
        - port: 9000
          protocol: TCP
```

The allow-list, rule by rule:

- **Rule 1 - DNS.** UDP/TCP 53 to CoreDNS (`10.43.0.10/32`) and the `kube-system`
  namespace. Without this, name resolution breaks and rule 2 is useless.
- **Rule 2 - public internet only.** `0.0.0.0/0` with an `except` list that
  carves out every range a job has no business reaching: RFC1918 private space
  (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`), the CGNAT range
  used by the **tailnet** (`100.64.0.0/10`), and the **host's own public IP**
  (`<PUBLIC_IP>/32`). Note `10.0.0.0/8` covers the pod CIDR (`10.42.0.0/16`) and
  service CIDR (`10.43.0.0/16`), so this rule alone gives a job **zero** in-cluster
  reach - the remaining rules punch the only holes the job legitimately needs.
- **Rule 3 - RustFS cache (legacy).** TCP 9000 to the service CIDR
  (`10.43.0.0/16`) and the `sccache` namespace - drop this rule when the legacy
  stack is torn down.
- **Retired rule - bazel-remote cache.** The tcp/9092 hole to the `bazel-cache`
  namespace existed for the former Bazel remote cache; with that service removed
  ([5a](#5a-retired-the-bazel-remote-service)), delete the rule from the live
  policy:

  ```bash
  kubectl -n arc-runners patch networkpolicy runner-egress-lockdown --type=json \
    --patch='[{"op":"remove","path":"/spec/egress/3"}]'
  ```
- **Ingress.** `policyTypes` lists `Ingress` but no ingress rule is defined, which
  is a **default-deny**: nothing can open a connection *into* a runner pod.

Egress that survives rule 2 leaves the node via the host's firewalld masquerade
(SNAT to the public IP) over the default interface - see
[01-host-and-cluster.md](01-host-and-cluster.md) for the host firewall side.

### Security model

- **Kernel isolation.** Each job runs in a Kata microVM with its own guest kernel
  (6.x), separate from the host kernel (7.0.x) - a kernel exploit hits a throwaway
  VM, not the host. See [02-kata-runtime.md](02-kata-runtime.md).
- **No cluster rights.** Jobs run under `proto-kata-gha-rs-no-permission` with no
  RBAC ([step 4](#4-job-lifecycle-and-the-no-permission-serviceaccount)).
- **Constrained network.** The policy above blocks the host, LAN, tailnet, and
  arbitrary cluster pods; only DNS, the public internet, and the shared runner-cache
  PVC (plus legacy RustFS until torn down) are reachable.
- **Ephemeral.** One job per VM, destroyed afterward - no state, secret, or
  artifact survives into the next job.
- **Public-repo recommendation.** For a public repo, require approval for fork
  PRs so untrusted code cannot auto-run on the infra: **repo - Settings - Actions
  - General - Fork pull request workflows from outside collaborators - Require
  approval for all outside collaborators**.

---

## 7. Operate
```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```

**Status / scale**

```bash
kubectl -n arc-runners get autoscalingrunnerset proto-kata   # min/max/current runners
kubectl -n arc-runners get ephemeralrunnerset              # desired vs current replicas
kubectl -n arc-runners get pods -o wide                    # live runner VMs (empty when idle)
```

**Logs**

```bash
# Listener (job dispatch / scaling decisions)
kubectl -n arc-systems logs -l app.kubernetes.io/component=runner-scale-set-listener -f
# Controller (reconciliation)
kubectl -n arc-systems logs deploy/arc-gha-rs-controller -f
# A specific runner / its job
kubectl -n arc-runners logs <runner-pod>
```

**Verify the caches are being used.** A warm job on proto-kata logs
`bun cache backend: mounted PVC (...)`. To inspect the mounted
runner cache, scale to zero and check the `runner-cache` local-path volume on
the host.

**Resize a job's VM** - edit the `resources` block in `arc-proto-values.yaml`
([step 3](#3-scale-set-values-arc-proto-valuesyaml); requests = guaranteed VM size,
limits = hotplug ceiling) and roll out:

```bash
helm upgrade proto-kata \
  --namespace arc-runners --version 0.14.2 \
  -f arc-proto-values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

**Change scale-to-zero bounds** - edit `minRunners` / `maxRunners` in the same
file and `helm upgrade` as above. (Keep `maxRunners` within the node's CPU/RAM
budget: each runner can hotplug up to its `limits`.)

**Update the runner image** - bump `template.spec.containers[0].image` to the new
tag, then `helm upgrade` as above; confirm with:

```bash
kubectl -n arc-runners get autoscalingrunnerset proto-kata \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

See [03-runner-image.md](03-runner-image.md) for building and importing the image.

**Add another repo.** Because the GitHub App installation can cover multiple repos,
reuse the same `arc-github` secret and install a second scale set with its own
`githubConfigUrl`, `runnerScaleSetName` (the new `runs-on:` label), and release
name:

```bash
helm install <release> \
  --namespace arc-runners --version 0.14.2 \
  --set githubConfigUrl=https://github.com/<OWNER>/<OTHER_REPO> \
  --set githubConfigSecret=arc-github \
  --set runnerScaleSetName=<other-repo>-kata \
  -f arc-proto-values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

Jobs in the other repo then target `runs-on: <other-repo>-kata`. (On this host a
convenience wrapper, `proto-add-repo-runner <OWNER>/<REPO> [label]`, performs exactly
this install.)

**Uninstall** (leaves k3s/Kata in place):

```bash
helm uninstall proto-kata -n arc-runners
helm uninstall arc -n arc-systems
```

---

**Previous:** [03-runner-image.md](03-runner-image.md) - the preloaded runner image.
**Overview:** [README.md](README.md) - architecture and the full doc set.
