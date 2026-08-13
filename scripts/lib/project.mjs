import fs from "node:fs";
import path from "node:path";
import { WangganError, COMPILER_VERSION, readJson } from "./core.mjs";
import { loadProfile, loadProfileLock, compareProfileLock } from "./profile-loader.mjs";
import { loadTranscript } from "./core.mjs";
import { parseSrt } from "./srt.mjs";
import { alignCuesToWords } from "./timeline.mjs";

function requiredPath(project, value, label, options = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new WangganError(`project.json 缺少 ${label}`);
  }
  const resolved = path.resolve(project.projectDir, value);
  if (options.insideProject) {
    const relative = path.relative(project.projectDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new WangganError(`${label} 必须位于工程目录内`, { path: value });
    }
  }
  if (options.mustExist && (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())) {
    throw new WangganError(`找不到 ${label}`, { path: resolved });
  }
  return resolved;
}

export function loadProjectRecord(projectInput) {
  const candidate = path.resolve(projectInput);
  const projectPath = fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
    ? path.join(candidate, "project.json")
    : candidate;
  if (!fs.existsSync(projectPath)) {
    throw new WangganError(`找不到项目文件：${projectPath}`);
  }
  const project = readJson(projectPath);
  project.projectPath = projectPath;
  project.projectDir = path.dirname(projectPath);
  if (Number(project.version) !== 3) {
    throw new WangganError("当前运行时只接受由 init 创建的 project.json v3", {
      receivedVersion: project.version ?? null,
    });
  }
  if (!project.inputs || !project.profile) {
    throw new WangganError("project.json 必须包含 inputs 和 profile");
  }
  project.compositionPath = requiredPath(project, project.composition_file || "composition.json", "composition_file", { insideProject: true });
  project.editorStatePath = requiredPath(project, project.editor_state_file || "editor-state.json", "editor_state_file", { insideProject: true });
  project.renderStatusPath = requiredPath(project, project.render_status_file || "render-status.json", "render_status_file", { insideProject: true });
  project.profileLockPath = requiredPath(project, project.profile.lock_file || "profile-lock.json", "profile.lock_file", { insideProject: true });
  project.videoPath = requiredPath(project, project.inputs.video?.path, "inputs.video.path", { mustExist: true });
  project.transcriptPath = requiredPath(project, project.inputs.words?.path, "inputs.words.path", { mustExist: true });
  project.subtitlePath = requiredPath(project, project.inputs.captions?.path, "inputs.captions.path", { mustExist: true });
  project.previewVideoPath = requiredPath(project, project.previewVideoPath || project.videoPath, "previewVideoPath", { mustExist: true });
  project.outputPath = requiredPath(project, project.output_path || project.outputPath, "output_path");
  project.profileId = String(project.profile.id || "").trim();
  if (!project.profileId) throw new WangganError("project.json 缺少 profile.id");
  project.profilePath = project.profile.path
    ? path.resolve(project.projectDir, project.profile.path)
    : null;
  return project;
}

export async function loadProjectContext(projectInput, options = {}) {
  const project = typeof projectInput === "string" ? loadProjectRecord(projectInput) : projectInput;
  const lock = loadProfileLock(project.profileLockPath);
  const preflightProfile = await loadProfile(project.profilePath || project.profileId, {
    loadRuntime: false,
  });
  const preflightLockStatus = compareProfileLock(preflightProfile, lock);
  if (preflightProfile.hasRuntimeCode && !options.allowProfileCode) {
    throw new WangganError("当前 Profile 包含 runtime module，本次命令必须显式 --allow-profile-code");
  }
  if (
    preflightProfile.hasRuntimeCode
    && !preflightLockStatus.ok
    && !options.allowProfileMismatch
  ) {
    throw new WangganError("Profile lock 不一致，拒绝在校验前执行 runtime module", {
      changes: preflightLockStatus.changes,
    });
  }
  const profile = preflightProfile.hasRuntimeCode
    ? await loadProfile(project.profilePath || project.profileId, {
      allowProfileCode: true,
    })
    : await loadProfile(project.profilePath || project.profileId);
  const lockStatus = compareProfileLock(profile, lock);
  const words = loadTranscript(project.transcriptPath);
  const captionCues = project.inputs.captions.cues?.length
    ? project.inputs.captions.cues.map((cue) => ({ ...cue }))
    : alignCuesToWords(
      parseSrt(fs.readFileSync(project.subtitlePath, "utf8"), { duration: project.duration }),
      words,
    );
  return {
    project,
    profile,
    lock,
    lockStatus,
    words,
    captionCues,
    compilerVersion: COMPILER_VERSION,
  };
}
