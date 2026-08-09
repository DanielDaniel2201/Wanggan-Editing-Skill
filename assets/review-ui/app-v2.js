const elements = {
  video: document.querySelector("#video"),
  previewPanel: document.querySelector("#previewPanel"),
  videoFrame: document.querySelector("#videoFrame"),
  videoStage: document.querySelector("#videoStage"),
  previewCanvas: document.querySelector("#previewCanvas"),
  structuredOverlay: document.querySelector("#structuredOverlay"),
  structuredList: document.querySelector("#structuredList"),
  structuredResizeHandle: document.querySelector("#structuredResizeHandle"),
  subtitleOverlay: document.querySelector("#subtitleOverlay"),
  subtitleText: document.querySelector("#subtitleText"),
  subtitleResizeHandle: document.querySelector("#subtitleResizeHandle"),
  transcript: document.querySelector("#transcript"),
  directEffectButtons: [...document.querySelectorAll("[data-direct-effect]")],
  selectionEffectButtons: [...document.querySelectorAll("[data-selection-effect]")],
  saveStatus: document.querySelector("#saveStatus"),
  connectionStatus: document.querySelector("#connectionStatus"),
  activeEffectBadge: document.querySelector("#activeEffectBadge"),
  playPauseButton: document.querySelector("#playPauseButton"),
  seekSlider: document.querySelector("#seekSlider"),
  playerTime: document.querySelector("#playerTime"),
  playerControls: document.querySelector("#playerControls"),
  subtitleToggleButton: document.querySelector("#subtitleToggleButton"),
  structuredEditor: document.querySelector("#structuredEditor"),
  newListButton: document.querySelector("#newListButton"),
  saveProjectButton: document.querySelector("#saveProjectButton"),
  renderButton: document.querySelector("#renderButton"),
};

const previewContext = elements.previewCanvas.getContext("2d", { alpha: false });

let state = null;
let playbackEffects = [];
let playbackCaptions = [];
let playbackOverlays = [];
let renderEngineCompatible = false;
const requiredRenderEngineVersion = 8;
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
let structuredInteraction = null;

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || `请求失败 ${response.status}`);
    error.details = value.details;
    throw error;
  }
  return value;
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

