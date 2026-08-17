import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileProject } from "./lib/compiler.mjs";
import { emptyComposition, validateComposition } from "./lib/composition.mjs";
import { validateTranscript, writeJson } from "./lib/core.mjs";
import { expandEffectInstance, loadProfile } from "./lib/profile-loader.mjs";

const words = validateTranscript([
  { text: "第一", start: 0.1, end: 0.3 },
  { text: "清晰", start: 0.3, end: 0.55 },
  { text: "第二", start: 0.8, end: 1.0 },
  { text: "可信", start: 1.0, end: 1.25 },
]);
const project = {
  projectDir: process.cwd(),
  videoPath: "input.mp4",
  subtitlePath: "input.srt",
  displayWidth: 720,
  displayHeight: 1280,
  duration: 1.4,
  inputs: { captions: { path: "input.srt", cues: [] } },
};
const scenarios = [{
  id: "primitive-contract",
  container: {
    background_color: "#10243A",
    background_opacity: 0.9,
    border_color: "#6B8299",
    border_opacity: 0.5,
    border_width_ratio: 0.001,
    border_radius_ratio: 0.006,
    padding_ratio: 0.018,
  },
  textColor: "#E8EEF4",
  entry: { from_translate_y_ratio: 0.015, to_translate_y_ratio: 0, from_opacity: 0, to_opacity: 1, duration: 0.42, delay: 0, easing: "linear" },
}];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wanggan-foundation-profiles-"));
try {
  const results = [];
  for (const scenario of scenarios) {
    const profileDir = path.join(root, scenario.id);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, "selection-rules.md"), `# ${scenario.id}\n`);
    writeJson(path.join(profileDir, "profile.json"), {
      schema_version: 1,
      id: scenario.id,
      version: "1.0.0",
      extends: ["base"],
      selection_rules_mode: "replace",
      selection_rules: ["selection-rules.md"],
      asset_types: [],
      effect_types: [],
      constraints: [],
      patches: ["patches.json"],
      runtime_modules: [],
    });
    writeJson(path.join(profileDir, "patches.json"), {
      schema_version: 1,
      patches: [{
        kind: "asset_type",
        id: "base.list",
        changes: {
          defaults: { props: { container: scenario.container, style: { color: scenario.textColor } } },
        },
      }],
    });
    const profile = await loadProfile(profileDir);
    assert.equal(profile.hasRuntimeCode, false);
    assert.ok(profile.primitiveTypes.has("base.transform.translate-y"));
    assert.ok(profile.primitiveTypes.has("base.container.background-color"));
    assert.deepEqual(
      profile.effectTypes.get("base.item-enter").composes.map((item) => item.effect_type),
      ["base.translate-y-entry", "base.opacity-entry"],
    );
    assert.equal(profile.assetTypes.get("base.list").renderer, "core.text-group");
    assert.equal(profile.selectionRules.length, 1);
    const composition = emptyComposition(profile);
    composition.assets.push({
      id: "list.001",
      type: "base.list",
      enabled: true,
      source: { kind: "agent-generated" },
      lifecycle: { kind: "word_range", start_word_index: 0, end_word_index: 3 },
      props: {
        items: [
          { start_word_index: 0, end_word_index: 1, display_text: "一、清晰" },
          { start_word_index: 2, end_word_index: 3, display_text: "二、可信" },
        ],
      },
      origin: { created_by: "agent", human_modified: false },
    });
    composition.effects.push({
      id: "effect.001",
      type: "base.progressive-reveal",
      target: { asset_id: "list.001" },
      timing: { kind: "asset_items" },
      config: { retain_until: "asset_end" },
      origin: { created_by: "agent", human_modified: false },
    });
    if (scenario.entry) {
      composition.effects.push({
        id: "effect.002",
        type: "base.item-enter",
        target: { asset_id: "list.001" },
        timing: { kind: "item_enter" },
        config: scenario.entry,
        origin: { created_by: "agent", human_modified: false },
      });
    }
    const normalized = validateComposition(composition, profile, words, project);
    assert.equal(normalized.effects.filter((item) => item.type === "base.item-enter").length, 1);
    assert.deepEqual(
      expandEffectInstance(normalized.effects.find((item) => item.type === "base.item-enter"), profile)
        .map((item) => item.type),
      ["base.translate-y-entry", "base.opacity-entry"],
    );
    const ir = await compileProject(project, {
      context: { project, profile, words, captionCues: [], lockStatus: { ok: true, changes: [] } },
      composition: normalized,
    });
    const group = ir.structuredOverlayTrack.groups[0];
    assert.equal(group.container.background_color, scenario.container.background_color);
    assert.equal(group.style.color, scenario.textColor);
    assert.match(ir.assText, /\\p1/);
    if (scenario.entry) {
      assert.equal(group.effects.entryTranslateY.length, 2);
      assert.match(ir.assText, /\\move\(/);
    } else {
      assert.equal(group.effects.entryTranslateY.length, 0);
      assert.doesNotMatch(ir.assText, /\\move\(/);
    }
    results.push({ id: scenario.id, assText: ir.assText });
  }
  assert.equal(new Set(results.map((item) => item.assText)).size, scenarios.length);
  process.stdout.write("wanggan foundation primitive tests passed\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
