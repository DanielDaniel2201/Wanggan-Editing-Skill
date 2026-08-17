const elements = {
  video: document.querySelector("#video"),
  previewPanel: document.querySelector("#previewPanel"),
  videoFrame: document.querySelector("#videoFrame"),
  videoStage: document.querySelector("#videoStage"),
  previewCanvas: document.querySelector("#previewCanvas"),
  imageOverlay: document.querySelector("#imageOverlay"),
  imageOverlayContent: document.querySelector("#imageOverlayContent"),
  imageResizeHandle: document.querySelector("#imageResizeHandle"),
  structuredOverlay: document.querySelector("#structuredOverlay"),
  structuredList: document.querySelector("#structuredList"),
  subtitleOverlay: document.querySelector("#subtitleOverlay"),
  subtitleText: document.querySelector("#subtitleText"),
  subtitleResizeHandle: document.querySelector("#subtitleResizeHandle"),
  transcript: document.querySelector("#transcript"),
  effectButtons: document.querySelector("#effectButtons"),
  effectTargetBadge: document.querySelector("#effectTargetBadge"),
  assetCreateButtons: document.querySelector("#assetCreateButtons"),
  saveStatus: document.querySelector("#saveStatus"),
  connectionStatus: document.querySelector("#connectionStatus"),
  activeEffectBadge: document.querySelector("#activeEffectBadge"),
  playPauseButton: document.querySelector("#playPauseButton"),
  seekSlider: document.querySelector("#seekSlider"),
  playerTime: document.querySelector("#playerTime"),
  playerControls: document.querySelector("#playerControls"),
  subtitleToggleButton: document.querySelector("#subtitleToggleButton"),
  fontActions: document.querySelector("#fontActions"),
  fontTargetLabel: document.querySelector("#fontTargetLabel"),
  fontFamilySelect: document.querySelector("#fontFamilySelect"),
  structuredEditor: document.querySelector("#structuredEditor"),
  saveProjectButton: document.querySelector("#saveProjectButton"),
  renderButton: document.querySelector("#renderButton"),
};

const previewContext = elements.previewCanvas.getContext("2d", { alpha: false });

let state = null;
let playbackEffects = [];
let playbackCaptions = [];
let playbackOverlays = [];
let playbackImageOverlays = [];
let renderEngineCompatible = false;
const requiredRenderEngineVersion = 20;
const selectedWords = new Set();
let dragging = false;
let paintShouldSelect = true;
let paintedDuringDrag = new Set();
let currentWordIndex = -1;
let reloadTimer = null;
let seeking = false;
let savingEffect = false;
let savingCaptions = false;
let savingOverlays = false;
let savingProject = false;
let pendingRestoreTime = null;
let saveButtonResetTimer = null;
let captionBoxSelected = false;
let captionInteraction = null;
let structuredBoxSelected = false;
let structuredSelectedItemId = null;
let structuredInteraction = null;
let imageBoxSelected = false;
let imageInteraction = null;
let selectedTextTarget = null;
let selectedEffectTargetId = null;

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
  } catch (error) {
    const unavailable = new Error("后台服务已断开，请重新启动工作台");
    unavailable.cause = error;
    throw unavailable;
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || `请求失败 ${response.status}`);
    error.details = value.details;
    throw error;
  }
  return value;
}

function markServiceDisconnected() {
  renderEngineCompatible = false;
  setConnection("后台服务已断开", "error");
  setSaveStatus("后台服务已断开，请重新启动工作台", true);
  renderControls();
  renderCaptionControls();
  renderRenderStatus();
  renderProjectSaveButton();
}

function setConnection(text, kind = "muted") {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.className = `status status--${kind}`;
}

function setSaveStatus(text, isError = false) {
  elements.saveStatus.textContent = text;
  elements.saveStatus.classList.toggle("save-status--error", isError);
}

