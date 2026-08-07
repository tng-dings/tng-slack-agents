import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { defaultSlackHttpHardening } from "../src/slack.js";

test("NGINX edge bounds and buffers traffic before the private Bolt listener", async () => {
  const configuration = await readFile("deploy/nginx/slack-edge.conf", "utf8");

  assert.match(configuration, /listen 443 ssl;/);
  assert.match(configuration, /upstream slack_bolt_private {\s*server 127\.0\.0\.1:3000;/);
  assert.match(configuration, /location = \/slack\/events \{/);
  assert.match(configuration, /\$request_method != POST/);
  assert.match(configuration, /location = \/healthz \{/);
  assert.match(configuration, /\$request_method != GET/);
  assert.match(configuration, /location \/ \{\s*return 404;/);

  assert.match(configuration, /client_max_body_size 256k;/);
  assert.match(configuration, /client_body_buffer_size 256k;/);
  assert.match(configuration, /proxy_request_buffering on;/);
  assert.match(configuration, /client_body_timeout 5s;/);
  assert.match(configuration, /client_header_timeout 5s;/);
  assert.match(configuration, /large_client_header_buffers 2 8k;/);
  assert.match(configuration, /limit_conn global_connections 100;/);
  assert.match(configuration, /limit_req zone=global_requests/);
  assert.match(configuration, /proxy_connect_timeout 1s;/);

  const logFormat = configuration.split(/\r?\n/).find((line) => line.includes("log_format privacy"));
  assert(logFormat);
  assert.doesNotMatch(logFormat, /\$args|\$request_uri|\$request_body|\$http_|\$upstream_http_/);
  assert.match(configuration, /error_log logs\/slack-edge-error\.log crit;/);
  assert.match(configuration, /access_log off;/);
});

test("representative maximum-attachment Slack metadata fits the 256 KiB bound", () => {
  const longMetadata = "m".repeat(8_192);
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "T0123456789",
    api_app_id: "A0123456789",
    event_id: "Ev0123456789",
    event: {
      type: "message",
      channel_type: "im",
      channel: "D0123456789",
      user: "U0123456789",
      ts: "1723020123.123456",
      text: "x".repeat(12_000),
      files: Array.from({ length: 4 }, (_value, index) => ({
        id: `F${index}`,
        name: longMetadata,
        title: longMetadata,
        mimetype: "image/png",
        size: 5_000_000,
        url_private_download: `https://files.slack.com/files-pri/example/${index}`,
      })),
    },
  });

  assert(Buffer.byteLength(body) < defaultSlackHttpHardening.maxBodyBytes);
  assert.equal(defaultSlackHttpHardening.maxBodyBytes, 256 * 1024);
});

test("deployment evidence validates an explicitly selected effective NGINX configuration", async () => {
  const script = await readFile("scripts/Test-AgentRunnerSecurity.ps1", "utf8");
  const runbook = await readFile("docs/public-endpoint-hardening.md", "utf8");

  assert.match(script, /\[string\]\$EdgeConfigPath = ""/);
  assert.doesNotMatch(script, /EdgeConfigPath = "\$PSScriptRoot\\\.\.\\deploy/);
  assert.match(script, /-T -c \$resolvedEdgeConfigPath/);
  assert.match(script, /\[regex\]::Escape\(\[string\]\$http\.eventsPath\)/);
  assert.match(script, /\[regex\]::Escape\(\[string\]\$http\.healthPath\)/);
  assert.match(runbook, /Test-AgentRunnerSecurity\.ps1 -EdgeConfigPath \$edgeConfigPath/);
});
