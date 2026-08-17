import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WangganError, writeJson } from "./lib/core.mjs";
import { loadProfile, compareProfileLock } from "./lib/profile-loader.mjs";

const skillRoot = fileURLToPath(new URL("..", import.meta.url));
const testIp = path.join(skillRoot, "scripts/fixtures/profiles/test-ip");

const base = await loadProfile("base");
assert.equal(base.id, "base");
assert.ok(base.assetTypes.has("base.video"));
assert.ok(base.assetTypes.has("base.keywords"));
assert.ok(base.effectTypes.has("base.scale"));
assert.ok(base.effectTypes.has("base.text-style"));
assert.ok(base.effectTypes.has("base.item-enter"));
assert.deepEqual(base.extends, ["foundation"]);
assert.equal(base.selectionRules.length, 1);
assert.equal(base.assetTypes.get("base.list").defaults.props.container.background_opacity, 0.82);
const foundation = await loadProfile("foundation");
assert.equal(foundation.id, "foundation");
assert.equal(foundation.selectionRules.length, 0);
assert.equal(foundation.assetTypes.get("base.list").defaults.props.container.background_opacity, 0);
assert.equal(foundation.assetTypes.get("base.keywords").defaults.props.style.color, "#FFFFFF");
assert.ok(base.digest.startsWith("sha256:"));
const again = await loadProfile("base");
assert.equal(again.digest, base.digest);

const extended = await loadProfile(testIp);
assert.equal(extended.id, "test-ip");
assert.ok(extended.assetTypes.has("base.video"));
assert.ok(extended.effectTypes.has("base.scale"));
assert.ok(extended.effectTypes.has("test-ip.fade"));
assert.equal(extended.effectTypes.get("test-ip.fade").operator, "core.style.opacity");

const cycleDir = fs.mkdtempSync(path.join(os.tmpdir(), "wanggan-cycle-"));
writeJson(path.join(cycleDir, "profile.json"), {
  schema_version: 1,
  id: "cycle-a",
  version: "1.0.0",
  extends: [cycleDir],
  selection_rules: [],
  asset_types: [],
  effect_types: [],
  constraints: [],
  runtime_modules: [],
});
await assert.rejects(() => loadProfile(cycleDir), /循环继承/);

const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), "wanggan-dup-"));
fs.mkdirSync(path.join(dupDir, "effect-types"));
writeJson(path.join(dupDir, "profile.json"), {
  schema_version: 1,
  id: "dup",
  version: "1.0.0",
  extends: ["base"],
  selection_rules: [],
  asset_types: [],
  effect_types: ["effect-types/scale.json"],
  constraints: [],
  runtime_modules: [],
});
writeJson(path.join(dupDir, "effect-types/scale.json"), {
  schema_version: 1,
  kind: "effect_type",
  id: "base.scale",
  operator: "core.transform.scale",
  requires_capabilities: ["transform.scale"],
  writes_channels: ["transform.scale"],
  config_schema: { type: "object" },
});
await assert.rejects(() => loadProfile(dupDir), /namespace|未声明 override/);

const escapeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wanggan-escape-"));
writeJson(path.join(escapeDir, "profile.json"), {
  schema_version: 1,
  id: "escape",
  version: "1.0.0",
  extends: [],
  selection_rules: ["../secret.md"],
  asset_types: [],
  effect_types: [],
  constraints: [],
  runtime_modules: [],
});
await assert.rejects(() => loadProfile(escapeDir), /不得越出/);

const codeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wanggan-code-"));
fs.writeFileSync(path.join(codeDir, "mod.mjs"), "export default function register() {}");
writeJson(path.join(codeDir, "profile.json"), {
  schema_version: 1,
  id: "coded",
  version: "1.0.0",
  extends: ["base"],
  selection_rules: [],
  asset_types: [],
  effect_types: [],
  constraints: [],
  runtime_modules: ["mod.mjs"],
});
await assert.rejects(() => loadProfile(codeDir), /allow-profile-code/);
const allowed = await loadProfile(codeDir, { allowProfileCode: true });
assert.equal(allowed.id, "coded");
const preflight = await loadProfile(codeDir, { loadRuntime: false });
assert.equal(preflight.hasRuntimeCode, true);

const patchedDir = fs.mkdtempSync(path.join(os.tmpdir(), "wanggan-patched-profile-"));
fs.mkdirSync(path.join(patchedDir, "rules"));
fs.writeFileSync(path.join(patchedDir, "rules/selection.md"), "# 我的 IP 规则\n");
writeJson(path.join(patchedDir, "profile.json"), {
  schema_version: 1,
  id: "patched",
  version: "1.0.0",
  extends: ["base"],
  selection_rules_mode: "replace",
  selection_rules: ["rules/selection.md"],
  asset_types: [],
  effect_types: [],
  constraints: [],
  patches: ["patches.json"],
  runtime_modules: [],
});
writeJson(path.join(patchedDir, "patches.json"), {
  schema_version: 1,
  patches: [{
    kind: "asset_type",
    id: "base.list",
    changes: { defaults: { props: { style: { color: "#22CC88" } } } },
  }],
});
const patched = await loadProfile(patchedDir);
assert.equal(patched.selectionRules.length, 1);
assert.match(patched.selectionRules[0].text, /我的 IP/);
assert.equal(patched.assetTypes.get("base.list").defaults.props.style.color, "#22CC88");
assert.equal(patched.assetTypes.get("base.list").defaults.props.style.font_family, "Microsoft YaHei");
assert.equal(patched.assetTypes.get("base.list").defaults.props.container.background_opacity, 0.82);

const badChannelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "wanggan-bad-channels-"));
fs.mkdirSync(path.join(badChannelsDir, "effect-types"));
writeJson(path.join(badChannelsDir, "profile.json"), {
  schema_version: 1,
  id: "bad-channels",
  version: "1.0.0",
  extends: ["base"],
  selection_rules: [],
  asset_types: [],
  effect_types: ["effect-types/broken.json"],
  constraints: [],
  runtime_modules: [],
});
writeJson(path.join(badChannelsDir, "effect-types/broken.json"), {
  schema_version: 1,
  kind: "effect_type",
  id: "bad-channels.broken",
  operator: "core.style.opacity",
  requires_capabilities: ["style.opacity"],
  timing_models: ["word_range"],
  writes_channels: ["transform.scale"],
  config_schema: { type: "object" },
});
await assert.rejects(() => loadProfile(badChannelsDir), /不会写入|channel/);

const changed = JSON.parse(JSON.stringify(base.lock()));
changed.digest = "sha256:deadbeef";
const mismatch = compareProfileLock(base, changed);
assert.equal(mismatch.ok, false);
assert.ok(mismatch.changes.some((item) => item.includes("digest")));

fs.rmSync(cycleDir, { recursive: true, force: true });
fs.rmSync(dupDir, { recursive: true, force: true });
fs.rmSync(escapeDir, { recursive: true, force: true });
fs.rmSync(codeDir, { recursive: true, force: true });
fs.rmSync(badChannelsDir, { recursive: true, force: true });
fs.rmSync(patchedDir, { recursive: true, force: true });

process.stdout.write("wanggan profile tests passed\n");
