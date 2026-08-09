const elements = {
  video: document.querySelector("#video"),
  videoFrame: document.querySelector("#videoFrame"),
  videoStage: document.querySelector("#videoStage"),
  transcript: document.querySelector("#transcript"),
  effectList: document.querySelector("#effectList"),
  effectCount: document.querySelector("#effectCount"),
  selectionSummary: document.querySelector("#selectionSummary"),
  startWordIndex: document.querySelector("#startWordIndex"),
  endWordIndex: document.querySelector("#endWordIndex"),
  percentInput: document.querySelector("#percentInput"),
  labelInput: document.querySelector("#labelInput"),
  saveEffectButton: document.querySelector("#saveEffectButton"),
  deleteEffectButton: document.querySelector("#deleteEffectButton"),
  newEffectButton: document.querySelector("#newEffectButton"),
  saveStatus: document.querySelector("#saveStatus"),
  connectionStatus: document.querySelector("#connectionStatus"),
  activeEffectBadge: document.querySelector("#activeEffectBadge"),
  timeLabel: document.querySelector("#timeLabel"),
  projectMeta: document.querySelector("#projectMeta"),
  loopSelection: document.querySelector("#loopSelection"),
  renderButton: document.querySelector("#renderButton"),
  renderStatus: document.querySelector("#renderStatus"),
};

let state = null;
let selectedEffectId = null;
let selection = { start: null, end: null };
let dragging = false;
let dragAnchor = null;
let currentWordIndex = -1;
let reloadTimer = null;

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
  elements.saveStatus.style.color = isError ? "var(--out)" : "var(--muted)";
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const rest = value - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

function selectedEffect() {
  return state?.effects.find((effect) => effect.id === selectedEffectId) || null;
}

function normalizeSelection(start, end) {
  if (!state?.words.length) return { start: null, end: null };
  const max = state.words.length - 1;
  const safeStart = Math.max(0, Math.min(max, Number(start)));
  const safeEnd = Math.max(0, Math.min(max, Number(end)));
  return { start: Math.min(safeStart, safeEnd), end: Math.max(safeStart, safeEnd) };
}

function setSelection(start, end, options = {}) {
  selection = normalizeSelection(start, end);
  if (options.clearEffect) selectedEffectId = null;
  renderTranscriptClasses();
  renderSelection();
  renderEffects();
}

function effectForWord(wordIndex) {
  return state.effects.find((effect) => wordIndex >= effect.startWordIndex && wordIndex <= effect.endWordIndex);
}

function renderTranscript() {
  elements.transcript.replaceChildren();
  for (const word of state.words) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "word";
    button.dataset.wordIndex = String(word.wordIndex);
    button.textContent = word.text;
    button.title = `#${word.wordIndex} ${formatTime(word.start)} - ${formatTime(word.end)}`;
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      dragging = true;
      dragAnchor = word.wordIndex;
      setSelection(word.wordIndex, word.wordIndex);
    });
    button.addEventListener("mouseenter", () => {
      if (dragging) setSelection(dragAnchor, word.wordIndex);
    });
    elements.transcript.append(button);
  }
  renderTranscriptClasses();
}

function renderTranscriptClasses() {
  if (!state) return;
  for (const button of elements.transcript.querySelectorAll(".word")) {
    const wordIndex = Number(button.dataset.wordIndex);
    const effect = effectForWord(wordIndex);
    button.classList.toggle("word--in", Boolean(effect && effect.percent > 100));
    button.classList.toggle("word--out", Boolean(effect && effect.percent < 100));
    button.classList.toggle("word--selected", selection.start !== null && wordIndex >= selection.start && wordIndex <= selection.end);
    button.classList.toggle("word--current", wordIndex === currentWordIndex);
  }
}