function effectForWord(wordIndex, target) {
  return state?.effects.find((effect) => (
    effect.target === target
    &&
    wordIndex >= effect.start_word_index && wordIndex <= effect.end_word_index
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

function selectionHasEffect(range, target, effectType) {
  if (!range?.contiguous) return false;
  for (let wordIndex = range.start; wordIndex <= range.end; wordIndex += 1) {
    if (effectForWord(wordIndex, target)?.effect_type !== effectType) return false;
  }
  return true;
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
    const videoEffect = effectForWord(wordIndex, "video.main");
    const captionEffect = effectForWord(wordIndex, "overlay.captions");
    const structuredItem = structuredItemForWord(wordIndex);
    button.classList.toggle("word--in", Boolean(videoEffect?.effect_type.endsWith("emphasis")));
    button.classList.toggle("word--out", Boolean(videoEffect?.effect_type.endsWith("negative")));
    button.classList.toggle("word--long", Boolean(videoEffect?.effect_type.startsWith("long_")));
    button.classList.toggle("word--caption", Boolean(captionEffect));
    button.classList.toggle("word--structured", Boolean(structuredItem));
    button.classList.toggle("word--selected", selectedWords.has(wordIndex));
    button.classList.toggle("word--current", wordIndex === currentWordIndex);
    button.title = [
      videoEffect?.effect_type,
      captionEffect?.effect_type,
      structuredItem ? "progressive_list" : null,
    ].filter(Boolean).join(" + ");
  }
}

function renderControls() {
  const range = selectionInfo();
  for (const button of elements.directEffectButtons) {
    button.disabled = selectedWords.size === 0 || savingEffect;
  }
  for (const button of elements.selectionEffectButtons) {
    const selected = selectionHasEffect(range, button.dataset.target, button.dataset.effectType);
    button.disabled = !range?.contiguous || savingEffect;
    button.setAttribute("aria-pressed", String(selected));
  }
  elements.newListButton.disabled = !range?.contiguous || savingOverlays;
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

function overlayItemInput(item, overrides = {}) {
  return {
    id: item.id,
    start_word_index: item.start_word_index,
    end_word_index: item.end_word_index,
    display_text: item.display_text,
    ...overrides,
  };
}

function overlayGroupInput(group, overrides = {}) {
  return {
    id: group.id,
    type: "progressive_list",
    enabled: group.enabled,
    coordinate_space: "screen",
    box: { ...group.box },
    style: { ...group.style },
    items: group.items.map((item) => overlayItemInput(item)),
    source: group.source,
    human_modified: group.human_modified,
    ...overrides,
  };
}

function currentOverlayGroups() {
  return (state?.structuredOverlayTrack?.groups || []).map((group) => overlayGroupInput(group));
}

async function saveOverlayGroups(groups, successMessage) {
  if (!renderEngineCompatible || savingOverlays) return;
  try {
    savingOverlays = true;
    renderControls();
    setSaveStatus("正在保存清单");
    await requestJson("/api/overlays", {
      method: "PUT",
      body: JSON.stringify({
        version: 2,
        captions: state.overlays.captions,
        timed_overlays: groups,
      }),
    });
    await loadState();
    setSaveStatus(successMessage || "清单已保存并热重载");
  } catch (error) {
    setSaveStatus(`${error.message}${error.details ? `　${JSON.stringify(error.details)}` : ""}`, true);
  } finally {
    savingOverlays = false;
    renderControls();
    renderStructuredEditor();
  }
}

function createListFromSelection() {
  const range = selectionInfo();
  if (!range?.contiguous) {
    setSaveStatus("请先选择一段连续逐字稿", true);
    return;
  }
  const displayText = state.words
    .slice(range.start, range.end + 1)
    .map((word) => word.text)
    .join("");
  const groups = currentOverlayGroups();
  groups.push({
    id: `overlay-list-${Date.now()}`,
    type: "progressive_list",
    enabled: true,
    items: [{
      start_word_index: range.start,
      end_word_index: range.end,
      display_text: displayText,
    }],
    source: "human",
    human_modified: false,
  });
  void saveOverlayGroups(groups, "新清单已创建");
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

function updatedGroup(groups, groupId, updater) {
  return groups.map((group) => group.id === groupId
    ? updater({ ...group, items: group.items.map((item) => ({ ...item })) })
    : group);
}

function renderStructuredEditor() {
  elements.structuredEditor.replaceChildren();
  const groups = state?.structuredOverlayTrack?.groups || [];
  if (!groups.length) {
    const empty = document.createElement("p");
    empty.className = "structured-editor__empty";
    empty.textContent = "当前没有清单，选择连续文字后点击新建";
    elements.structuredEditor.append(empty);
    return;
  }

  groups.forEach((group, groupIndex) => {
    const section = document.createElement("section");
    section.className = "structured-group";
    const heading = document.createElement("div");
    heading.className = "structured-group__heading";
    const title = document.createElement("span");
    title.className = "structured-group__title";
    title.textContent = `清单 ${groupIndex + 1}`;
    const headingActions = document.createElement("div");
    headingActions.className = "structured-group__actions";
    headingActions.append(
      compactButton(group.enabled ? "撤下" : "启用", "", () => {
        const next = updatedGroup(currentOverlayGroups(), group.id, (candidate) => ({
          ...candidate,
          enabled: !candidate.enabled,
          human_modified: true,
        }));
        void saveOverlayGroups(next, group.enabled ? "清单已撤下" : "清单已启用");
      }),
      compactButton("删除", "compact-button--danger", () => {
        if (!window.confirm("确认删除整组清单吗")) return;
        void saveOverlayGroups(
          currentOverlayGroups().filter((candidate) => candidate.id !== group.id),
          "清单已删除",
        );
      }),
    );
    heading.append(title, headingActions);
    section.append(heading);

    group.items.forEach((item, itemIndex) => {
      const row = document.createElement("div");
      row.className = "structured-item-editor";
      row.append(compactButton(String(itemIndex + 1), "compact-button--index", () => {
        selectStructuredItem(item);
      }));
      const input = document.createElement("input");
      input.type = "text";
      input.value = item.display_text;
      input.maxLength = 120;
      input.setAttribute("aria-label", `清单 ${groupIndex + 1} 第 ${itemIndex + 1} 条显示文字`);
      input.dataset.structuredAction = "";
      input.addEventListener("change", () => {
        if (input.value.trim() === item.display_text) return;
        const next = updatedGroup(currentOverlayGroups(), group.id, (candidate) => ({
          ...candidate,
          items: candidate.items.map((entry) => entry.id === item.id
            ? overlayItemInput(entry, { display_text: input.value.trim() })
            : entry),
          human_modified: true,
        }));
        void saveOverlayGroups(next, "清单文案已保存");
      });
      row.append(input);
      row.append(compactButton("替换", "", () => {
        const range = selectionInfo();
        if (!range?.contiguous) {
          setSaveStatus("请先选择一段连续逐字稿", true);
          return;
        }
        const next = updatedGroup(currentOverlayGroups(), group.id, (candidate) => ({
          ...candidate,
          items: candidate.items.map((entry) => entry.id === item.id
            ? overlayItemInput(entry, {
              start_word_index: range.start,
              end_word_index: range.end,
            })
            : entry),
          human_modified: true,
        }));
        void saveOverlayGroups(next, "清单条目范围已替换");
      }));
      row.append(compactButton("×", "compact-button--danger", () => {
        if (!window.confirm("确认删除这个清单条目吗")) return;
        const groupsInput = currentOverlayGroups();
        const next = group.items.length === 1
          ? groupsInput.filter((candidate) => candidate.id !== group.id)
          : updatedGroup(groupsInput, group.id, (candidate) => ({
            ...candidate,
            items: candidate.items.filter((entry) => entry.id !== item.id),
            human_modified: true,
          }));
        void saveOverlayGroups(next, "清单条目已删除");
      }));
      section.append(row);
    });

    section.append(compactButton("追加当前选择", "", () => {
      const range = selectionInfo();
      if (!range?.contiguous) {
        setSaveStatus("请先选择一段连续逐字稿", true);
        return;
      }
      const displayText = state.words
        .slice(range.start, range.end + 1)
        .map((word) => word.text)
        .join("");
      const next = updatedGroup(currentOverlayGroups(), group.id, (candidate) => ({
        ...candidate,
        items: [
          ...candidate.items,
          {
            start_word_index: range.start,
            end_word_index: range.end,
            display_text: displayText,
          },
        ],
        human_modified: true,
      }));
      void saveOverlayGroups(next, "清单条目已追加");
    }));
    elements.structuredEditor.append(section);
  });
}

function renderRenderStatus() {
  const status = state.renderStatus || { state: "idle" };
  const running = status.state === "running";
  elements.renderButton.disabled = running || !renderEngineCompatible;
  elements.renderButton.textContent = running
    ? `生成中 ${status.progress || 0}%`
    : renderEngineCompatible
      ? "确认并生成成片"
      : "导出服务需重启";
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
    renderEngineCompatible = state.renderEngineVersion === requiredRenderEngineVersion
      && Array.isArray(state.playbackEffects)
      && Array.isArray(state.playbackCaptions)
      && Array.isArray(state.playbackOverlays)
      && Boolean(state.captionTrack)
      && Boolean(state.structuredOverlayTrack);
    playbackEffects = renderEngineCompatible ? state.playbackEffects : state.effects;
    playbackCaptions = renderEngineCompatible ? state.playbackCaptions : [];
    playbackOverlays = renderEngineCompatible ? state.playbackOverlays : [];
    elements.structuredOverlay.dataset.activeState = "";
    if (firstLoad) {
      selectedWords.clear();
      for (const wordIndex of state.editorState?.selectedWordIndexes || []) selectedWords.add(wordIndex);
      pendingRestoreTime = Number(state.editorState?.currentTime || 0);
      renderTranscript();
    }
    else renderTranscriptClasses();
    renderProject();
    applyRestoredPlaybackPosition();
    renderCaptionControls();
    renderStructuredEditor();
    renderControls();
    renderRenderStatus();
    renderProjectSaveButton();
    if (renderEngineCompatible) {
      setConnection(options.external ? "已热重载" : "已连接", "ok");
    } else {
      setConnection("导出服务需重启", "error");
      setSaveStatus("网页与导出引擎版本不一致，请重启服务后再导出", true);
    }
  } catch (error) {
    setConnection("连接失败", "error");
    setSaveStatus(error.message, true);
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
    saveButtonResetTimer = setTimeout(() => renderProjectSaveButton(), 2000);
  } finally {
    savingProject = false;
    elements.saveProjectButton.disabled = !renderEngineCompatible;
  }
}

async function setCaptionsEnabled(enabled) {
  if (!renderEngineCompatible || savingCaptions) return;
  if (Boolean(state.captionTrack.enabled) === enabled) return;
  try {
    savingCaptions = true;
    renderCaptionControls();
    setSaveStatus(enabled ? "正在启用字幕" : "正在关闭字幕");
    await requestJson("/api/overlays/captions", {
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
  if (state.overlays?.captions) state.overlays.captions.box = { ...normalized };
}

function renderCaptionSelection() {
  elements.subtitleOverlay.classList.toggle("subtitle-overlay--selected", captionBoxSelected);
  elements.subtitleOverlay.classList.toggle("subtitle-overlay--dragging", Boolean(captionInteraction));
  elements.subtitleOverlay.setAttribute("aria-pressed", String(captionBoxSelected));
}

async function saveCaptionBox(box, previousBox) {
  if (!renderEngineCompatible || savingCaptions) return;
  try {
    savingCaptions = true;
    renderCaptionControls();
    setSaveStatus("正在保存字幕区块");
    await requestJson("/api/overlays/captions", {
      method: "PATCH",
      body: JSON.stringify({ box }),
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

function beginCaptionInteraction(event) {
  if (event.button !== 0 || !state?.captionTrack?.enabled || savingCaptions) return;
  const stageRect = elements.videoStage.getBoundingClientRect();
  if (!stageRect.width || !stageRect.height) return;
  event.preventDefault();
  event.stopPropagation();
  captionBoxSelected = true;
  const startBox = normalizedCaptionBox(state.captionTrack.box);
  captionInteraction = {
    pointerId: event.pointerId,
    mode: event.target.closest(".subtitle-resize-handle") ? "resize" : "move",
    startClientX: event.clientX,
    startClientY: event.clientY,
    stageRect,
    startBox,
    currentBox: startBox,
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
  const start = interaction.startBox;
  let next;
  if (interaction.mode === "resize") {
    next = {
      ...start,
      width: clamp(start.width + deltaX, 0.05, 1 - start.x),
      height: clamp(start.height + deltaY, 0.05, 1 - start.y),
    };
  } else {
    next = {
      ...start,
      x: clamp(start.x + deltaX, 0, 1 - start.width),
      y: clamp(start.y + deltaY, 0, 1 - start.height),
    };
  }
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
    setCaptionBoxInState(interaction.startBox);
  } else if (interaction.moved) {
    void saveCaptionBox(interaction.currentBox, interaction.startBox);
  }
  renderCaptionSelection();
  resumeCaptionPlayback(interaction);
}

function structuredGroupById(groupId) {
  return state?.structuredOverlayTrack?.groups?.find((group) => group.id === groupId) || null;
}

function setStructuredBoxInState(groupId, box) {
  const normalized = normalizedCaptionBox(box);
  const group = structuredGroupById(groupId);
  if (group) group.box = { ...normalized };
  if (state?.overlays?.timed_overlays) {
    const stored = state.overlays.timed_overlays.find((candidate) => candidate.id === groupId);
    if (stored) stored.box = { ...normalized };
  }
  for (const playbackState of playbackOverlays) {
    if (playbackState.overlay_id === groupId) playbackState.box = { ...normalized };
  }
}

function renderStructuredSelection() {
  elements.structuredOverlay.classList.toggle("structured-overlay--selected", structuredBoxSelected);
  elements.structuredOverlay.classList.toggle("structured-overlay--dragging", Boolean(structuredInteraction));
  elements.structuredOverlay.setAttribute("aria-pressed", String(structuredBoxSelected));
}

function saveStructuredBox(groupId, box) {
  const next = updatedGroup(currentOverlayGroups(), groupId, (candidate) => ({
    ...candidate,
    box: { ...box },
    human_modified: true,
  }));
  void saveOverlayGroups(next, "清单区块已保存并热重载");
}

function beginStructuredInteraction(event) {
  const active = currentStructuredOverlayAt(elements.video.currentTime || 0);
  const group = active ? structuredGroupById(active.overlay_id) : null;
  if (event.button !== 0 || !group?.enabled || savingOverlays) return;
  const stageRect = elements.videoStage.getBoundingClientRect();
  if (!stageRect.width || !stageRect.height) return;
  event.preventDefault();
  event.stopPropagation();
  structuredBoxSelected = true;
  const startBox = normalizedCaptionBox(group.box);
  structuredInteraction = {
    pointerId: event.pointerId,
    groupId: group.id,
    mode: event.target.closest(".structured-resize-handle") ? "resize" : "move",
    startClientX: event.clientX,
    startClientY: event.clientY,
    stageRect,
    startBox,
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
  interaction.currentBox = normalizedCaptionBox(next);
  interaction.moved = !captionBoxesEqual(interaction.startBox, interaction.currentBox);
  setStructuredBoxInState(interaction.groupId, interaction.currentBox);
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
    setStructuredBoxInState(interaction.groupId, interaction.startBox);
  } else if (interaction.moved) {
    saveStructuredBox(interaction.groupId, interaction.currentBox);
  }
  renderStructuredSelection();
  resumeCaptionPlayback(interaction);
}

function effectInput(effect, overrides = {}) {
  return {
    target: effect.target,
    effect_type: effect.effect_type,
    start_word_index: effect.start_word_index,
    end_word_index: effect.end_word_index,
    source: effect.source,
    human_modified: effect.human_modified,
    ...overrides,
  };
}

function previewSelectionRange(range) {
  const startWord = state?.words?.[range?.start];
  if (!startWord) return;
  elements.video.pause();
  elements.video.currentTime = startWord.start;
  elements.seekSlider.value = String(startWord.start);
  updatePlayerControls();
}

function replacementEffects(range, effectType, target = "video.main") {
  const next = [];
  const replacedEffects = state.effects.filter((effect) => (
    effect.target === target
    && effect.start_word_index <= range.end
    && effect.end_word_index >= range.start
  ));
  for (const effect of state.effects) {
    const overlaps = effect.target === target
      && effect.start_word_index <= range.end
      && effect.end_word_index >= range.start;
    if (!overlaps) {
      next.push(effectInput(effect));
      continue;
    }
    if (effect.start_word_index < range.start) {
      next.push(effectInput(effect, { end_word_index: range.start - 1, human_modified: true }));
    }
    if (effect.end_word_index > range.end) {
      next.push(effectInput(effect, { start_word_index: range.end + 1, human_modified: true }));
    }
  }
  if (effectType) {
    const modifiesAiEffect = replacedEffects.some((effect) => effect.source === "ai");
    next.push({
      target,
      effect_type: effectType,
      start_word_index: range.start,
      end_word_index: range.end,
      source: modifiesAiEffect ? "ai" : "human",
      human_modified: modifiesAiEffect,
    });
  }
  return next;
}

async function toggleSelectionEffect(button) {
  const range = selectionInfo();
  if (!range) {
    setSaveStatus("请先选择连续文字", true);
    return;
  }
  if (!range.contiguous) {
    setSaveStatus("当前选择不连续，请补齐或取消多余文字", true);
    return;
  }
  const target = button.dataset.target;
  const effectType = button.dataset.effectType;
  const effectLabel = button.textContent.trim();
  const enabled = !selectionHasEffect(range, target, effectType);
  try {
    savingEffect = true;
    renderControls();
    setSaveStatus(enabled ? `正在添加${effectLabel}` : `正在取消${effectLabel}`);
    await requestJson("/api/selection-effects", {
      method: "PATCH",
      body: JSON.stringify({
        start_word_index: range.start,
        end_word_index: range.end,
        changes: [{ target, effect_type: effectType, enabled }],
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

async function saveEffect(effectType) {
  const range = selectionInfo();
  if (!range) {
    setSaveStatus("请先选择连续文字", true);
    return;
  }
  if (!range.contiguous) {
    setSaveStatus("当前选择不连续，请补齐或取消多余文字", true);
    return;
  }
  try {
    savingEffect = true;
    renderControls();
    setSaveStatus("正在保存");
    await requestJson("/api/effects", {
      method: "PUT",
      body: JSON.stringify({ effects: replacementEffects(range, effectType), default_source: "human" }),
    });
    selectedWords.clear();
    setSaveStatus(effectType ? "已保存并热重载" : "已清除并热重载");
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
  if (!window.confirm("确认使用当前全部效果生成最终 MP4 吗")) return;
  try {
    await requestJson("/api/render", { method: "POST", body: "{}" });
    setSaveStatus("出片任务已经开始");
    await loadState();
  } catch (error) {
    setSaveStatus(error.message, true);
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
  const fontSize = Math.max(12, minDimension * style.font_size_ratio);
  const strokeWidth = Math.max(1, minDimension * style.stroke_width_ratio);
  overlay.style.display = "flex";
  overlay.style.left = `${box.x * 100}%`;
  overlay.style.top = `${box.y * 100}%`;
  overlay.style.width = `${box.width * 100}%`;
  overlay.style.height = `${box.height * 100}%`;
  overlay.style.fontFamily = `"${style.font_family}", "Microsoft YaHei", sans-serif`;
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

function renderStructuredOverlay(active) {
  const overlay = elements.structuredOverlay;
  if (!active) {
    overlay.style.display = "none";
    elements.structuredList.replaceChildren();
    overlay.dataset.activeState = "";
    overlay.dataset.overlayId = "";
    return;
  }
  const { box, style } = active;
  const frameWidth = elements.videoStage.clientWidth;
  const frameHeight = elements.videoStage.clientHeight;
  const minDimension = Math.min(frameWidth, frameHeight);
  const fontSize = Math.max(12, minDimension * style.font_size_ratio);
  const strokeWidth = Math.max(1, minDimension * style.stroke_width_ratio);
  overlay.style.display = "flex";
  overlay.style.left = `${box.x * 100}%`;
  overlay.style.top = `${box.y * 100}%`;
  overlay.style.width = `${box.width * 100}%`;
  overlay.style.height = `${box.height * 100}%`;
  overlay.style.fontFamily = `"${style.font_family}", "Microsoft YaHei", sans-serif`;
  overlay.style.fontSize = `${fontSize}px`;
  overlay.style.color = style.color;
  overlay.style.webkitTextStroke = `${strokeWidth}px ${style.stroke_color}`;
  elements.structuredList.style.gap = `${frameHeight * style.item_gap_ratio}px`;
  if (overlay.dataset.activeState !== active.id) {
    elements.structuredList.replaceChildren();
    for (const item of active.items) {
      const row = document.createElement("div");
      row.className = "structured-list__item";
      row.textContent = item.lines.join("\n");
      elements.structuredList.append(row);
    }
    overlay.dataset.activeState = active.id;
  }
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
    renderStructuredOverlay(currentStructuredOverlayAt(time));
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
elements.subtitleOverlay.addEventListener("pointerdown", beginCaptionInteraction);
elements.subtitleOverlay.addEventListener("pointermove", updateCaptionInteraction);
elements.subtitleOverlay.addEventListener("pointerup", (event) => finishCaptionInteraction(event));
elements.subtitleOverlay.addEventListener("pointercancel", (event) => finishCaptionInteraction(event, true));
elements.subtitleOverlay.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    captionBoxSelected = true;
    renderCaptionSelection();
  } else if (event.key === "Escape") {
    captionBoxSelected = false;
    renderCaptionSelection();
  }
});
elements.structuredOverlay.addEventListener("pointerdown", beginStructuredInteraction);
elements.structuredOverlay.addEventListener("pointermove", updateStructuredInteraction);
elements.structuredOverlay.addEventListener("pointerup", (event) => finishStructuredInteraction(event));
elements.structuredOverlay.addEventListener("pointercancel", (event) => finishStructuredInteraction(event, true));
elements.structuredOverlay.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    structuredBoxSelected = true;
    renderStructuredSelection();
  } else if (event.key === "Escape") {
    structuredBoxSelected = false;
    renderStructuredSelection();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!elements.subtitleOverlay.contains(event.target)) {
    captionBoxSelected = false;
    renderCaptionSelection();
  }
  if (!elements.structuredOverlay.contains(event.target)) {
    structuredBoxSelected = false;
    renderStructuredSelection();
  }
  const clickedWord = event.target.closest?.(".word");
  const clickedEffectAction = event.target.closest?.(
    "[data-selection-effect], [data-direct-effect], [data-structured-action]",
  );
  if (!clickedWord && !clickedEffectAction && selectedWords.size > 0) {
    selectedWords.clear();
    setSaveStatus("");
    renderTranscriptClasses();
    renderControls();
  }
});
elements.playPauseButton.addEventListener("click", togglePlayback);
elements.newListButton.addEventListener("click", createListFromSelection);
elements.previewCanvas.addEventListener("click", togglePlayback);
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

for (const button of elements.directEffectButtons) {
  button.addEventListener("click", () => {
    void saveEffect(button.dataset.effectType || null);
  });
}
for (const button of elements.selectionEffectButtons) {
  button.addEventListener("click", () => void toggleSelectionEffect(button));
}

const events = new EventSource("/api/events");
events.addEventListener("ready", () => setConnection("已连接", "ok"));
events.addEventListener("state", () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => loadState({ external: true }), 100);
});
events.onerror = () => setConnection("正在重连", "muted");

loadState();
requestAnimationFrame(animationTick);