function formatPlayerTime(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = Math.floor(safeSeconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

async function togglePlayback() {
  try {
    if (elements.video.paused) await elements.video.play();
    else elements.video.pause();
  } catch (error) {
    setSaveStatus(`无法播放视频 ${error.message}`, true);
  }
}

function updatePlayerControls() {
  const duration = Number.isFinite(elements.video.duration) ? elements.video.duration : 0;
  const currentTime = elements.video.currentTime || 0;
  const paused = elements.video.paused;
  elements.playPauseButton.textContent = paused ? "▶" : "❚❚";
  elements.playPauseButton.setAttribute("aria-label", paused ? "播放" : "暂停");
  elements.playPauseButton.title = paused ? "播放" : "暂停";
  elements.seekSlider.max = String(duration);
  if (!seeking) elements.seekSlider.value = String(currentTime);
  elements.playerTime.textContent = `${formatPlayerTime(currentTime)} / ${formatPlayerTime(duration)}`;
}

function selectionInfo() {
  const indexes = [...selectedWords].sort((left, right) => left - right);
  if (!indexes.length) return null;
  const contiguous = indexes.every((wordIndex, index) => index === 0 || wordIndex === indexes[index - 1] + 1);
  return { indexes, start: indexes[0], end: indexes.at(-1), contiguous };
}

function wordRangeForEntity(entity) {
  const directStart = Number(entity?.start_word_index);
  const directEnd = Number(entity?.end_word_index);
  if (Number.isInteger(directStart) && Number.isInteger(directEnd)) {
    return { start: directStart, end: directEnd };
  }
  const itemRanges = (entity?.items || [])
    .map((item) => wordRangeForEntity(item))
    .filter(Boolean);
  if (itemRanges.length) {
    return {
      start: Math.min(...itemRanges.map((range) => range.start)),
      end: Math.max(...itemRanges.map((range) => range.end)),
    };
  }
  const startTime = Number(entity?.start);
  const endTime = Number(entity?.end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  const indexes = (state?.words || [])
    .filter((word) => Number(word.end) > startTime && Number(word.start) < endTime)
    .map((word) => word.wordIndex);
  return indexes.length ? { start: indexes[0], end: indexes.at(-1) } : null;
}

function selectTranscriptWordRange(entity) {
  const range = wordRangeForEntity(entity);
  if (!range || range.start < 0 || range.end >= (state?.words?.length || 0) || range.end < range.start) {
    setSaveStatus("当前 Asset 没有可映射的逐字稿范围", true);
    return false;
  }
  selectedWords.clear();
  for (let wordIndex = range.start; wordIndex <= range.end; wordIndex += 1) {
    selectedWords.add(wordIndex);
  }
  setSaveStatus("");
  renderTranscriptClasses();
  renderControls();
  requestAnimationFrame(() => {
    elements.transcript.querySelector(`[data-word-index="${range.start}"]`)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  });
  return true;
}

function assetTypeDef(typeId) {
  return state?.catalog?.assetTypes?.find((item) => item.id === typeId) || null;
}

function effectTypeDef(typeId) {
  return state?.catalog?.effectTypes?.find((item) => item.id === typeId) || null;
}

function systemAssetId(capability) {
  const listed = state?.catalog?.systemAssets || [];
  for (const item of listed) {
    if ((assetTypeDef(item.type)?.capabilities || []).includes(capability)) return item.id;
  }
  return listed[0]?.id || null;
}

function configsEqual(left, right) {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

function wordRangeEffect(effect, wordIndex) {
  return effect.timing?.kind === "word_range"
    && wordIndex >= effect.timing.start_word_index
    && wordIndex <= effect.timing.end_word_index;
}

function effectForWord(wordIndex, assetId, typeId = null, config = null) {
  return state?.composition?.effects.find((effect) => (
    effect.target.asset_id === assetId
    && (!typeId || effect.type === typeId)
    && (!config || configsEqual(effect.config, config))
    && wordRangeEffect(effect, wordIndex)
  )) || null;
}

function structuredItemForWord(wordIndex) {
  for (const group of state?.structuredOverlayTrack?.groups || []) {
    const item = group.items.find((candidate) => (
      wordIndex >= candidate.start_word_index && wordIndex <= candidate.end_word_index
    ));
    if (item) return { group, item };
  }
  return null;
}

function imageOverlayForWord(wordIndex) {
  return state?.imageOverlayTrack?.groups?.find((overlay) => (
    wordIndex >= overlay.start_word_index && wordIndex <= overlay.end_word_index
  )) || null;
}

function selectionHasEffect(range, assetId, typeId, config) {
  if (!range?.contiguous) return false;
  for (let wordIndex = range.start; wordIndex <= range.end; wordIndex += 1) {
    if (!effectForWord(wordIndex, assetId, typeId, config)) return false;
  }
  return true;
}

function defaultEffectTargetId() {
  return state?.composition?.assets.find((asset) => (
    asset.enabled !== false
    && (assetTypeDef(asset.type)?.source_kinds || []).includes("input.video")
  ))?.id || null;
}

function effectTargetAsset() {
  const selected = state?.composition?.assets.find((asset) => asset.id === selectedEffectTargetId);
  if (selected && selected.enabled !== false) return selected;
  const fallbackId = defaultEffectTargetId();
  selectedEffectTargetId = fallbackId;
  return state?.composition?.assets.find((asset) => asset.id === fallbackId) || null;
}

function effectTargetLabel(asset = effectTargetAsset()) {
  if (!asset) return "未选择";
  const label = assetTypeDef(asset.type)?.ui?.label || asset.type || asset.id;
  if (asset.origin?.created_by === "system") return label;
  const peers = state.composition.assets.filter((candidate) => candidate.type === asset.type);
  const index = peers.findIndex((candidate) => candidate.id === asset.id);
  return peers.length > 1 && index >= 0 ? `${label} ${index + 1}` : label;
}

function effectTypeSupportsTarget(effectType, asset = effectTargetAsset()) {
  if (!asset || asset.enabled === false || !(effectType?.timing_models || []).includes("word_range")) return false;
  const capabilities = assetTypeDef(asset.type)?.capabilities || [];
  return (effectType.requires_capabilities || []).every((capability) => capabilities.includes(capability));
}

function renderEffectTarget() {
  const asset = effectTargetAsset();
  elements.effectTargetBadge.textContent = `作用于：${effectTargetLabel(asset)}`;
  elements.effectTargetBadge.title = asset ? `${effectTargetLabel(asset)} · ${asset.id}` : "当前没有可用的效果目标";
}

function selectEffectTarget(assetId) {
  const asset = state?.composition?.assets.find((candidate) => candidate.id === assetId);
  if (!asset || asset.enabled === false) return;
  selectedEffectTargetId = asset.id;
  renderEffectTarget();
  renderCaptionSelection();
  renderStructuredSelection();
  renderImageSelection();
  renderControls();
}

function renderEffectCatalog() {
  if (!elements.effectButtons || !state?.catalog) return;
  const fragment = document.createDocumentFragment();
  for (const effectType of state.catalog.effectTypes.filter((item) => (
    (item.timing_models || []).includes("word_range")
  ))) {
    const presets = effectType.ui?.presets?.length
      ? effectType.ui.presets
      : [{ id: effectType.id, label: effectType.ui?.label || effectType.id, config: {} }];
    for (const preset of presets) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `scale-button ${preset.className || ""}`.trim();
      button.dataset.selectionEffect = "";
      button.dataset.effectTypeId = effectType.id;
      button.dataset.presetId = preset.id;
      button.textContent = preset.label;
      button.addEventListener("click", () => void toggleSelectionEffect(effectType, preset, button));
      fragment.append(button);
    }
  }
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "scale-button scale-button--clear";
  clear.dataset.directEffect = "";
  clear.dataset.clearEffect = "";
  clear.textContent = "清除当前对象效果";
  clear.addEventListener("click", () => void clearSelectedEffects());
  fragment.append(clear);
  elements.effectButtons.replaceChildren(fragment);
  renderEffectTarget();
  renderControls();
}

function renderAssetCreateButtons() {
  if (!elements.assetCreateButtons || !state?.catalog) return;
  const fragment = document.createDocumentFragment();
  for (const assetType of state.catalog.assetTypes) {
    if (!assetType.ui?.create_from_selection) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "compact-button";
    button.dataset.structuredAction = "";
    button.dataset.assetTypeId = assetType.id;
    button.textContent = assetType.ui.create_label || assetType.ui.label || assetType.id;
    button.addEventListener("click", () => void createAssetFromSelection(assetType));
    fragment.append(button);
  }
  elements.assetCreateButtons.replaceChildren(fragment);
}

function renderTranscript() {
  elements.transcript.replaceChildren();
  for (const word of state.words) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "word";
    button.dataset.wordIndex = String(word.wordIndex);
    button.textContent = word.text;
    button.addEventListener("pointerdown", (event) => beginPaint(event, word.wordIndex));
    button.addEventListener("pointerenter", () => {
      if (dragging) paintWord(word.wordIndex);
    });
    elements.transcript.append(button);
  }
  renderTranscriptClasses();
}

function beginPaint(event, wordIndex) {
  if (event.button !== 0) return;
  event.preventDefault();
  const videoTargetId = defaultEffectTargetId();
  if (selectedEffectTargetId !== videoTargetId) selectedWords.clear();
  selectEffectTarget(videoTargetId);
  dragging = true;
  paintShouldSelect = !selectedWords.has(wordIndex);
  paintedDuringDrag = new Set();
  paintWord(wordIndex);
}

function paintWord(wordIndex) {
  if (paintedDuringDrag.has(wordIndex)) return;
  paintedDuringDrag.add(wordIndex);
  if (paintShouldSelect) selectedWords.add(wordIndex);
  else selectedWords.delete(wordIndex);
  setSaveStatus("");
  renderTranscriptClasses();
  renderControls();
}

function endPaint() {
  dragging = false;
  paintedDuringDrag.clear();
}

function paintFromPointer(event) {
  if (!dragging) return;
  const wordButton = event.target.closest?.(".word")
    || document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".word");
  if (wordButton?.dataset.wordIndex) paintWord(Number(wordButton.dataset.wordIndex));
}

function renderTranscriptClasses() {
  if (!state) return;
  for (const button of elements.transcript.querySelectorAll(".word")) {
    const wordIndex = Number(button.dataset.wordIndex);
    const effects = state.composition.effects.filter((effect) => wordRangeEffect(effect, wordIndex));
    const scaleEffect = effects.find((effect) => (
      (effectTypeDef(effect.type)?.writes_channels || []).includes("transform.scale")
    ));
    const textEffect = effects.find((effect) => (
      (effectTypeDef(effect.type)?.writes_channels || []).some((channel) => channel.startsWith("style."))
    ));
    const structuredItem = structuredItemForWord(wordIndex);
    const imageOverlay = imageOverlayForWord(wordIndex);
    const toScale = Number(scaleEffect?.config?.to_scale);
    button.classList.toggle("word--in", Number.isFinite(toScale) && toScale > 1);
    button.classList.toggle("word--out", Number.isFinite(toScale) && toScale < 1);
    button.classList.toggle("word--long", scaleEffect?.config?.interpolation === "linear");
    button.classList.toggle("word--caption", Boolean(textEffect));
    button.classList.toggle("word--structured", Boolean(structuredItem || imageOverlay));
    button.classList.toggle("word--selected", selectedWords.has(wordIndex));
    button.classList.toggle("word--current", wordIndex === currentWordIndex);
    button.title = [
      scaleEffect && effectTypeDef(scaleEffect.type)?.ui?.label,
      ...effects
        .filter((effect) => effect.id !== scaleEffect?.id)
        .map((effect) => effectTypeDef(effect.type)?.ui?.label),
      structuredItem && assetTypeDef(structuredItem.group.type)?.ui?.label,
      imageOverlay && "贴图",
    ].filter(Boolean).join(" + ");
  }
}

function renderControls() {
  const range = selectionInfo();
  const target = effectTargetAsset();
  for (const button of elements.effectButtons?.querySelectorAll("[data-selection-effect]") || []) {
    const effectType = effectTypeDef(button.dataset.effectTypeId);
    const preset = (effectType?.ui?.presets || []).find((item) => item.id === button.dataset.presetId)
      || { config: {} };
    const supported = effectTypeSupportsTarget(effectType, target);
    const selected = selectionHasEffect(range, target?.id, button.dataset.effectTypeId, preset.config);
    button.disabled = !range?.contiguous || !supported || savingEffect;
    button.title = supported
      ? `${button.textContent} · 作用于${effectTargetLabel(target)}`
      : `${effectTargetLabel(target)}不支持${effectType?.ui?.label || button.textContent}`;
    button.setAttribute("aria-pressed", String(selected));
  }
  for (const button of elements.effectButtons?.querySelectorAll("[data-direct-effect]") || []) {
    const hasSupportedEffect = (state?.catalog?.effectTypes || []).some((effectType) => (
      effectTypeSupportsTarget(effectType, target)
    ));
    button.disabled = selectedWords.size === 0 || !hasSupportedEffect || savingEffect;
    button.title = `清除${effectTargetLabel(target)}在当前范围内的效果`;
  }
  for (const button of elements.assetCreateButtons?.querySelectorAll("[data-structured-action]") || []) {
    button.disabled = !range?.contiguous || savingOverlays;
  }
  renderFontControls();
}

function renderProject() {
  elements.videoFrame.style.aspectRatio = `${state.project.displayWidth} / ${state.project.displayHeight}`;
  elements.previewCanvas.width = state.project.displayWidth;
  elements.previewCanvas.height = state.project.displayHeight;
  requestAnimationFrame(fitVideoFrame);
}

function fitVideoFrame() {
  if (!state) return;
  const availableWidth = elements.previewPanel.clientWidth;
  const availableHeight = Math.max(
    0,
    elements.previewPanel.clientHeight - elements.playerControls.offsetHeight - 12,
  );
  if (!availableWidth || !availableHeight) return;
  const ratio = state.project.displayWidth / state.project.displayHeight;
  let frameWidth = availableWidth;
  let frameHeight = frameWidth / ratio;
  if (frameHeight > availableHeight) {
    frameHeight = availableHeight;
    frameWidth = frameHeight * ratio;
  }
  elements.videoFrame.style.width = `${Math.max(1, Math.floor(frameWidth))}px`;
  elements.videoFrame.style.height = `${Math.max(1, Math.floor(frameHeight))}px`;
}

function renderCaptionControls() {
  const track = state?.captionTrack;
  const enabled = Boolean(track?.enabled);
  const unavailable = savingCaptions || !renderEngineCompatible || !track;
  elements.subtitleToggleButton.disabled = unavailable;
  elements.subtitleToggleButton.textContent = enabled ? "撤下" : "启用";
  elements.subtitleToggleButton.classList.toggle("subtitle-toggle--enabled", enabled);
  elements.subtitleToggleButton.setAttribute("aria-pressed", String(enabled));
}

function captionSourceCueId(caption) {
  return caption?.source_cue_id || String(caption?.id || "").replace(/-part-\d+$/, "");
}

function captionsAsset() {
  const id = systemAssetId("text.cues");
  return state?.composition?.assets.find((asset) => asset.id === id) || null;
}

function selectCaptionText(caption) {
  const cueId = captionSourceCueId(caption);
  if (!cueId) return;
  selectedTextTarget = { kind: "caption", cueId };
  structuredBoxSelected = false;
  structuredSelectedItemId = null;
  imageBoxSelected = false;
  selectEffectTarget(captionsAsset()?.id);
  selectTranscriptWordRange(caption);
  renderStructuredSelection();
  renderImageSelection();
  renderFontControls();
}

function selectStructuredText(groupId, selectionEntity = null) {
  if (!groupId) return;
  selectedTextTarget = { kind: "overlay", groupId };
  captionBoxSelected = false;
  imageBoxSelected = false;
  selectEffectTarget(groupId);
  selectTranscriptWordRange(selectionEntity || structuredGroupById(groupId));
  renderCaptionSelection();
  renderImageSelection();
  renderFontControls();
}

function clearSelectedTextTarget(kind = null) {
  if (!selectedTextTarget || (kind && selectedTextTarget.kind !== kind)) return;
  selectedTextTarget = null;
  renderFontControls();
}

function selectedTextFont() {
  if (selectedTextTarget?.kind === "caption") {
    return captionsAsset()?.props?.cue_overrides?.[selectedTextTarget.cueId]?.font_family
      || state?.captionTrack?.style?.font_family
      || "Microsoft YaHei";
  }
  if (selectedTextTarget?.kind === "overlay") {
    return structuredGroupById(selectedTextTarget.groupId)?.style?.font_family || "Microsoft YaHei";
  }
  return "Microsoft YaHei";
}

function selectedTextLabel() {
  if (selectedTextTarget?.kind === "caption") {
    const number = Number(String(selectedTextTarget.cueId).match(/\d+/)?.[0]);
    return Number.isFinite(number) ? `字幕 ${number}` : "当前字幕";
  }
  if (selectedTextTarget?.kind === "overlay") {
    const groups = state?.structuredOverlayTrack?.groups || [];
    const index = groups.findIndex((group) => group.id === selectedTextTarget.groupId);
    const group = groups[index];
    if (!group) return "点击画面文字";
    return `${assetTypeDef(group.type)?.ui?.label || "文字"} ${index + 1}`;
  }
  return "点击画面文字";
}

function renderFontControls() {
  const hasTarget = Boolean(selectedTextTarget);
  elements.fontTargetLabel.textContent = selectedTextLabel();
  elements.fontFamilySelect.value = selectedTextFont();
  elements.fontFamilySelect.disabled = !hasTarget
    || !renderEngineCompatible
    || savingCaptions
    || savingOverlays;
}

async function saveCaptionFont(cueId, fontFamily) {
  if (!renderEngineCompatible || savingCaptions) return;
  const asset = captionsAsset();
  if (!asset) return;
  try {
    savingCaptions = true;
    renderControls();
    setSaveStatus("正在保存当前字幕字体");
    await requestJson(`/api/assets/${encodeURIComponent(asset.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        props: {
          cue_overrides: {
            ...(asset.props.cue_overrides || {}),
            [cueId]: {
              ...(asset.props.cue_overrides?.[cueId] || {}),
              font_family: fontFamily,
            },
          },
        },
      }),
    });
    await loadState();
    setSaveStatus("当前字幕字体已保存并热重载");
  } catch (error) {
    setSaveStatus(error.message, true);
  } finally {
    savingCaptions = false;
    renderControls();
  }
}

function saveSelectedFont(fontFamily) {
  if (selectedTextTarget?.kind === "caption") {
    void saveCaptionFont(selectedTextTarget.cueId, fontFamily);
    return;
  }
  if (selectedTextTarget?.kind === "overlay") {
    void patchAsset(selectedTextTarget.groupId, {
      props: {
        style: {
          ...structuredGroupById(selectedTextTarget.groupId)?.style,
          font_family: fontFamily,
        },
      },
    }, `${assetTypeDef(structuredGroupById(selectedTextTarget.groupId)?.type)?.ui?.label || "文字"}字体已保存并热重载`);
  }
}

async function patchAsset(assetId, patch, successMessage) {
  if (!renderEngineCompatible || savingOverlays) return;
  try {
    savingOverlays = true;
    renderControls();
    setSaveStatus("正在保存覆盖层");
    await requestJson(`/api/assets/${encodeURIComponent(assetId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    await loadState();
    setSaveStatus(successMessage || "覆盖层已保存并热重载");
  } catch (error) {
    setSaveStatus(`${error.message}${error.details ? `　${JSON.stringify(error.details)}` : ""}`, true);
  } finally {
    savingOverlays = false;
    renderControls();
    renderStructuredEditor();
  }
}

function compositionAsset(assetId) {
  return state?.composition?.assets.find((asset) => asset.id === assetId) || null;
}

function itemInput(item, overrides = {}) {
  return {
    id: item.id,
    start_word_index: item.start_word_index,
    end_word_index: item.end_word_index,
    display_text: item.display_text,
    ...(item.box ? { box: { ...item.box } } : {}),
    ...overrides,
  };
}

function schemaProperty(assetType, ...path) {
  let value = assetType?.instance_schema;
  for (const key of path) value = value?.[key];
  return value || {};
}

function itemSchema(assetType) {
  return schemaProperty(assetType, "properties", "items");
}

function displayTextSchema(assetType) {
  return itemSchema(assetType)?.items?.properties?.display_text || {};
}

async function createAssetFromSelection(assetType) {
  const range = selectionInfo();
  if (!range?.contiguous) {
    setSaveStatus("请先选择一段连续逐字稿", true);
    return;
  }
  const displayText = state.words.slice(range.start, range.end + 1).map((word) => word.text).join("");
  const textSchema = displayTextSchema(assetType);
  if (textSchema.minLength !== undefined || textSchema.maxLength !== undefined) {
    const count = Array.from(displayText.replace(/\s/g, "")).length;
    if (
      (textSchema.minLength !== undefined && count < textSchema.minLength)
      || (textSchema.maxLength !== undefined && count > textSchema.maxLength)
    ) {
      setSaveStatus(`${assetType.ui?.label || "文案"}长度必须在 ${textSchema.minLength ?? 0} 到 ${textSchema.maxLength ?? "不限"} 个字符`, true);
      return;
    }
  }
  const props = {};
  const lifecycle = { kind: "word_range", start_word_index: range.start, end_word_index: range.end };
  if ((assetType.capabilities || []).includes("ordered-items")) {
    props.items = [{ start_word_index: range.start, end_word_index: range.end, display_text: displayText }];
    if ((assetType.capabilities || []).includes("layout.items")) props.layout = "auto";
  }
  if ((assetType.capabilities || []).includes("media.image")) {
    const imagePath = window.prompt("请输入本地图片的完整路径，支持 PNG、JPG、JPEG、WebP、BMP");
    if (!imagePath?.trim()) return;
    props.image_path = imagePath.trim();
    props.fit = "contain";
    props.box = { ...(assetType.defaults?.props?.box || { x: 0.58, y: 0.08, width: 0.34, height: 0.28, unit: "ratio" }) };
  }
  try {
    savingOverlays = true;
    renderControls();
    setSaveStatus(`正在创建${assetType.ui?.label || "覆盖层"}`);
    await requestJson("/api/assets", {
      method: "POST",
      body: JSON.stringify({
        type: assetType.id,
        enabled: true,
        source: { kind: "agent-generated" },
        lifecycle,
        props: { ...(assetType.defaults?.props || {}), ...props },
      }),
    });
    await loadState();
    setSaveStatus(`${assetType.ui?.label || "覆盖层"}已创建`);
  } catch (error) {
    setSaveStatus(`${error.message}${error.details ? `　${JSON.stringify(error.details)}` : ""}`, true);
  } finally {
    savingOverlays = false;
    renderControls();
    renderStructuredEditor();
  }
}

function compactButton(label, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `compact-button ${className || ""}`.trim();
  button.textContent = label;
  button.dataset.structuredAction = "";
  button.disabled = savingOverlays;
  button.addEventListener("click", action);
  return button;
}

function compactSelect(value, options, label, action) {
  const select = document.createElement("select");
  select.className = "structured-select";
  select.dataset.structuredAction = "";
  select.setAttribute("aria-label", label);
  select.disabled = savingOverlays;
  for (const optionInput of options) {
    const option = document.createElement("option");
    option.value = optionInput.value;
    option.textContent = optionInput.label;
    option.selected = option.value === value;
    select.append(option);
  }
  select.addEventListener("change", () => action(select.value));
  return select;
}

function selectStructuredItem(item) {
  selectedWords.clear();
  for (let index = item.start_word_index; index <= item.end_word_index; index += 1) {
    selectedWords.add(index);
  }
  const range = selectionInfo();
  renderTranscriptClasses();
  renderControls();
  previewSelectionRange(range);
}

function popEffectType() {
  return state?.catalog?.effectTypes?.find((item) => (
    (item.writes_channels || []).includes("transform.scale.entry")
  )) || null;
}

function assetHasPop(assetId) {
  const type = popEffectType();
  return Boolean(type && state.composition.effects.some((effect) => (
    effect.target.asset_id === assetId && effect.type === type.id
  )));
}

async function setAssetPop(assetId, enabled) {
  const type = popEffectType();
  if (!type) return;
  const existing = state.composition.effects.find((effect) => (
    effect.target.asset_id === assetId && effect.type === type.id
  ));
  if (enabled && existing) return;
  if (!enabled && !existing) return;
  if (enabled) {
    await requestJson("/api/effects", {
      method: "POST",
      body: JSON.stringify({
        type: type.id,
        target: { asset_id: assetId },
        timing: { kind: "item_enter" },
        config: {},
      }),
    });
  } else {
    await requestJson(`/api/effects/${encodeURIComponent(existing.id)}`, { method: "DELETE" });
  }
}

function renderStructuredEditor() {
  elements.structuredEditor.replaceChildren();
  const groups = state?.structuredOverlayTrack?.groups || [];
  const imageGroups = state?.imageOverlayTrack?.groups || [];
  if (!groups.length && !imageGroups.length) {
    const empty = document.createElement("p");
    empty.className = "structured-editor__empty";
    empty.textContent = "当前没有覆盖层，选择连续文字后新建清单、关键词或贴图";
    elements.structuredEditor.append(empty);
    return;
  }

  groups.forEach((group, groupIndex) => {
    const isItems = group.layout_mode === "items";
    const kindLabel = assetTypeDef(group.type)?.ui?.label || "文字";
    const asset = compositionAsset(group.id);
    const section = document.createElement("section");
    section.className = "structured-group";
    const heading = document.createElement("div");
    heading.className = "structured-group__heading";
    const title = document.createElement("span");
    title.className = "structured-group__title";
    title.textContent = `${kindLabel} ${groupIndex + 1}`;
    const headingActions = document.createElement("div");
    headingActions.className = "structured-group__actions";
    headingActions.append(
      compactButton(group.enabled ? "撤下" : "启用", "", () => {
        void patchAsset(group.id, { enabled: !group.enabled }, group.enabled ? `${kindLabel}已撤下` : `${kindLabel}已启用`);
      }),
      compactButton("删除", "compact-button--danger", () => {
        if (!window.confirm(`确认删除整组${kindLabel}吗`)) return;
        void (async () => {
          await requestJson(`/api/assets/${encodeURIComponent(group.id)}`, { method: "DELETE" });
          await loadState();
          setSaveStatus(`${kindLabel}已删除`);
        })();
      }),
    );
    heading.append(title, headingActions);
    section.append(heading);

    const settings = document.createElement("div");
    settings.className = "structured-group__settings";
    settings.append(compactSelect(
      assetHasPop(group.id) ? "pop" : "none",
      [
        { value: "none", label: "直接出现" },
        { value: "pop", label: "轻微弹出" },
      ],
      `${kindLabel}入场动画`,
      (value) => {
        void (async () => {
          await setAssetPop(group.id, value === "pop");
          await loadState();
          setSaveStatus(`${kindLabel}动画已保存`);
        })();
      },
    ));
    if (isItems) {
      const autoLayoutButton = compactButton("恢复自动布局", "", () => {
        void patchAsset(group.id, { props: { layout: "auto" } }, "关键词已恢复自动布局");
      });
      autoLayoutButton.disabled = savingOverlays || group.layout === "auto";
      settings.append(autoLayoutButton);
    }
    section.append(settings);

    group.items.forEach((item, itemIndex) => {
      const groupAssetType = assetTypeDef(group.type);
      const textSchema = displayTextSchema(groupAssetType);
      const row = document.createElement("div");
      row.className = "structured-item-editor";
      row.append(compactButton(String(itemIndex + 1), "compact-button--index", () => selectStructuredItem(item)));
      const input = document.createElement("input");
      input.type = "text";
      input.value = item.display_text;
      input.minLength = textSchema.minLength ?? 1;
      input.maxLength = textSchema.maxLength ?? 120;
      input.dataset.structuredAction = "";
      input.addEventListener("change", () => {
        if (input.value.trim() === item.display_text) return;
        const items = (asset?.props.items || group.items).map((entry) => itemInput(entry, entry.id === item.id
          ? { display_text: input.value.trim() }
          : {}));
        void patchAsset(group.id, { props: { items } }, `${kindLabel}文案已保存`);
      });
      row.append(input);
      row.append(compactButton("替换", "", () => {
        const range = selectionInfo();
        if (!range?.contiguous) {
          setSaveStatus("请先选择一段连续逐字稿", true);
          return;
        }
        const items = (asset?.props.items || group.items).map((entry) => itemInput(entry, entry.id === item.id
          ? { start_word_index: range.start, end_word_index: range.end }
          : {}));
        void patchAsset(group.id, {
          props: { items },
          lifecycle: {
            kind: "word_range",
            start_word_index: Math.min(...items.map((entry) => entry.start_word_index)),
            end_word_index: Math.max(...items.map((entry) => entry.end_word_index)),
          },
        }, `${kindLabel}条目范围已替换`);
      }));
      row.append(compactButton("×", "compact-button--danger", () => {
        if (!window.confirm(`确认删除这个${kindLabel}条目吗`)) return;
        if (group.items.length === 1) {
          void requestJson(`/api/assets/${encodeURIComponent(group.id)}`, { method: "DELETE" })
            .then(() => loadState())
            .then(() => setSaveStatus(`${kindLabel}条目已删除`));
          return;
        }
        const items = (asset?.props.items || group.items)
          .filter((entry) => entry.id !== item.id)
          .map((entry) => itemInput(entry));
        void patchAsset(group.id, { props: { items } }, `${kindLabel}条目已删除`);
      }));
      section.append(row);
    });

    const appendButton = compactButton("追加当前选择", "", () => {
      const range = selectionInfo();
      if (!range?.contiguous) {
        setSaveStatus("请先选择一段连续逐字稿", true);
        return;
      }
      const displayText = state.words.slice(range.start, range.end + 1).map((word) => word.text).join("");
      const groupAssetType = assetTypeDef(group.type);
      const textSchema = displayTextSchema(groupAssetType);
      const displayLength = Array.from(displayText.replace(/\s/g, "")).length;
      if (
        (textSchema.minLength !== undefined && displayLength < textSchema.minLength)
        || (textSchema.maxLength !== undefined && displayLength > textSchema.maxLength)
      ) {
        setSaveStatus(`${kindLabel}文案长度必须在 ${textSchema.minLength ?? 0} 到 ${textSchema.maxLength ?? "不限"} 个字符`, true);
        return;
      }
      const items = [
        ...(asset?.props.items || group.items).map((entry) => itemInput(entry)),
        { start_word_index: range.start, end_word_index: range.end, display_text: displayText },
      ];
      void patchAsset(group.id, {
        props: { items },
        lifecycle: {
          kind: "word_range",
          start_word_index: items[0].start_word_index,
          end_word_index: items.at(-1).end_word_index,
        },
      }, `${kindLabel}条目已追加`);
    });
    const maxItems = itemSchema(assetTypeDef(group.type)).maxItems ?? Number.POSITIVE_INFINITY;
    appendButton.disabled = savingOverlays || group.items.length >= maxItems;
    section.append(appendButton);
    elements.structuredEditor.append(section);
  });

  imageGroups.forEach((overlay, imageIndex) => {
    const section = document.createElement("section");
    section.className = "structured-group";
    const heading = document.createElement("div");
    heading.className = "structured-group__heading";
    const title = document.createElement("span");
    title.className = "structured-group__title";
    title.textContent = `贴图 ${imageIndex + 1}`;
    const headingActions = document.createElement("div");
    headingActions.className = "structured-group__actions";
    headingActions.append(
      compactButton(overlay.enabled ? "撤下" : "启用", "", () => {
        void patchAsset(overlay.id, { enabled: !overlay.enabled }, overlay.enabled ? "贴图已撤下" : "贴图已启用");
      }),
      compactButton("删除", "compact-button--danger", () => {
        if (!window.confirm("确认删除这张贴图吗")) return;
        void requestJson(`/api/assets/${encodeURIComponent(overlay.id)}`, { method: "DELETE" })
          .then(() => loadState())
          .then(() => setSaveStatus("贴图已删除"));
      }),
    );
    heading.append(title, headingActions);
    section.append(heading);
    const row = document.createElement("div");
    row.className = "structured-item-editor";
    row.append(compactButton("定位", "compact-button--index", () => selectStructuredItem(overlay)));
    const input = document.createElement("input");
    input.type = "text";
    input.value = overlay.image_path;
    input.dataset.structuredAction = "";
    input.addEventListener("change", () => {
      if (!input.value.trim() || input.value.trim() === overlay.image_path) return;
      void patchAsset(overlay.id, { props: { image_path: input.value.trim() } }, "贴图路径已保存");
    });
    row.append(input);
    row.append(compactButton("替换范围", "", () => {
      const range = selectionInfo();
      if (!range?.contiguous) {
        setSaveStatus("请先选择一段连续逐字稿", true);
        return;
      }
      void patchAsset(overlay.id, {
        lifecycle: { kind: "word_range", start_word_index: range.start, end_word_index: range.end },
      }, "贴图出现范围已替换");
    }));
    section.append(row);
    elements.structuredEditor.append(section);
  });
}

function renderRenderStatus() {
  const status = state.renderStatus || { state: "idle" };
  const running = status.state === "running";
  const lockOk = state.profileLock?.ok !== false;
  elements.renderButton.disabled = running || !renderEngineCompatible || !lockOk;
  elements.renderButton.textContent = running
    ? `生成中 ${status.progress || 0}%`
    : !renderEngineCompatible
      ? "导出服务需重启"
      : !lockOk
        ? "Profile 需同步"
        : "确认并生成成片";
}

function renderProjectSaveButton(label = null) {
  elements.saveProjectButton.disabled = savingProject || !renderEngineCompatible;
  elements.saveProjectButton.textContent = label || (savingProject ? "保存中" : "保存工程");
}

function applyRestoredPlaybackPosition() {
  if (pendingRestoreTime === null || elements.video.readyState < 1) return;
  const duration = Number.isFinite(elements.video.duration) ? elements.video.duration : state?.project?.duration || 0;
  elements.video.currentTime = Math.max(0, Math.min(pendingRestoreTime, duration));
  elements.seekSlider.value = String(elements.video.currentTime);
  pendingRestoreTime = null;
  updatePlayerControls();
}

async function loadState(options = {}) {
  try {
    const nextState = await requestJson("/api/state");
    const firstLoad = !state;
    state = nextState;
    if (!state.composition.assets.some((asset) => asset.id === selectedEffectTargetId && asset.enabled !== false)) {
      selectedEffectTargetId = defaultEffectTargetId();
    }
    renderEngineCompatible = state.renderEngineVersion === requiredRenderEngineVersion
      && Boolean(state.playbackScene)
      && Array.isArray(state.playbackEffects)
      && Array.isArray(state.playbackCaptions)
      && Array.isArray(state.playbackOverlays)
      && Array.isArray(state.playbackImageOverlays)
      && Boolean(state.captionTrack)
      && Boolean(state.structuredOverlayTrack)
      && Boolean(state.imageOverlayTrack)
      && Boolean(state.composition)
      && Boolean(state.catalog);
    playbackEffects = renderEngineCompatible ? state.playbackEffects : [];
    playbackCaptions = renderEngineCompatible ? state.playbackCaptions : [];
    playbackOverlays = renderEngineCompatible ? state.playbackOverlays : [];
    playbackImageOverlays = renderEngineCompatible ? state.playbackImageOverlays : [];
    elements.structuredOverlay.dataset.activeState = "";
    if (firstLoad) {
      selectedWords.clear();
      for (const wordIndex of state.editorState?.selectedWordIndexes || []) selectedWords.add(wordIndex);
      pendingRestoreTime = Number(state.editorState?.currentTime || 0);
      renderTranscript();
    } else renderTranscriptClasses();
    renderProject();
    applyRestoredPlaybackPosition();
    renderEffectCatalog();
    renderAssetCreateButtons();
    renderCaptionControls();
    renderStructuredEditor();
    renderControls();
    renderRenderStatus();
    renderProjectSaveButton();
    if (state.profileLock?.ok === false) {
      setConnection("Profile 已变化", "error");
      setSaveStatus(`Profile 与 lock 不一致，预览可用，导出前请运行 profile sync。${(state.profileLock.changes || []).join("；")}`, true);
    } else if (renderEngineCompatible) {
      setConnection(options.external ? "已热重载" : "已连接", "ok");
    } else {
      setConnection("导出服务需重启", "error");
      setSaveStatus("网页与导出引擎版本不一致，请重启服务后再导出", true);
    }
  } catch (error) {
    markServiceDisconnected();
  }
}

async function saveProject() {
  if (!renderEngineCompatible || savingProject) return;
  try {
    savingProject = true;
    clearTimeout(saveButtonResetTimer);
    renderProjectSaveButton();
    const saved = await requestJson("/api/save-project", {
      method: "POST",
      body: JSON.stringify({
        currentTime: elements.video.currentTime || 0,
        selectedWordIndexes: [...selectedWords].sort((left, right) => left - right),
      }),
    });
    state.editorState = saved.editorState;
    setSaveStatus("工程已保存，下次启动会恢复当前进度");
    renderProjectSaveButton("已保存");
    saveButtonResetTimer = setTimeout(() => renderProjectSaveButton(), 1600);
  } catch (error) {
    setSaveStatus(error.message, true);
    renderProjectSaveButton("保存失败");
    if (error.message.includes("后台服务已断开")) markServiceDisconnected();
    saveButtonResetTimer = setTimeout(() => renderProjectSaveButton(), 2000);
  } finally {
    savingProject = false;
    elements.saveProjectButton.disabled = !renderEngineCompatible;
  }
}

async function setCaptionsEnabled(enabled) {
  const asset = captionsAsset();
  if (!renderEngineCompatible || savingCaptions || !asset) return;
  if (Boolean(state.captionTrack.enabled) === enabled) return;
  try {
    savingCaptions = true;
    renderCaptionControls();
    setSaveStatus(enabled ? "正在启用字幕" : "正在关闭字幕");
    await requestJson(`/api/assets/${encodeURIComponent(asset.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
    await loadState();
    setSaveStatus(enabled ? "字幕已启用并热重载" : "字幕已关闭并热重载");
  } catch (error) {
    setSaveStatus(error.message, true);
  } finally {
    savingCaptions = false;
    renderCaptionControls();
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundedRatio(value) {
  return Number(Number(value).toFixed(6));
}

function normalizedCaptionBox(box) {
  return {
    x: roundedRatio(box.x),
    y: roundedRatio(box.y),
    width: roundedRatio(box.width),
    height: roundedRatio(box.height),
    unit: "ratio",
  };
}

function captionBoxesEqual(left, right) {
  return ["x", "y", "width", "height"].every((key) => (
    Math.abs(Number(left?.[key]) - Number(right?.[key])) < 0.000001
  ));
}

function setCaptionBoxInState(box) {
  if (!state?.captionTrack) return;
  const normalized = normalizedCaptionBox(box);
  state.captionTrack.box = normalized;
  const asset = captionsAsset();
  if (asset) asset.props.box = { ...normalized };
}

function normalizedCaptionFontSizeRatio(value) {
  return Number(clamp(Number(value) || 0.015, 0.015, 0.15).toFixed(6));
}

function setCaptionFontSizeInState(cueId, fontSizeRatio) {
  const normalized = normalizedCaptionFontSizeRatio(fontSizeRatio);
  const asset = captionsAsset();
  if (asset) {
    asset.props.cue_overrides = {
      ...(asset.props.cue_overrides || {}),
      [cueId]: {
        ...(asset.props.cue_overrides?.[cueId] || {}),
        font_size_ratio: normalized,
      },
    };
  }
  for (const caption of playbackCaptions) {
    if (captionSourceCueId(caption) !== cueId) continue;
    caption.font_size_ratio = normalized;
  }
  return normalized;
}

function renderCaptionSelection() {
  const selectedForEffects = selectedEffectTargetId === captionsAsset()?.id;
  const selected = captionBoxSelected || selectedForEffects;
  elements.subtitleOverlay.classList.toggle("subtitle-overlay--selected", selected);
  elements.subtitleOverlay.classList.toggle("subtitle-overlay--dragging", Boolean(captionInteraction));
  elements.subtitleOverlay.setAttribute("aria-pressed", String(selected));
}

async function saveCaptionBox(box, previousBox) {
  const asset = captionsAsset();
  if (!renderEngineCompatible || savingCaptions || !asset) return;
  try {
    savingCaptions = true;
    renderCaptionControls();
    setSaveStatus("正在保存字幕区块");
    await requestJson(`/api/assets/${encodeURIComponent(asset.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ props: { box } }),
    });
    await loadState();
    setSaveStatus("字幕区块已保存并热重载");
  } catch (error) {
    setCaptionBoxInState(previousBox);
    setSaveStatus(error.message, true);
  } finally {
    savingCaptions = false;
    renderCaptionControls();
  }
}

async function saveCaptionFontSize(cueId, fontSizeRatio, previousFontSizeRatio) {
  const asset = captionsAsset();
  if (!renderEngineCompatible || savingCaptions || !asset) return;
  try {
    savingCaptions = true;
    renderCaptionControls();
    setSaveStatus("正在保存当前字幕字号");
    await requestJson(`/api/assets/${encodeURIComponent(asset.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        props: {
          cue_overrides: {
            ...(asset.props.cue_overrides || {}),
            [cueId]: {
              ...(asset.props.cue_overrides?.[cueId] || {}),
              font_size_ratio: fontSizeRatio,
            },
          },
        },
      }),
    });
    await loadState();
    setSaveStatus("当前字幕字号已保存并热重载");
  } catch (error) {
    setCaptionFontSizeInState(cueId, previousFontSizeRatio);
    setSaveStatus(error.message, true);
  } finally {
    savingCaptions = false;
    renderCaptionControls();
  }
}

function beginCaptionInteraction(event) {
  if (event.button !== 0 || !state?.captionTrack?.enabled || savingCaptions) return;
  const caption = currentCaptionAt(elements.video.currentTime || 0);
  if (!caption) return;
  const stageRect = elements.videoStage.getBoundingClientRect();
  if (!stageRect.width || !stageRect.height) return;
  event.preventDefault();
  event.stopPropagation();
  captionBoxSelected = true;
  selectCaptionText(caption);
  const startBox = normalizedCaptionBox(state.captionTrack.box);
  const cueId = captionSourceCueId(caption);
  const startFontSizeRatio = normalizedCaptionFontSizeRatio(
    caption.font_size_ratio || state.captionTrack.style.font_size_ratio,
  );
  const resizingFont = Boolean(event.target.closest(".subtitle-resize-handle"));
  captionInteraction = {
    pointerId: event.pointerId,
    mode: resizingFont ? "font-resize" : "move",
    cueId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    stageRect,
    startBox,
    currentBox: startBox,
    startFontSizeRatio,
    currentFontSizeRatio: startFontSizeRatio,
    moved: false,
    wasPlaying: !elements.video.paused,
  };
  elements.video.pause();
  elements.subtitleOverlay.setPointerCapture?.(event.pointerId);
  renderCaptionSelection();
}

function updateCaptionInteraction(event) {
  const interaction = captionInteraction;
  if (!interaction || event.pointerId !== interaction.pointerId) return;
  event.preventDefault();
  const deltaX = (event.clientX - interaction.startClientX) / interaction.stageRect.width;
  const deltaY = (event.clientY - interaction.startClientY) / interaction.stageRect.height;
  if (interaction.mode === "font-resize") {
    const minDimension = Math.min(interaction.stageRect.width, interaction.stageRect.height);
    const fontDelta = (event.clientY - interaction.startClientY) / minDimension;
    interaction.currentFontSizeRatio = setCaptionFontSizeInState(
      interaction.cueId,
      interaction.startFontSizeRatio + fontDelta,
    );
    interaction.moved = Math.abs(interaction.currentFontSizeRatio - interaction.startFontSizeRatio) > 0.000001;
    return;
  }
  const start = interaction.startBox;
  const next = {
    ...start,
    x: clamp(start.x + deltaX, 0, 1 - start.width),
    y: clamp(start.y + deltaY, 0, 1 - start.height),
  };
  interaction.currentBox = normalizedCaptionBox(next);
  interaction.moved = !captionBoxesEqual(interaction.startBox, interaction.currentBox);
  setCaptionBoxInState(interaction.currentBox);
}

function resumeCaptionPlayback(interaction) {
  if (interaction?.wasPlaying) elements.video.play().catch(() => {});
}

function finishCaptionInteraction(event, cancelled = false) {
  const interaction = captionInteraction;
  if (!interaction || (event && event.pointerId !== interaction.pointerId)) return;
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  captionInteraction = null;
  if (elements.subtitleOverlay.hasPointerCapture?.(interaction.pointerId)) {
    elements.subtitleOverlay.releasePointerCapture(interaction.pointerId);
  }
  if (cancelled) {
    if (interaction.mode === "font-resize") setCaptionFontSizeInState(interaction.cueId, interaction.startFontSizeRatio);
    else setCaptionBoxInState(interaction.startBox);
  } else if (interaction.moved) {
    if (interaction.mode === "font-resize") {
      void saveCaptionFontSize(interaction.cueId, interaction.currentFontSizeRatio, interaction.startFontSizeRatio);
    } else {
      void saveCaptionBox(interaction.currentBox, interaction.startBox);
    }
  }
  renderCaptionSelection();
  resumeCaptionPlayback(interaction);
}

function imageOverlayById(overlayId) {
  return state?.imageOverlayTrack?.groups?.find((overlay) => overlay.id === overlayId) || null;
}

function setImageBoxInState(overlayId, box) {
  const normalized = normalizedCaptionBox(box);
  const update = (overlay) => {
    if (overlay?.id === overlayId) overlay.box = { ...normalized };
  };
  for (const overlay of state?.imageOverlayTrack?.groups || []) update(overlay);
  const asset = compositionAsset(overlayId);
  if (asset) asset.props.box = { ...normalized };
  for (const overlay of playbackImageOverlays) update(overlay);
  return normalized;
}

function renderImageSelection() {
  const selectedForEffects = selectedEffectTargetId === elements.imageOverlay.dataset.overlayId;
  const selected = imageBoxSelected || selectedForEffects;
  elements.imageOverlay.classList.toggle("image-overlay--selected", selected);
  elements.imageOverlay.classList.toggle("image-overlay--dragging", Boolean(imageInteraction));
  elements.imageOverlay.setAttribute("aria-pressed", String(selected));
}

function saveImageBox(overlayId, box) {
  void patchAsset(overlayId, { props: { box } }, "贴图位置和尺寸已保存并热重载");
}

function beginImageInteraction(event) {
  const active = currentImageOverlayAt(elements.video.currentTime || 0);
  const overlay = active ? imageOverlayById(active.id) : null;
  if (event.button !== 0 || !overlay?.enabled || savingOverlays) return;
  const stageRect = elements.videoStage.getBoundingClientRect();
  if (!stageRect.width || !stageRect.height) return;
  event.preventDefault();
  event.stopPropagation();
  imageBoxSelected = true;
  captionBoxSelected = false;
  structuredBoxSelected = false;
  structuredSelectedItemId = null;
  clearSelectedTextTarget();
  selectEffectTarget(overlay.id);
  selectTranscriptWordRange(overlay);
  const startBox = normalizedCaptionBox(overlay.box);
  imageInteraction = {
    pointerId: event.pointerId,
    overlayId: overlay.id,
    mode: event.target.closest(".image-resize-handle") ? "resize" : "move",
    startClientX: event.clientX,
    startClientY: event.clientY,
    stageRect,
    startBox,
    currentBox: startBox,
    moved: false,
    wasPlaying: !elements.video.paused,
  };
  elements.video.pause();
  elements.imageOverlay.setPointerCapture?.(event.pointerId);
  renderCaptionSelection();
  renderStructuredSelection();
  renderImageSelection();
}

function updateImageInteraction(event) {
  const interaction = imageInteraction;
  if (!interaction || event.pointerId !== interaction.pointerId) return;
  event.preventDefault();
  const deltaX = (event.clientX - interaction.startClientX) / interaction.stageRect.width;
  const deltaY = (event.clientY - interaction.startClientY) / interaction.stageRect.height;
  const start = interaction.startBox;
  const next = interaction.mode === "resize"
    ? {
      ...start,
      width: clamp(start.width + deltaX, 0.05, 1 - start.x),
      height: clamp(start.height + deltaY, 0.05, 1 - start.y),
    }
    : {
      ...start,
      x: clamp(start.x + deltaX, 0, 1 - start.width),
      y: clamp(start.y + deltaY, 0, 1 - start.height),
    };
  interaction.currentBox = setImageBoxInState(interaction.overlayId, next);
  interaction.moved = !captionBoxesEqual(interaction.startBox, interaction.currentBox);
}

function finishImageInteraction(event, cancelled = false) {
  const interaction = imageInteraction;
  if (!interaction || (event && event.pointerId !== interaction.pointerId)) return;
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  imageInteraction = null;
  if (elements.imageOverlay.hasPointerCapture?.(interaction.pointerId)) {
    elements.imageOverlay.releasePointerCapture(interaction.pointerId);
  }
  if (cancelled) setImageBoxInState(interaction.overlayId, interaction.startBox);
  else if (interaction.moved) saveImageBox(interaction.overlayId, interaction.currentBox);
  renderImageSelection();
  resumeCaptionPlayback(interaction);
}

function structuredGroupById(groupId) {
  return state?.structuredOverlayTrack?.groups?.find((group) => group.id === groupId) || null;
}

function setStructuredBoxInState(groupId, box) {
  const normalized = normalizedCaptionBox(box);
  const group = structuredGroupById(groupId);
  if (group) group.box = { ...normalized };
  const asset = compositionAsset(groupId);
  if (asset) asset.props.box = { ...normalized };
  for (const playbackState of playbackOverlays) {
    if (playbackState.overlay_id === groupId) playbackState.box = { ...normalized };
  }
}

function setStructuredItemBoxInState(groupId, itemId, box, layout = "custom") {
  const normalized = normalizedCaptionBox(box);
  const group = structuredGroupById(groupId);
  const updateItems = (items) => {
    const item = items?.find((candidate) => candidate.id === itemId);
    if (item) item.box = { ...normalized };
  };
  if (group) {
    group.layout = layout;
    updateItems(group.items);
  }
  const asset = compositionAsset(groupId);
  if (asset) {
    asset.props.layout = layout;
    updateItems(asset.props.items);
  }
  for (const playbackState of playbackOverlays) {
    if (playbackState.overlay_id === groupId) updateItems(playbackState.items);
  }
}

function normalizedStructuredFontSizeRatio(value) {
  return Number(clamp(Number(value) || 0.015, 0.015, 0.12).toFixed(6));
}

function setStructuredFontSizeInState(groupId, fontSizeRatio) {
  const normalized = normalizedStructuredFontSizeRatio(fontSizeRatio);
  const minDimension = Math.min(
    Number(state?.project?.displayWidth) || 0,
    Number(state?.project?.displayHeight) || 0,
  );
  const updateGroup = (candidate) => {
    if (!candidate || candidate.id !== groupId) return;
    candidate.style = { ...candidate.style, font_size_ratio: normalized };
    if (minDimension > 0 && "fontSize" in candidate) {
      candidate.fontSize = Math.max(12, Math.round(minDimension * normalized));
      candidate.lineHeight = Math.max(candidate.fontSize, Math.round(candidate.fontSize * 1.25));
    }
  };
  updateGroup(structuredGroupById(groupId));
  const asset = compositionAsset(groupId);
  if (asset) asset.props.style = { ...asset.props.style, font_size_ratio: normalized };
  for (const candidate of playbackOverlays) {
    if (candidate.overlay_id !== groupId) continue;
    candidate.style = { ...candidate.style, font_size_ratio: normalized };
    if (minDimension > 0) {
      candidate.fontSize = Math.max(12, Math.round(minDimension * normalized));
      candidate.lineHeight = Math.max(candidate.fontSize, Math.round(candidate.fontSize * 1.25));
    }
  }
  return normalized;
}

function resizeKeywordBoxesInState(groupId, startItemBoxes, widthScale, layout = "custom") {
  const resized = {};
  for (const [itemId, startBoxInput] of Object.entries(startItemBoxes || {})) {
    const startBox = normalizedCaptionBox(startBoxInput);
    const centerX = startBox.x + startBox.width / 2;
    const width = clamp(startBox.width * widthScale, 0.10, 1);
    const box = normalizedCaptionBox({
      ...startBox,
      x: clamp(centerX - width / 2, 0, 1 - width),
      width,
    });
    setStructuredItemBoxInState(groupId, itemId, box, layout);
    resized[itemId] = box;
  }
  return resized;
}

function renderStructuredSelection() {
  const selectedForEffects = selectedEffectTargetId === elements.structuredOverlay.dataset.overlayId;
  elements.structuredOverlay.classList.toggle(
    "structured-overlay--selected",
    structuredBoxSelected || Boolean(structuredSelectedItemId) || selectedForEffects,
  );
  elements.structuredOverlay.classList.toggle(
    "structured-overlay--dragging",
    Boolean(structuredInteraction?.target === "group"),
  );
  elements.structuredOverlay.setAttribute(
    "aria-pressed",
    String(structuredBoxSelected || Boolean(structuredSelectedItemId) || selectedForEffects),
  );
  for (const itemElement of elements.structuredList.querySelectorAll("[data-item-id]")) {
    const selected = itemElement.dataset.itemId === structuredSelectedItemId;
    itemElement.classList.toggle("structured-item--selected", selected);
    itemElement.classList.toggle(
      "structured-item--dragging",
      selected && Boolean(structuredInteraction && structuredInteraction.target !== "font"),
    );
    itemElement.classList.toggle("structured-keyword--selected", selected);
    itemElement.classList.toggle(
      "structured-keyword--dragging",
      selected && Boolean(structuredInteraction?.target === "item"),
    );
  }
}

function saveStructuredBox(groupId, box) {
  void patchAsset(groupId, { props: { box } }, "清单区块已保存并热重载");
}

function saveStructuredItemBox(groupId, itemId, box) {
  const asset = compositionAsset(groupId);
  const group = structuredGroupById(groupId);
  const items = (asset?.props.items || group.items).map((item) => itemInput(item, item.id === itemId ? { box } : {}));
  void patchAsset(groupId, { props: { layout: "custom", items } }, "关键词位置已保存并热重载");
}

function saveStructuredFontSize(groupId, fontSizeRatio, itemBoxes = null) {
  const asset = compositionAsset(groupId);
  const group = structuredGroupById(groupId);
  void patchAsset(groupId, {
    props: {
      ...(itemBoxes ? {
        layout: "custom",
        items: (asset?.props.items || group.items).map((item) => itemInput(item, {
          box: { ...(itemBoxes[item.id] || item.box) },
        })),
      } : {}),
      style: {
        ...(asset?.props.style || group.style),
        font_size_ratio: normalizedStructuredFontSizeRatio(fontSizeRatio),
      },
    },
  }, "整组字号已保存并热重载");
}

function beginStructuredInteraction(event) {
  const active = currentStructuredOverlayAt(elements.video.currentTime || 0);
  const group = active ? structuredGroupById(active.overlay_id) : null;
  if (event.button !== 0 || !group?.enabled || savingOverlays) return;
  const stageRect = elements.videoStage.getBoundingClientRect();
  if (!stageRect.width || !stageRect.height) return;
  event.preventDefault();
  event.stopPropagation();
  const itemElement = event.target.closest("[data-item-id]");
  const isItems = group.layout_mode === "items";
  if (isItems && !itemElement) return;
  const itemId = itemElement?.dataset.itemId || null;
  const item = itemId ? group.items.find((candidate) => candidate.id === itemId) : null;
  const resizingFont = Boolean(event.target.closest(".structured-item-resize-handle"));
  structuredBoxSelected = !item;
  structuredSelectedItemId = item?.id || null;
  selectStructuredText(group.id, item || group);
  const startBox = normalizedCaptionBox(item?.box || group.box);
  const startFontSizeRatio = normalizedStructuredFontSizeRatio(group.style.font_size_ratio);
  const startItemBoxes = isItems
    ? Object.fromEntries(group.items.map((candidate) => [candidate.id, normalizedCaptionBox(candidate.box)]))
    : {};
  structuredInteraction = {
    pointerId: event.pointerId,
    groupId: group.id,
    layoutMode: group.layout_mode,
    itemId,
    target: resizingFont ? "font" : item && isItems ? "item" : "group",
    mode: resizingFont ? "font-resize" : "move",
    startClientX: event.clientX,
    startClientY: event.clientY,
    stageRect,
    startBox,
    startLayout: group.layout || null,
    startFontSizeRatio,
    currentFontSizeRatio: startFontSizeRatio,
    startItemBoxes,
    currentItemBoxes: startItemBoxes,
    currentBox: startBox,
    moved: false,
    wasPlaying: !elements.video.paused,
  };
  elements.video.pause();
  elements.structuredOverlay.setPointerCapture?.(event.pointerId);
  renderStructuredSelection();
}

function updateStructuredInteraction(event) {
  const interaction = structuredInteraction;
  if (!interaction || event.pointerId !== interaction.pointerId) return;
  event.preventDefault();
  const deltaX = (event.clientX - interaction.startClientX) / interaction.stageRect.width;
  const deltaY = (event.clientY - interaction.startClientY) / interaction.stageRect.height;
  if (interaction.mode === "font-resize") {
    const minDimension = Math.min(interaction.stageRect.width, interaction.stageRect.height);
    const fontDelta = (event.clientY - interaction.startClientY) / minDimension;
    interaction.currentFontSizeRatio = setStructuredFontSizeInState(
      interaction.groupId,
      interaction.startFontSizeRatio + fontDelta,
    );
    if (interaction.layoutMode === "items") {
      interaction.currentItemBoxes = resizeKeywordBoxesInState(
        interaction.groupId,
        interaction.startItemBoxes,
        interaction.currentFontSizeRatio / interaction.startFontSizeRatio,
      );
    }
    interaction.moved = Math.abs(interaction.currentFontSizeRatio - interaction.startFontSizeRatio) > 0.000001;
    return;
  }
  const start = interaction.startBox;
  const next = {
    ...start,
    x: clamp(start.x + deltaX, 0, 1 - start.width),
    y: clamp(start.y + deltaY, 0, 1 - start.height),
  };
  interaction.currentBox = normalizedCaptionBox(next);
  interaction.moved = !captionBoxesEqual(interaction.startBox, interaction.currentBox);
  if (interaction.target === "item") {
    setStructuredItemBoxInState(interaction.groupId, interaction.itemId, interaction.currentBox);
  } else {
    setStructuredBoxInState(interaction.groupId, interaction.currentBox);
  }
}

function finishStructuredInteraction(event, cancelled = false) {
  const interaction = structuredInteraction;
  if (!interaction || (event && event.pointerId !== interaction.pointerId)) return;
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  structuredInteraction = null;
  if (elements.structuredOverlay.hasPointerCapture?.(interaction.pointerId)) {
    elements.structuredOverlay.releasePointerCapture(interaction.pointerId);
  }
  if (cancelled) {
    if (interaction.target === "font") {
      setStructuredFontSizeInState(interaction.groupId, interaction.startFontSizeRatio);
      if (interaction.layoutMode === "items") {
        resizeKeywordBoxesInState(interaction.groupId, interaction.startItemBoxes, 1, interaction.startLayout || "auto");
      }
    } else if (interaction.target === "item") {
      setStructuredItemBoxInState(interaction.groupId, interaction.itemId, interaction.startBox, interaction.startLayout || "auto");
    } else {
      setStructuredBoxInState(interaction.groupId, interaction.startBox);
    }
  } else if (interaction.moved) {
    if (interaction.target === "font") {
      saveStructuredFontSize(
        interaction.groupId,
        interaction.currentFontSizeRatio,
        interaction.layoutMode === "items" ? interaction.currentItemBoxes : null,
      );
    } else if (interaction.target === "item") {
      saveStructuredItemBox(interaction.groupId, interaction.itemId, interaction.currentBox);
    } else {
      saveStructuredBox(interaction.groupId, interaction.currentBox);
    }
  }
  renderStructuredSelection();
  resumeCaptionPlayback(interaction);
}

function previewSelectionRange(range) {
  const startWord = state?.words?.[range?.start];
  if (!startWord) return;
  elements.video.pause();
  elements.video.currentTime = startWord.start;
  elements.seekSlider.value = String(startWord.start);
  updatePlayerControls();
}

async function toggleSelectionEffect(effectType, preset, button) {
  const range = selectionInfo();
  if (!range) {
    setSaveStatus("请先选择连续文字", true);
    return;
  }
  if (!range.contiguous) {
    setSaveStatus("当前选择不连续，请补齐或取消多余文字", true);
    return;
  }
  const target = effectTargetAsset();
  if (!effectTypeSupportsTarget(effectType, target)) {
    setSaveStatus(`${effectTargetLabel(target)}不支持${effectType.ui?.label || effectType.id}`, true);
    return;
  }
  const enabled = !selectionHasEffect(range, target.id, effectType.id, preset.config);
  const effectLabel = button.textContent.trim();
  try {
    savingEffect = true;
    renderControls();
    setSaveStatus(enabled ? `正在添加${effectLabel}` : `正在取消${effectLabel}`);
    await requestJson("/api/effects", {
      method: "POST",
      body: JSON.stringify({
        replace_range: true,
        enabled,
        type: effectType.id,
        target: { asset_id: target.id },
        start_word_index: range.start,
        end_word_index: range.end,
        config: preset.config,
      }),
    });
    selectedWords.clear();
    await loadState();
    previewSelectionRange(range);
    setSaveStatus(enabled ? `${effectLabel}已启用并热重载` : `${effectLabel}已取消并热重载`);
  } catch (error) {
    setSaveStatus(`${error.message}${error.details ? `　${JSON.stringify(error.details)}` : ""}`, true);
  } finally {
    savingEffect = false;
    renderControls();
  }
}

async function clearSelectedEffects() {
  const range = selectionInfo();
  if (!range?.contiguous) {
    setSaveStatus("请先选择连续文字", true);
    return;
  }
  const target = effectTargetAsset();
  if (!target) {
    setSaveStatus("当前没有可清除效果的 Asset", true);
    return;
  }
  try {
    savingEffect = true;
    renderControls();
    setSaveStatus("正在保存");
    await requestJson("/api/effects", {
      method: "POST",
      body: JSON.stringify({
        replace_range: true,
        enabled: false,
        clear_channels: true,
        target: { asset_id: target.id },
        start_word_index: range.start,
        end_word_index: range.end,
      }),
    });
    selectedWords.clear();
    setSaveStatus(`${effectTargetLabel(target)}效果已清除并热重载`);
    await loadState();
    previewSelectionRange(range);
  } catch (error) {
    setSaveStatus(`${error.message}${error.details ? `　${JSON.stringify(error.details)}` : ""}`, true);
  } finally {
    savingEffect = false;
    renderControls();
  }
}

async function startRender() {
  if (!renderEngineCompatible) {
    setSaveStatus("导出服务版本过旧，请重启服务后再导出", true);
    return;
  }
  if (state.profileLock?.ok === false) {
    setSaveStatus("Profile 与 lock 不一致，请先同步后再导出", true);
    return;
  }
  if (!window.confirm("确认使用当前全部效果生成最终 MP4 吗")) return;
  try {
    elements.renderButton.disabled = true;
    elements.renderButton.textContent = "正在提交";
    setSaveStatus("正在提交出片任务");
    await requestJson("/api/render", { method: "POST", body: "{}" });
    setSaveStatus("出片任务已经开始");
    await loadState();
  } catch (error) {
    setSaveStatus(error.message, true);
    if (error.message.includes("后台服务已断开")) markServiceDisconnected();
    else renderRenderStatus();
  }
}

function currentEffectAt(time) {
  return playbackEffects.find((effect) => time >= effect.start && time < effect.end) || null;
}

function scalePercentAtTime(effect, time) {
  if (!effect) return 100;
  if (effect.motion !== "progressive") return effect.scale_percent;
  const duration = effect.end - effect.start;
  if (duration <= 0) return 100;
  const progress = Math.max(0, Math.min(1, (time - effect.start) / duration));
  return 100 + (effect.scale_percent - 100) * progress;
}

function channelValueAtTime(effect, time, fromKey, toKey, fallback = 1) {
  if (!effect || time < effect.start || time >= effect.end) return fallback;
  const from = Number(effect[fromKey] ?? fallback);
  const to = Number(effect[toKey] ?? fallback);
  const easing = effect.easing || effect.interpolation || "linear";
  if (easing === "step") return to;
  const duration = effect.end - effect.start;
  if (duration <= 0) return fallback;
  const linearProgress = Math.max(0, Math.min(1, (time - effect.start) / duration));
  const progress = easing === "ease-in"
    ? linearProgress ** 2
    : easing === "ease-out"
      ? 1 - ((1 - linearProgress) ** 2)
      : easing === "ease-in-out"
        ? (linearProgress < 0.5
          ? 2 * linearProgress * linearProgress
          : 1 - (((-2 * linearProgress) + 2) ** 2) / 2)
        : linearProgress;
  return from + (to - from) * progress;
}

function overlayVisualAt(active, time, itemId = null) {
  const effects = active?.effects || {};
  const applies = (entry) => !entry.item_id || entry.item_id === itemId;
  const scaleStates = [...(effects.scale || []), ...(effects.entryScale || []).filter(applies)];
  const opacityStates = [...(effects.opacity || []).filter(applies), ...(effects.entryOpacity || []).filter(applies)];
  const translateYStates = (effects.entryTranslateY || []).filter(applies);
  const textStyle = (effects.textStyle || []).find((entry) => (
    applies(entry) && time >= entry.start && time < entry.end
  ));
  return {
    scale: scaleStates.reduce((value, entry) => (
      value * channelValueAtTime(entry, time, "from_scale", "to_scale", 1)
    ), 1),
    opacity: opacityStates.reduce((value, entry) => (
      value * channelValueAtTime(entry, time, "from_opacity", "to_opacity", 1)
    ), 1),
    translateYRatio: translateYStates.reduce((value, entry) => (
      value + channelValueAtTime(
        entry,
        time,
        "from_translate_y_ratio",
        "to_translate_y_ratio",
        0,
      )
    ), 0),
    fontScale: Number(textStyle?.font_scale || 1),
    color: textStyle?.color || null,
  };
}

function currentWordAt(time) {
  if (!state) return -1;
  const exact = state.words.find((word) => time >= word.start && time < word.end);
  return exact?.wordIndex ?? -1;
}

function currentCaptionAt(time) {
  if (!state?.captionTrack?.enabled) return null;
  return playbackCaptions.find((caption) => time >= caption.start && time < caption.end) || null;
}

function currentStructuredOverlayAt(time) {
  return playbackOverlays.find((overlay) => time >= overlay.start && time < overlay.end) || null;
}

function currentImageOverlayAt(time) {
  return playbackImageOverlays.find((overlay) => (
    time >= overlay.start
    && time < overlay.end
    && !(overlay.suppression_ranges || []).some((range) => time >= range.start && time < range.end)
  )) || null;
}

function drawPreviewFrame(percent) {
  if (!previewContext || elements.video.readyState < 2) return;
  const canvasWidth = elements.previewCanvas.width;
  const canvasHeight = elements.previewCanvas.height;
  const videoWidth = elements.video.videoWidth;
  const videoHeight = elements.video.videoHeight;
  if (!canvasWidth || !canvasHeight || !videoWidth || !videoHeight) return;
  const containScale = Math.min(canvasWidth / videoWidth, canvasHeight / videoHeight);
  const effectScale = percent / 100;
  const drawWidth = videoWidth * containScale * effectScale;
  const drawHeight = videoHeight * containScale * effectScale;
  const drawX = (canvasWidth - drawWidth) / 2;
  const drawY = (canvasHeight - drawHeight) / 2;
  previewContext.fillStyle = "#000";
  previewContext.fillRect(0, 0, canvasWidth, canvasHeight);
  previewContext.imageSmoothingEnabled = true;
  previewContext.imageSmoothingQuality = "high";
  previewContext.drawImage(elements.video, drawX, drawY, drawWidth, drawHeight);
}

function renderSubtitleOverlay(caption) {
  const overlay = elements.subtitleOverlay;
  if (!caption || !state?.captionTrack) {
    overlay.style.display = "none";
    elements.subtitleText.textContent = "";
    overlay.dataset.activeCaption = "";
    return;
  }
  const { box, style } = state.captionTrack;
  const frameWidth = elements.videoStage.clientWidth;
  const frameHeight = elements.videoStage.clientHeight;
  const minDimension = Math.min(frameWidth, frameHeight);
  const layoutFontScale = Number(caption.layout_font_scale) || 1;
  const fontSizeRatio = Number(caption.font_size_ratio) || style.font_size_ratio;
  const fontSize = Math.max(12, minDimension * fontSizeRatio) * layoutFontScale;
  const strokeWidth = Math.max(1, minDimension * style.stroke_width_ratio);
  overlay.style.display = "flex";
  overlay.style.left = `${box.x * 100}%`;
  overlay.style.top = "auto";
  overlay.style.bottom = `${(1 - box.y - box.height) * 100}%`;
  overlay.style.width = `${box.width * 100}%`;
  overlay.style.height = "auto";
  overlay.style.fontFamily = `"${caption.font_family || style.font_family}", "Microsoft YaHei", sans-serif`;
  overlay.style.fontSize = `${fontSize}px`;
  overlay.style.color = style.color;
  overlay.style.webkitTextStroke = `${strokeWidth}px ${style.stroke_color}`;
  elements.subtitleText.replaceChildren();
  const styledLines = Array.isArray(caption.styledLines) && caption.styledLines.length
    ? caption.styledLines
    : (caption.lines || [caption.text]).map((line) => [{ text: line }]);
  styledLines.forEach((line, lineIndex) => {
    if (lineIndex > 0) elements.subtitleText.append(document.createElement("br"));
    for (const segment of line) {
      const span = document.createElement("span");
      span.textContent = segment.text;
      if (Number(segment.style?.font_scale) > 1) {
        span.style.fontSize = `${Number(segment.style.font_scale)}em`;
      }
      if (segment.style?.color) span.style.color = segment.style.color;
      elements.subtitleText.append(span);
    }
  });
  overlay.dataset.activeCaption = caption.text;
  renderCaptionSelection();
}

function renderImageOverlay(active, time) {
  const overlay = elements.imageOverlay;
  if (!active) {
    overlay.style.display = "none";
    overlay.dataset.overlayId = "";
    overlay.dataset.assetUrl = "";
    imageBoxSelected = false;
    renderImageSelection();
    return;
  }
  const { box } = active;
  overlay.style.display = "block";
  overlay.style.left = `${box.x * 100}%`;
  overlay.style.top = `${box.y * 100}%`;
  overlay.style.width = `${box.width * 100}%`;
  overlay.style.height = `${box.height * 100}%`;
  const visual = overlayVisualAt(active, time);
  elements.imageOverlayContent.style.transform = `scale(${visual.scale})`;
  elements.imageOverlayContent.style.opacity = String(visual.opacity);
  if (overlay.dataset.assetUrl !== active.asset_url) {
    elements.imageOverlayContent.src = active.asset_url;
    elements.imageOverlayContent.alt = `贴图 ${active.source_text || ""}`.trim();
  }
  overlay.dataset.overlayId = active.id;
  overlay.dataset.assetUrl = active.asset_url;
  renderImageSelection();
}

function applyStructuredEntryAnimation(active, time) {
  const frameHeight = elements.videoStage.clientHeight;
  for (const itemElement of elements.structuredList.querySelectorAll("[data-item-id]")) {
    const item = active.items.find((candidate) => candidate.id === itemElement.dataset.itemId);
    const visual = overlayVisualAt(active, time, item?.id);
    itemElement.style.opacity = String(visual.opacity);
    itemElement.style.transform = `translateY(${visual.translateYRatio * frameHeight}px) scale(${visual.scale})`;
    itemElement.style.fontSize = `${visual.fontScale}em`;
    itemElement.style.color = visual.color || "";
  }
}

function colorWithOpacity(color, opacity) {
  const match = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(String(color || ""));
  if (!match) return "transparent";
  return `rgba(${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}, ${Math.max(0, Math.min(1, Number(opacity) || 0))})`;
}

function renderStructuredOverlay(active, time) {
  const overlay = elements.structuredOverlay;
  if (!active) {
    overlay.style.display = "none";
    overlay.classList.remove("structured-overlay--keywords");
    elements.structuredList.replaceChildren();
    overlay.dataset.activeState = "";
    overlay.dataset.overlayId = "";
    return;
  }
  const { box, style } = active;
  const container = active.container || {};
  const frameWidth = elements.videoStage.clientWidth;
  const frameHeight = elements.videoStage.clientHeight;
  const minDimension = Math.min(frameWidth, frameHeight);
  const fontSize = Math.max(12, minDimension * style.font_size_ratio);
  const strokeWidth = Math.max(1, minDimension * style.stroke_width_ratio);
  const isItems = active.layout_mode === "items";
  overlay.classList.toggle("structured-overlay--keywords", isItems);
  overlay.style.display = isItems ? "block" : "flex";
  overlay.style.left = `${(isItems ? 0 : box.x) * 100}%`;
  overlay.style.top = `${(isItems ? 0 : box.y) * 100}%`;
  overlay.style.width = `${(isItems ? 1 : box.width) * 100}%`;
  overlay.style.height = isItems ? "100%" : `${box.height * 100}%`;
  overlay.style.fontFamily = `"${style.font_family}", "Microsoft YaHei", sans-serif`;
  overlay.style.fontSize = `${fontSize}px`;
  overlay.style.color = style.color;
  overlay.style.webkitTextStroke = `${strokeWidth}px ${style.stroke_color}`;
  elements.structuredList.style.gap = isItems ? "0" : `${frameHeight * style.item_gap_ratio}px`;
  elements.structuredList.style.height = isItems ? "100%" : "100%";
  elements.structuredList.style.padding = isItems
    ? "0"
    : `${minDimension * Number(container.padding_ratio || 0)}px`;
  elements.structuredList.style.backgroundColor = isItems
    ? "transparent"
    : colorWithOpacity(container.background_color, container.background_opacity);
  elements.structuredList.style.border = isItems
    ? "0"
    : `${minDimension * Number(container.border_width_ratio || 0)}px solid ${colorWithOpacity(container.border_color, container.border_opacity)}`;
  elements.structuredList.style.borderRadius = isItems
    ? "0"
    : `${minDimension * Number(container.border_radius_ratio || 0)}px`;
  if (overlay.dataset.activeState !== active.id) {
    elements.structuredList.replaceChildren();
    for (const item of active.items) {
      const row = document.createElement("div");
      row.className = isItems ? "structured-keyword" : "structured-list__item";
      row.dataset.itemId = item.id;
      row.textContent = item.lines.join("\n");
      const resizeHandle = document.createElement("span");
      resizeHandle.className = "structured-item-resize-handle";
      resizeHandle.setAttribute("aria-hidden", "true");
      row.append(resizeHandle);
      elements.structuredList.append(row);
    }
    overlay.dataset.activeState = active.id;
  }
  if (isItems) {
    for (const item of active.items) {
      const row = elements.structuredList.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`);
      if (!row) continue;
      row.style.left = `${item.box.x * 100}%`;
      row.style.top = `${(item.box.y + item.box.height / 2) * 100}%`;
      row.style.width = `${item.box.width * 100}%`;
      row.style.height = "auto";
    }
  }
  applyStructuredEntryAnimation(active, time);
  overlay.dataset.overlayId = active.overlay_id;
  renderStructuredSelection();
}

function animationTick() {
  const time = elements.video.currentTime || 0;
  updatePlayerControls();
  if (state) {
    const effect = currentEffectAt(time);
    const percent = scalePercentAtTime(effect, time);
    drawPreviewFrame(percent);
    renderImageOverlay(currentImageOverlayAt(time), time);
    renderStructuredOverlay(currentStructuredOverlayAt(time), time);
    renderSubtitleOverlay(currentCaptionAt(time));
    elements.activeEffectBadge.textContent = effect
      ? `${percent.toFixed(1)}% · ${effect.effect_label}`
      : "原画面 100%";
    const nextWordIndex = currentWordAt(time);
    if (nextWordIndex !== currentWordIndex) {
      currentWordIndex = nextWordIndex;
      renderTranscriptClasses();
    }
  }
  requestAnimationFrame(animationTick);
}

document.addEventListener("pointerup", endPaint);
document.addEventListener("pointercancel", endPaint);
window.addEventListener("blur", endPaint);
elements.transcript.addEventListener("pointermove", paintFromPointer);
elements.transcript.addEventListener("pointerover", paintFromPointer);
elements.renderButton.addEventListener("click", startRender);
elements.saveProjectButton.addEventListener("click", saveProject);
elements.subtitleToggleButton.addEventListener("click", () => {
  void setCaptionsEnabled(!Boolean(state?.captionTrack?.enabled));
});
elements.fontFamilySelect.addEventListener("change", () => {
  saveSelectedFont(elements.fontFamilySelect.value);
});
elements.subtitleOverlay.addEventListener("pointerdown", beginCaptionInteraction);
elements.subtitleOverlay.addEventListener("pointermove", updateCaptionInteraction);
elements.subtitleOverlay.addEventListener("pointerup", (event) => finishCaptionInteraction(event));
elements.subtitleOverlay.addEventListener("pointercancel", (event) => finishCaptionInteraction(event, true));
elements.imageOverlay.addEventListener("pointerdown", beginImageInteraction);
elements.imageOverlay.addEventListener("pointermove", updateImageInteraction);
elements.imageOverlay.addEventListener("pointerup", (event) => finishImageInteraction(event));
elements.imageOverlay.addEventListener("pointercancel", (event) => finishImageInteraction(event, true));
elements.structuredOverlay.addEventListener("pointerdown", beginStructuredInteraction);
elements.structuredOverlay.addEventListener("pointermove", updateStructuredInteraction);
elements.structuredOverlay.addEventListener("pointerup", (event) => finishStructuredInteraction(event));
elements.structuredOverlay.addEventListener("pointercancel", (event) => finishStructuredInteraction(event, true));
document.addEventListener("pointerdown", (event) => {
  const clickedTextStyleAction = event.target.closest?.("[data-text-style-action]");
  if (!elements.subtitleOverlay.contains(event.target) && !clickedTextStyleAction) {
    captionBoxSelected = false;
    clearSelectedTextTarget("caption");
    renderCaptionSelection();
  }
  if (!elements.structuredOverlay.contains(event.target) && !clickedTextStyleAction) {
    structuredBoxSelected = false;
    structuredSelectedItemId = null;
    clearSelectedTextTarget("overlay");
    renderStructuredSelection();
  }
  if (!elements.imageOverlay.contains(event.target)) {
    imageBoxSelected = false;
    renderImageSelection();
  }
  const clickedWord = event.target.closest?.(".word");
  const clickedEffectAction = event.target.closest?.(
    "[data-selection-effect], [data-direct-effect], [data-structured-action], [data-text-style-action]",
  );
  if (!clickedWord && !clickedEffectAction && selectedWords.size > 0) {
    selectedWords.clear();
    setSaveStatus("");
    renderTranscriptClasses();
    renderControls();
  }
});
elements.playPauseButton.addEventListener("click", togglePlayback);
elements.previewCanvas.addEventListener("click", () => {
  selectEffectTarget(defaultEffectTargetId());
  togglePlayback();
});
elements.seekSlider.addEventListener("pointerdown", () => { seeking = true; });
elements.seekSlider.addEventListener("input", () => {
  elements.video.currentTime = Number(elements.seekSlider.value);
  updatePlayerControls();
});
elements.seekSlider.addEventListener("change", () => { seeking = false; });
elements.seekSlider.addEventListener("pointerup", () => { seeking = false; });
elements.video.addEventListener("loadedmetadata", () => {
  updatePlayerControls();
  applyRestoredPlaybackPosition();
});
elements.video.addEventListener("play", updatePlayerControls);
elements.video.addEventListener("pause", updatePlayerControls);

const previewResizeObserver = new ResizeObserver(fitVideoFrame);
previewResizeObserver.observe(elements.previewPanel);

const events = new EventSource("/api/events");
events.addEventListener("ready", () => {
  setConnection("已连接", "ok");
  void loadState({ external: true });
});
events.addEventListener("state", () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => loadState({ external: true }), 100);
});
events.addEventListener("composition-updated", () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => loadState({ external: true }), 100);
});
events.onerror = () => markServiceDisconnected();

loadState();
requestAnimationFrame(animationTick);