function renderSelection() {
  const hasSelection = selection.start !== null && selection.end !== null;
  elements.startWordIndex.max = state.words.length - 1;
  elements.endWordIndex.max = state.words.length - 1;
  elements.startWordIndex.value = hasSelection ? selection.start : "";
  elements.endWordIndex.value = hasSelection ? selection.end : "";
  const effect = selectedEffect();
  if (effect) {
    elements.percentInput.value = effect.percent;
    elements.labelInput.value = effect.label;
  }
  elements.deleteEffectButton.disabled = !effect;
  elements.saveEffectButton.textContent = effect ? "保存人工调整" : "增加决定";
  if (!hasSelection) {
    elements.selectionSummary.textContent = "请在逐字稿中选择连续文字";
    return;
  }
  const words = state.words.slice(selection.start, selection.end + 1);
  elements.selectionSummary.textContent = `${words.map((word) => word.text).join("")}\n#${selection.start} 到 #${selection.end}　${formatTime(words[0].start)} - ${formatTime(words.at(-1).end)}`;
}

function labelText(label) {
  return { key: "重点", positive: "正面", negative: "负面", manual: "人工" }[label] || label;
}

function renderEffects() {
  elements.effectList.replaceChildren();
  elements.effectCount.textContent = `${state.effects.length} 条`;
  if (!state.effects.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "还没有缩放决定";
    elements.effectList.append(empty);
    return;
  }
  for (const effect of state.effects) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `effect-item ${effect.percent < 100 ? "effect-item--out" : ""} ${effect.id === selectedEffectId ? "effect-item--selected" : ""}`;
    const top = document.createElement("div");
    top.className = "effect-item__top";
    top.innerHTML = `<span>${effect.percent}% · ${labelText(effect.label)}</span><span>${effect.humanModified ? "已人工调整" : effect.source === "ai" ? "AI" : "人工"}</span>`;
    const text = document.createElement("div");
    text.className = "effect-item__text";
    text.textContent = effect.text;
    const meta = document.createElement("div");
    meta.className = "effect-item__meta";
    meta.textContent = `#${effect.startWordIndex} - #${effect.endWordIndex}　${formatTime(effect.start)} - ${formatTime(effect.end)}`;
    button.append(top, text, meta);
    button.addEventListener("click", () => {
      selectedEffectId = effect.id;
      elements.percentInput.value = effect.percent;
      elements.labelInput.value = effect.label;
      setSelection(effect.startWordIndex, effect.endWordIndex);
      elements.video.currentTime = effect.start;
    });
    elements.effectList.append(button);
  }
}

function renderProject() {
  elements.videoFrame.style.aspectRatio = `${state.project.displayWidth} / ${state.project.displayHeight}`;
  elements.projectMeta.textContent = `${state.project.displayWidth} × ${state.project.displayHeight}　${formatTime(state.project.duration)}`;
}

function renderRenderStatus() {
  const status = state.renderStatus || { state: "idle" };
  if (status.state === "running") {
    elements.renderStatus.textContent = `正在生成成片　${status.progress || 0}%`;
    elements.renderButton.disabled = true;
  } else if (status.state === "complete") {
    elements.renderStatus.textContent = `成片完成　${status.outputPath}`;
    elements.renderButton.disabled = false;
  } else if (status.state === "failed") {
    elements.renderStatus.textContent = `出片失败　${status.error || "未知错误"}`;
    elements.renderButton.disabled = false;
  } else {
    elements.renderStatus.textContent = "尚未生成成片";
    elements.renderButton.disabled = false;
  }
}

async function loadState(options = {}) {
  try {
    const nextState = await requestJson("/api/state");
    const firstLoad = !state;
    state = nextState;
    if (selectedEffectId && !selectedEffect()) selectedEffectId = null;
    if (selectedEffectId) {
      const effect = selectedEffect();
      selection = { start: effect.startWordIndex, end: effect.endWordIndex };
    }
    if (firstLoad) renderTranscript();
    else renderTranscriptClasses();
    renderProject();
    renderSelection();
    renderEffects();
    renderRenderStatus();
    setConnection(options.external ? "已热重载" : "已连接", "ok");
  } catch (error) {
    setConnection("连接失败", "error");
    setSaveStatus(error.message, true);
  }
}

