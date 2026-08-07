# Slack public endpoint hardening

This is the production runbook for Events API ingress. Socket Mode does not use it.

## Required topology

```text
Internet
  -> NGINX or a managed TLS load balancer (public 443)
       -> request buffering, 256 KiB body limit, header/time/connection limits, rate limits
       -> exact routes only
  -> 127.0.0.1:3000 (private Node/Bolt listener)
       -> Slack signature and timestamp verification
       -> app/workspace/user/DM authorization
       -> durable inbox
```

For M2-D, the supported concrete deployment is a hardened NGINX instance on the same host as the service. [`deploy/nginx/slack-edge.conf`](../deploy/nginx/slack-edge.conf) terminates TLS and proxies to `127.0.0.1:3000`. The configuration loader requires that exact IPv4 loopback address for `slack.http.host`, so the Bolt port cannot be published on a LAN or internet interface and cannot drift to an IPv6 listener that the reviewed edge does not use. Do not add a firewall port-forward, load-balancer target, or container port mapping for port 3000.

If a managed load balancer is introduced later, retain a same-host reverse proxy or add an equivalent private-listener control and deployment test. A security group alone does not make `0.0.0.0` an approved M2-D configuration.

## Edge installation

1. Install a supported, patched NGINX release from the approved package source and run it under a dedicated unprivileged service identity.
2. Copy `deploy/nginx/slack-edge.conf` into the NGINX configuration directory.
3. Replace `slack-agent.example.com` and the certificate paths. Provision the certificate through the organization's managed certificate process. Restrict the private-key ACL to administrators, SYSTEM, and the NGINX identity.
4. Keep Node configured for `127.0.0.1:3000`, `/slack/events`, and `/healthz`. If the port or route changes, update and test both configurations atomically.
5. Validate the installed configuration with `nginx -t -c <installed-nginx.conf>`, start/reload NGINX using that same configuration, and confirm the only non-loopback listener is public TLS port 443. Do not expose an HTTP port merely to redirect it.
6. Configure Slack's Request URL as `https://<approved-host>/slack/events`.

Only these public operations exist:

| Method | Path | Response purpose |
| --- | --- | --- |
| `POST` | `/slack/events` | Signed Slack Events API and URL-verification requests |
| `GET` | `/healthz` | Fixed JSON liveness response |

All other paths return 404. Wrong methods return 405. The health response contains no dependency, database, queue, configuration, version, credential, or readiness details.

## Enforced limits

The edge and private listener use matching upper bounds:

| Control | Bound |
| --- | --- |
| Request body | 256 KiB, fully buffered by NGINX before proxying |
| Request headers | 1 KiB normal buffer plus two 8 KiB large buffers; Node maximum 16 KiB |
| Header/body receive time | 5 seconds |
| Upstream connect/send/read | 1/3/4 seconds for events |
| Keep-alive | 5 seconds, at most 100 requests per socket |
| Connections | 10 per source and 100 total at NGINX; 100 total at Node |
| Requests | 5/second per source and 20/second total, with bounded bursts |

Slack sends file metadata, not file bytes, in an event. The automated representative-payload test includes the configured maximum of four files, 12,000 prompt characters, and deliberately inflated 8 KiB names and titles. It remains below 256 KiB. Raising the limit requires a new representative test and security review; application configuration rejects values above the reviewed bounds.

`proxy_request_buffering on` and `client_max_body_size` are essential: oversized traffic must be rejected before Bolt is contacted. The private listener also pre-buffers to the same bounded size before invoking Bolt, which is defense in depth rather than a replacement for the edge.

## Rate limiting and AWS WAF

The NGINX policy applies per-source and global request/connection limits. Slack signatures remain the authentication control. Do not replace them with Slack source-IP allowlisting; Slack's delivery addresses can change, and an IP match does not authenticate a request.

For an AWS Application Load Balancer deployment, attach AWS WAF and evaluate:

