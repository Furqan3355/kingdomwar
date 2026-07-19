# Storm of Wars–Inspired MMORTS
## Technical Design Document — Volume 14: Deployment
### Unity + Nakama

*Final volume. Extends Volume 1's local docker-compose (§3) into a production deployment, incorporating Volume 12's monitoring/scaling requirements and Volume 11's gateway-level rate limiting.*

---

## 1. Docker

Volume 1's `docker-compose.yml` (Nakama + CockroachDB) is the local-dev baseline. Production images should be built from it with: pinned Nakama version (already `3.21.1` in Volume 1), the compiled `nakama/build/index.js` module baked into the image rather than volume-mounted, and no debug logging (`--logger.level DEBUG` from Volume 1's compose file is dev-only — production uses `INFO` or `WARN`).

---

## 2. Kubernetes (optional)

For a launch expecting meaningful concurrent load, Kubernetes is the recommended path given Nakama's native clustering (Volume 1 §11, Volume 12 §9.1):

```yaml
# nakama-deployment.yaml (sketch)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nakama
spec:
  replicas: 3   # start here, scale per Volume 12 §9.1's latency/CPU trigger conditions
  selector:
    matchLabels: { app: nakama }
  template:
    metadata:
      labels: { app: nakama }
    spec:
      containers:
        - name: nakama
          image: registry.example.com/storm-mmorts/nakama:latest
          ports:
            - containerPort: 7350
            - containerPort: 7351
          env:
            - name: NAKAMA_DATABASE_ADDRESS
              valueFrom: { secretKeyRef: { name: db-credentials, key: address } }
          resources:
            requests: { cpu: "500m", memory: "512Mi" }
            limits: { cpu: "2", memory: "2Gi" }
```
Since Volume 6 Revision 2 removed all live match handlers (Volume 9 §3), Nakama pods are fully stateless from a gameplay-session perspective — no need for session affinity/sticky routing, simplifying the Kubernetes Service configuration to a plain round-robin `ClusterIP`/`LoadBalancer`.

---

## 3. PostgreSQL

Recommend a managed CockroachDB or Postgres service (e.g. CockroachCloud, RDS, Cloud SQL) over self-hosting for production, given the backup/PITR requirements from Volume 10 §6 — managed services handle WAL archiving and point-in-time recovery with far less operational burden than self-managed `pg_basebackup` pipelines. Self-hosting remains viable if the team has existing database-ops expertise, but isn't the default recommendation here.

---

## 4. Redis

Volume 1 §2 originally flagged Redis as optional ("for a fast tick-based world simulation layer if you outgrow Nakama's built-in match handlers"). Given Volume 6 Revision 2's removal of all live match handlers, **that original justification no longer applies** — Redis is not required by anything currently specified in this TDD. It remains a reasonable addition later only if a specific future need arises (e.g. a caching layer in front of `kingdom_power_index`-style hot queries, though that specific table was itself removed in Volume 6 Revision 2). Do not provision Redis for launch unless a concrete bottleneck justifies it.

---

## 5. Nginx

Sits in front of Nakama as the gateway layer referenced in Volume 11 §6.2 (per-user rate limiting) and §6 generally (TLS termination, the "https in production" note from Volume 1's `NakamaClientService` comment):

```nginx
upstream nakama {
    server nakama-1:7350;
    server nakama-2:7350;
    server nakama-3:7350;
}

server {
    listen 443 ssl;
    server_name api.stormmmorts.example.com;

    limit_req_zone $binary_remote_addr zone=rpc_limit:10m rate=20r/s;

    location /v2/rpc/attack_tile {
        limit_req zone=rpc_limit burst=5;
        proxy_pass http://nakama;
    }
    location / {
        proxy_pass http://nakama;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # required for WebSocket (chat/notifications, Vol.9 §5/§8)
        proxy_set_header Connection "upgrade";
    }
}
```
If running Kubernetes (§2), an Ingress controller (nginx-ingress or equivalent) replaces a standalone Nginx VM, same configuration intent.

---

## 6. CI/CD

### 6.1 Server pipeline
```
on push to main:
  1. npm run build (nakama/, per Volume 1 §package.json)
  2. run unit tests (the Jest/ts-node harness recommended back in Volume 1's README "known gaps" section — should exist by this volume)
  3. build + push Docker image
  4. apply Postgres migrations (Volume 10 §5's numbered migration set) against staging
  5. deploy to staging, run smoke tests against the RPC inventory (Volume 9 §2)
  6. manual approval gate → deploy to production
```

### 6.2 Client pipeline
Unity Cloud Build (or self-hosted equivalent) triggered on release branches, building both platform targets given the dual-client requirement — the same server build/RPC contract serves both without any pipeline duplication, since (per Volume 1 §2/§10) Unity and Godot are just two consumers of one API surface.

---

## 7. Production Environment

| Environment | Purpose | Data |
|---|---|---|
| **Dev** | Individual engineer local work | Volume 1's local docker-compose, throwaway data |
| **Staging** | Pre-release validation, QA | Persistent but resettable, mirrors production schema |
| **Production** | Live shards | Real player data, full backup/monitoring per §3, Volume 12 §8 |

Config data (Section 1's Postgres tables) should be **promoted** staging→production via the same migration/export pipeline (Volume 1 §9, Volume 10 §5), never hand-edited directly in production — keeps the "one source of truth flowing through one pipeline" discipline established since Volume 1 intact all the way to deployment.

---

## 8. Monitoring

Delivers on Volume 12 §8's requirements at the infrastructure layer: Prometheus scraping Nakama's native metrics endpoint (per-pod in Kubernetes), Grafana dashboards, and alerting rules wired to the specific failure modes flagged there (RPC error-rate spikes, scheduler job failures, DB pool exhaustion) — this volume's job is standing up the infrastructure Volume 12 specified the requirements for, not re-specifying those requirements.

---

## 9. Backups

Operationalizes Volume 10 §6's strategy: automated daily backups (30-day retention) + weekly (6-month retention) on the managed database service (§3), with a **quarterly restore drill** to a staging environment — verifying backups actually restore correctly is the difference between having a backup and believing you have one.

---

## Volume 14 — Deployment: Summary of Deliverables

- [ ] Production Docker images (Nakama with compiled modules baked in, no debug logging)
- [ ] Kubernetes manifests (Deployment, Service, Ingress) — stateless pod configuration, no session affinity needed
- [ ] Managed database provisioned with PITR enabled
- [ ] Nginx/Ingress gateway with TLS termination and per-endpoint rate limiting (Volume 11 §6.2)
- [ ] Server CI/CD pipeline: build → test → migrate → staging → manual-gated production deploy
- [ ] Client CI/CD: Unity Cloud Build (or equivalent) for both platform targets
- [ ] Dev/staging/production environment separation with config promoted only through the established pipeline, never hand-edited in prod
- [ ] Monitoring/alerting infrastructure live before launch, not after
- [ ] Backup restore drill completed and documented before go-live

## Explicitly deferred / not required for launch
- Redis (§4) — no current system in this TDD requires it, following Volume 6 Revision 2's removal of the one feature (rally/boss matches) that originally justified it

---

*End of Volume 14, and end of the full Technical Design Document (Volumes 1-14). Every system referenced as a forward-looking hook in an earlier volume has been resolved by a later one — Volume 9 and 10 additionally serve as consolidated indexes across the whole document for onboarding engineers who don't want to read all fourteen volumes in full before contributing.*