async function saveEffect() {
  if (selection.start === null || selection.end === null) {
    setSaveStatus("请先选择连续文字", true);
    return;
  }
  const payload = {
    startWordIndex: selection.start,
    endWordIndex: selection.end,
    percent: Number(elements.percentInput.value),
    label: elements.labelInput.value,
  };
  try {
    setSaveStatus("正在保存");
    const url = selectedEffectId ? `/api/effects/${encodeURIComponent(selectedEffectId)}` : "/api/effects";
    const method = selectedEffectId ? "PATCH" : "POST";
    await requestJson(url, { method, body: JSON.stringify(payload) });
    setSaveStatus(payload.percent === 100 ? "已恢复原画面" : "已保存并实时更新预览");
    if (payload.percent === 100) selectedEffectId = null;
    await loadState();
  } catch (error) {
    setSaveStatus(`${error.message}${error.details ? `　${JSON.stringify(error.details)}` : ""}`, true);
  }
}

async function deleteEffect() {
  if (!selectedEffectId) return;
  try {
    await requestJson(`/api/effects/${encodeURIComponent(selectedEffectId)}`, { method: "DELETE" });
    selectedEffectId = null;
    selection = { start: null, end: null };
    setSaveStatus("已删除决定");
    await loadState();
  } catch (error) {
    setSaveStatus(error.message, true);
  }
}

function applyIndexInputs() {
  const start = Number(elements.startWordIndex.value);
  const end = Number(elements.endWordIndex.value);
  if (Number.isInteger(start) && Number.isInteger(end)) setSelection(start, end);
}

function nudge(target, delta) {
  if (selection.start === null) return;
  const next = { ...selection };
  next[target] += delta;
  setSelection(next.start, next.end);
}

async function startRender() {
  if (!window.confirm("确认使用当前全部决定生成最终 MP4 吗")) return;
  try {
    await requestJson("/api/render", { method: "POST", body: "{}" });
    setSaveStatus("出片任务已经开始");
    await loadState();
  } catch (error) {
    setSaveStatus(error.message, true);
  }
}

function currentEffectAt(time) {
  return state?.effects.find((effect) => time >= effect.start && time < effect.end) || null;
}

function currentWordAt(time) {
  if (!state) return -1;
  const exact = state.words.find((word) => time >= word.start && time < word.end);
  return exact?.wordIndex ?? -1;
}

function animationTick() {
  const time = elements.video.currentTime || 0;
  elements.timeLabel.textContent = formatTime(time);
  if (state) {
    const effect = currentEffectAt(time);
    const percent = effect?.percent || 100;
    elements.videoStage.style.transform = `scale(${percent / 100})`;
    elements.activeEffectBadge.textContent = effect
      ? `${percent}% · ${labelText(effect.label)} · ${effect.text}`
      : "原画面 100%";
    const nextWordIndex = currentWordAt(time);
    if (nextWordIndex !== currentWordIndex) {
      currentWordIndex = nextWordIndex;
      renderTranscriptClasses();
    }
    if (elements.loopSelection.checked && selection.start !== null && !elements.video.paused) {
      const start = state.words[selection.start].start;
      const end = state.words[selection.end].end;
      if (time >= end || time < start) elements.video.currentTime = start;
    }
  }
  requestAnimationFrame(animationTick);
}

document.addEventListener("mouseup", () => { dragging = false; dragAnchor = null; });
elements.saveEffectButton.addEventListener("click", saveEffect);
elements.deleteEffectButton.addEventListener("click", deleteEffect);
elements.newEffectButton.addEventListener("click", () => {
  selectedEffectId = null;
  selection = { start: null, end: null };
  elements.percentInput.value = 120;
  elements.labelInput.value = "key";
  renderSelection();
  renderEffects();
  renderTranscriptClasses();
});
elements.startWordIndex.addEventListener("change", applyIndexInputs);
elements.endWordIndex.addEventListener("change", applyIndexInputs);
elements.renderButton.addEventListener("click", startRender);

for (const button of document.querySelectorAll("[data-percent]")) {
  button.addEventListener("click", () => { elements.percentInput.value = button.dataset.percent; });
}
for (const button of document.querySelectorAll("[data-nudge]")) {
  const [target, delta] = button.dataset.nudge.split(":");
  button.addEventListener("click", () => nudge(target, Number(delta)));
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