- the AWS managed core and known-bad-input rule groups in count mode before blocking;
- a global rate-based rule with an alarm below the load balancer or coordinator saturation point;
- explicit maximum body and header behavior at every hop;
- exclusions required for valid Slack JSON without excluding `/slack/events` from signature verification.

Archive count-mode samples with request bodies and signature headers redacted. Promote rules to block only after valid Slack URL verification and event deliveries pass. Source-IP allowlisting is explicitly rejected as the authentication design.

## Time synchronization

Bolt's replay protection depends on accurate system time. Keep Windows Time enabled and monitored:

```powershell
Set-Service W32Time -StartupType Automatic
Start-Service W32Time
w32tm /query /status
w32tm /stripchart /computer:time.windows.com /samples:5 /dataonly
```

Use the organization's approved NTP source in production. Alert on synchronization failure or material offset, and stop accepting Events API traffic if time cannot be trusted.

## Signing-secret storage and rotation

Store `SLACK_SIGNING_SECRET` only in the DPAPI-protected gateway bundle created by `Set-AgentRunnerSecrets.ps1`, or in the deployment's approved secret manager. It must never enter the worker bundle, OpenCode environment, NGINX configuration, command line, audit payload, or log.

Rotation is a coordinated maintenance operation:

1. Stop the AgentRunner or drain public events at the edge.
2. Regenerate the signing secret in Slack administration through the approved operator account.
3. Rerun `Set-AgentRunnerSecrets.ps1 -SlackIngress events-api` and restart AgentRunner.
4. Validate `/healthz`, Slack URL verification, one authorized event, one invalid signature, and one stale timestamp.
5. Resume traffic and record the operator, time, test evidence, and next rotation date without recording either secret.

On suspected disclosure, block the public event route, regenerate immediately, rotate the bot token as a separate credential, and review bounded security logs and Slack administration audit history.

## Logging and dependency maintenance

NGINX request access logging is disabled by default so floods cannot amplify logs; request-generated error messages below critical severity are also suppressed. Its defined `privacy` format excludes query strings, headers, and bodies and may be enabled only for an approved, time-bounded diagnostic. Bolt rejection logging emits only fixed categories, allows ten messages per category per minute, and then emits one suppression notice. Never enable debug request logging at the edge or receiver. Logs must not contain bodies, Slack signatures, timestamps paired with signatures, prompts, tokens, attachment metadata, or parser excerpts. Use rate-limit metrics from the managed edge/WAF for sustained monitoring rather than request logs.

Dependabot and the scheduled `dependency-security` workflow monitor Node dependencies. Operators must:

- deploy an actively supported Node LTS release allowed by `package.json`;
- review weekly dependency updates, especially `@slack/bolt`, `@slack/web-api`, NGINX, and Node;
- run `npm run security:audit`, `npm run check`, `npm test`, and `npm run build` before deployment;
- patch critical/high findings or remove the endpoint from service until an approved mitigation exists.

## Deployment evidence

Archive these results with the deployment ticket:

```powershell
npm ci
npm run check
npm test
npm run build
npm run security:audit
$edgeConfigPath = "C:\nginx\conf\slack-edge.conf"
nginx -t -c $edgeConfigPath
Get-NetTCPConnection -State Listen | Sort-Object LocalPort
.\scripts\Test-AgentRunnerSecurity.ps1 -EdgeConfigPath $edgeConfigPath
w32tm /query /status
```

From a host outside the deployment network, verify that public 443 exposes only the two routes and that port 3000 is unreachable. Exercise valid, invalid, stale, malformed, wrong-method/path, oversized, slow, duplicate, retry, wrong-workspace, and wrong-user cases. Confirm invalid, stale, malformed, and oversized cases create no job and no Slack API call. Confirm unauthorized cases create no job and at most one rate-limited denial reply, and confirm duplicates create one job and at most one initial reply. Finally, search edge, service, and audit logs for the test prompt, signature, token, and attachment marker strings and require zero matches.

Automated tests validate the configuration and application boundary. They cannot prove firewall state, certificate installation, external reachability, NTP health, or deployed log collection; the archived deployment checks are mandatory evidence.
