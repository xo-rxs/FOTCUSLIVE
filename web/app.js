const $ = (selector) => document.querySelector(selector);
const STORAGE_KEY = "포커스라이브_촬영방";

const createButton = $("#create-room");
const joinForm = $("#join-form");
const joinInput = $("#room-code");
const joinWaiting = $("#join-waiting");
const joinApproval = $("#join-approval");
const connectPanel = $("#connect-panel");
const roomPanel = $("#room-panel");
const libraryPanel = $("#library-panel");
const deviceGrid = $("#device-grid");
const videoList = $("#video-list");
const viewer = $("#viewer");
const video = $("#original-video");
const selectionCanvas = $("#selection-canvas");
const focusCanvas = $("#focus-canvas");
const focusEmpty = $("#focus-empty");
const focusLabel = $("#focus-label");
const viewerNotice = $("#viewer-notice");
const captureInput = $("#capture-file");
const savedInput = $("#saved-file");
const videoInputs = [captureInput, savedInput];
const playButton = $("#toggle-play");
const muteButton = $("#toggle-mute");
const seekRange = $("#seek-range");

let session = null;
let pendingJoin = null;
let room = null;
let tracks = null;
let currentSlot = null;
let selectedId = null;
let lastTrackedTime = 0;
let recording = false;
let toastTimer = null;

try {
  session = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
} catch {
  localStorage.removeItem(STORAGE_KEY);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error("서버에 연결할 수 없습니다. 와이파이 연결을 확인해 주세요.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "요청을 처리하지 못했습니다.");
  }
  return data;
}

function setSession(next) {
  session = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  videoInputs.forEach((input) => { input.disabled = true; });
  $("#upload-hint").textContent = "촬영방 연결 상태를 확인하고 있습니다.";
  connectPanel.hidden = true;
  roomPanel.hidden = false;
  libraryPanel.hidden = false;
  $("#active-code").textContent = next.code;
  $("#your-device").textContent = `이 휴대폰: ${next.slot}번 촬영 기기`;
  joinApproval.hidden = next.slot !== 1;
  pendingJoin = null;
  joinWaiting.hidden = true;
}

function clearSession() {
  window.dispatchEvent(new Event("room-session-cleared"));
  session = null;
  room = null;
  pendingJoin = null;
  localStorage.removeItem(STORAGE_KEY);
  connectPanel.hidden = false;
  roomPanel.hidden = true;
  joinApproval.hidden = true;
  joinWaiting.hidden = true;
  libraryPanel.hidden = true;
  viewer.hidden = true;
  video.pause();
  video.removeAttribute("src");
}

createButton.addEventListener("click", async () => {
  createButton.disabled = true;
  try {
    const next = await requestJson("/api/rooms", { method: "POST" });
    setSession(next);
    await refreshRoom();
    showToast("촬영방이 만들어졌습니다. 다른 휴대폰에 코드를 알려 주세요.");
  } catch (error) {
    showToast(error.message);
  } finally {
    createButton.disabled = false;
  }
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = joinInput.value.trim().toUpperCase();
  if (!/^[A-F0-9]{6}$/.test(code)) {
    showToast("촬영방 코드는 숫자와 영문 대문자 여섯 자리입니다.");
    return;
  }
  const submit = joinForm.querySelector("button");
  submit.disabled = true;
  try {
    const next = await requestJson(`/api/rooms/${code}/join`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    pendingJoin = next;
    joinWaiting.textContent = `확인번호 ${next.verification_code}를 첫 번째 휴대폰에 알려 주세요. 첫 번째 휴대폰에서 승인하면 연결됩니다.`;
    joinWaiting.hidden = false;
    await checkPendingJoin();
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
});

async function checkPendingJoin() {
  if (!pendingJoin) return;
  const current = pendingJoin;
  try {
    const result = await requestJson(`/api/rooms/${current.code}/join/status`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_token: current.request_token }),
    });
    if (pendingJoin !== current || !result.token) return;
    setSession(result);
    await refreshRoom();
    showToast("촬영방에 연결되었습니다.");
  } catch (error) {
    if (pendingJoin !== current) return;
    pendingJoin = null;
    joinWaiting.hidden = true;
    showToast(error.message);
  }
}

joinApproval.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!session || session.slot !== 1) return;
  const input = $("#verification-code");
  const code = input.value.trim();
  if (!/^[0-9]{6}$/.test(code)) {
    showToast("두 번째 휴대폰의 확인번호 여섯 자리를 입력해 주세요.");
    return;
  }
  const submit = joinApproval.querySelector("button");
  submit.disabled = true;
  try {
    await requestJson(`/api/rooms/${session.code}/join/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: session.token, verification_code: code }),
    });
    input.value = "";
    joinApproval.hidden = true;
    await refreshRoom();
    showToast("두 번째 휴대폰이 연결되었습니다.");
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
});

$("#copy-code").addEventListener("click", async () => {
  if (!session) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(session.code);
    } else {
      const input = document.createElement("input");
      input.value = session.code;
      document.body.append(input);
      input.select();
      if (!document.execCommand("copy")) throw new Error("복사 실패");
      input.remove();
    }
    showToast("촬영방 코드를 복사했습니다.");
  } catch {
    showToast(`촬영방 코드: ${session.code}`);
  }
});

$("#leave-room").addEventListener("click", () => {
  if (window.confirm("현재 촬영방에서 나갈까요? 이미 등록한 영상은 이 컴퓨터에 남습니다.")) {
    currentSlot = null;
    tracks = null;
    clearSession();
  }
});

async function sendHeartbeat() {
  if (!session) return;
  try {
    await requestJson(`/api/rooms/${session.code}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: session.token, recording }),
    });
  } catch (error) {
    showToast(error.message);
  }
}

function deviceStatus(device) {
  if (!device.joined) return "연결 대기 중";
  if (device.recording) return "촬영 중";
  if (device.video?.status === "uploading") return "영상 업로드 중";
  if (device.video?.status === "queued") return "분석 대기 중";
  if (device.video?.status === "converting") return "영상 준비 중";
  if (device.video?.status === "analyzing") return `선수 분석 중 ${device.video.progress || 0}%`;
  if (device.video?.status === "failed") return "분석 실패";
  if (device.video?.status === "ready") return "영상 준비 완료";
  return device.connected ? "연결됨 · 촬영 대기" : "연결 끊김";
}

function renderDevices() {
  deviceGrid.replaceChildren();
  for (const device of room.devices) {
    const card = document.createElement("div");
    card.className = "device-card";
    const icon = document.createElement("span");
    icon.className = "device-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "▣";
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = `${device.slot}번 촬영 기기${session.slot === device.slot ? " · 내 기기" : ""}`;
    const status = document.createElement("span");
    status.textContent = deviceStatus(device);
    copy.append(name, status);
    card.append(icon, copy);
    deviceGrid.append(card);
  }
  const mine = room.devices[session.slot - 1];
  videoInputs.forEach((input) => { input.disabled = Boolean(mine.video); });
  document.querySelectorAll(".upload-button").forEach((button) => {
    button.classList.toggle("disabled", Boolean(mine.video));
  });
  $("#upload-hint").textContent = mine.video
    ? "이 기기의 영상이 등록되었습니다. 새 영상을 촬영하려면 새 촬영방을 만들어 주세요."
    : "지금 촬영하거나 저장된 영상을 고르세요. 최대 500메가바이트까지 등록할 수 있습니다.";
}

function renderVideos() {
  videoList.replaceChildren();
  let count = 0;
  for (const device of room.devices) {
    if (!device.video) continue;
    count += 1;
    if (device.video.status === "ready") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `video-choice${currentSlot === device.slot ? " active" : ""}`;
      button.textContent = `${device.slot}번 기기 영상 보기`;
      button.addEventListener("click", () => openVideo(device.slot, device.video));
      videoList.append(button);
    } else {
      const note = document.createElement("span");
      note.className = "video-choice";
      note.textContent = `${device.slot}번 기기 · ${deviceStatus(device)}`;
      videoList.append(note);
      if (device.video.status === "failed") {
        const error = document.createElement("span");
        error.className = "video-error";
        error.textContent = device.video.error || "영상 분석에 실패했습니다.";
        videoList.append(error);
      }
    }
  }
  if (!count) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = "아직 등록된 영상이 없습니다. 두 휴대폰에서 경기를 촬영해 주세요.";
    videoList.append(empty);
  }
}

async function refreshRoom() {
  if (!session) return;
  try {
    room = await requestJson(`/api/rooms/${session.code}`);
    joinApproval.hidden = session.slot !== 1 || room.devices[1].joined;
    renderDevices();
    renderVideos();
  } catch (error) {
    if (error.message.includes("찾을 수 없습니다")) clearSession();
    showToast(error.message);
  }
}

document.querySelector('label[for="capture-file"]').addEventListener("click", () => {
  if (!session || captureInput.disabled) return;
  recording = true;
  sendHeartbeat();
});

window.addEventListener("focus", () => {
  setTimeout(() => {
    if (recording && !captureInput.files?.length) {
      recording = false;
      sendHeartbeat();
    }
  }, 1200);
});

async function uploadSelectedVideo(input) {
  recording = false;
  sendHeartbeat();
  const file = input.files?.[0];
  if (!file || !session) return;
  if (file.size > 500 * 1024 * 1024) {
    showToast("영상은 500메가바이트 이하만 등록할 수 있습니다.");
    input.value = "";
    return;
  }
  const body = new FormData();
  body.append("token", session.token);
  body.append("file", file);
  videoInputs.forEach((item) => { item.disabled = true; });
  $("#upload-hint").textContent = "영상을 업로드하고 있습니다. 화면을 닫지 마세요.";
  try {
    await requestJson(`/api/rooms/${session.code}/videos`, { method: "POST", body });
    showToast("영상이 등록되었습니다. 선수 분석이 끝날 때까지 기다려 주세요.");
    await refreshRoom();
  } catch (error) {
    showToast(error.message);
    videoInputs.forEach((item) => { item.disabled = false; });
  } finally {
    input.value = "";
  }
}

videoInputs.forEach((input) => {
  input.addEventListener("change", () => uploadSelectedVideo(input));
});

async function openVideo(slot, videoInfo) {
  if (currentSlot === slot && tracks) return;
  try {
    const data = await requestJson(videoInfo.tracks_url);
    if (!data.frames?.length) throw new Error("이 영상에는 분석할 프레임이 없습니다.");
    tracks = data;
    currentSlot = slot;
    selectedId = null;
    video.pause();
    video.src = videoInfo.media_url;
    video.load();
    playButton.textContent = "재생";
    seekRange.value = "0";
    $("#play-time").textContent = "0:00 / 0:00";
    viewer.hidden = false;
    focusLabel.textContent = "선수를 선택해 주세요";
    focusEmpty.hidden = false;
    viewerNotice.textContent = "원본 영상에서 선수의 표시를 누르면 따라보기가 시작됩니다.";
    renderVideos();
    viewer.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showToast(error.message);
  }
}

function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function updatePlaybackControls() {
  const duration = video.duration || 0;
  seekRange.value = duration ? String(Math.round(video.currentTime / duration * 1000)) : "0";
  $("#play-time").textContent = `${formatTime(video.currentTime)} / ${formatTime(duration)}`;
  playButton.textContent = video.paused ? "재생" : "일시정지";
  muteButton.textContent = video.muted ? "소리 켜기" : "소리 끄기";
}

playButton.addEventListener("click", async () => {
  try {
    if (video.paused) await video.play();
    else video.pause();
  } catch {
    showToast("영상을 재생할 수 없습니다.");
  }
  updatePlaybackControls();
});
muteButton.addEventListener("click", () => { video.muted = !video.muted; updatePlaybackControls(); });
seekRange.addEventListener("input", () => {
  if (video.duration) video.currentTime = Number(seekRange.value) / 1000 * video.duration;
  updatePlaybackControls();
});
for (const eventName of ["loadedmetadata", "timeupdate", "play", "pause", "ended"]) {
  video.addEventListener(eventName, updatePlaybackControls);
}

function sizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (width && height && (canvas.width !== width || canvas.height !== height)) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function nearbyFrames(time) {
  if (!tracks?.frames?.length) return null;
  const frames = tracks.frames;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (frames[middle].time <= time) low = middle;
    else high = middle - 1;
  }
  const left = frames[low];
  const right = frames[Math.min(low + 1, frames.length - 1)];
  return { left, right, nearest: Math.abs(left.time - time) <= Math.abs(right.time - time) ? left : right };
}

function boxForSelected(time) {
  if (selectedId === null) return null;
  const pair = nearbyFrames(time);
  if (!pair) return null;
  const left = pair.left.boxes.find((box) => box.id === selectedId);
  const right = pair.right.boxes.find((box) => box.id === selectedId);
  if (left && right && pair.right.time > pair.left.time && pair.right.time - pair.left.time < 0.8) {
    const part = Math.max(0, Math.min(1, (time - pair.left.time) / (pair.right.time - pair.left.time)));
    return left.box.map((value, index) => value + (right.box[index] - value) * part);
  }
  if (left && Math.abs(time - pair.left.time) < 0.45) return left.box;
  if (right && Math.abs(time - pair.right.time) < 0.45) return right.box;
  return null;
}

function videoGeometry(width, height) {
  const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
  return {
    left: (width - video.videoWidth * scale) / 2,
    top: (height - video.videoHeight * scale) / 2,
    width: video.videoWidth * scale,
    height: video.videoHeight * scale,
  };
}

function drawOverlay() {
  const { context, width, height } = sizeCanvas(selectionCanvas);
  context.clearRect(0, 0, width, height);
  if (!tracks || !video.videoWidth) return;
  const pair = nearbyFrames(video.currentTime);
  if (!pair || Math.abs(pair.nearest.time - video.currentTime) > 0.45) return;
  const area = videoGeometry(width, height);
  for (const player of pair.nearest.boxes) {
    const [x1, y1, x2, y2] = player.box;
    const x = area.left + x1 * area.width;
    const y = area.top + y1 * area.height;
    const boxWidth = (x2 - x1) * area.width;
    const boxHeight = (y2 - y1) * area.height;
    context.lineWidth = player.id === selectedId ? 3 : 2;
    context.strokeStyle = player.id === selectedId ? "#dafa79" : "#f5faf2";
    context.fillStyle = player.id === selectedId ? "#dafa79" : "#f5faf2";
    context.strokeRect(x, y, boxWidth, boxHeight);
    context.fillRect(x, Math.max(0, y - 20), 55, 20);
    context.fillStyle = "#132b1c";
    context.font = "bold 11px sans-serif";
    context.fillText(`선수 ${player.id}`, x + 4, Math.max(14, y - 6));
  }
}

function drawFocus() {
  const { context, width, height } = sizeCanvas(focusCanvas);
  context.fillStyle = "#07140d";
  context.fillRect(0, 0, width, height);
  if (!video.videoWidth || video.readyState < 2) return;
  let box = boxForSelected(video.currentTime);
  if (selectedId !== null && !box && Math.abs(video.currentTime - lastTrackedTime) > 0.8) {
    selectedId = null;
    focusLabel.textContent = "추적이 끊겼습니다";
    focusEmpty.textContent = "전체 경기 화면으로 돌아왔습니다. 선수를 다시 선택해 주세요.";
    viewerNotice.textContent = "선수가 가려졌거나 화면 밖으로 나갔습니다. 원본 화면에서 다시 선택해 주세요.";
  }
  if (selectedId !== null && box) {
    lastTrackedTime = video.currentTime;
    const aspect = width / height;
    let cropWidth = video.videoWidth / 2.25;
    let cropHeight = cropWidth / aspect;
    if (cropHeight > video.videoHeight) {
      cropHeight = video.videoHeight;
      cropWidth = cropHeight * aspect;
    }
    const centerX = ((box[0] + box[2]) / 2) * video.videoWidth;
    const centerY = ((box[1] + box[3]) / 2) * video.videoHeight;
    const left = Math.max(0, Math.min(video.videoWidth - cropWidth, centerX - cropWidth / 2));
    const top = Math.max(0, Math.min(video.videoHeight - cropHeight, centerY - cropHeight / 2));
    context.drawImage(video, left, top, cropWidth, cropHeight, 0, 0, width, height);
    focusEmpty.hidden = true;
  } else {
    context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, width, height);
    focusEmpty.hidden = selectedId !== null;
  }
}

selectionCanvas.addEventListener("click", (event) => {
  if (!tracks || !video.videoWidth) return;
  const pair = nearbyFrames(video.currentTime);
  if (!pair || Math.abs(pair.nearest.time - video.currentTime) > 0.45) {
    showToast("선수를 찾을 수 없는 구간입니다. 다른 시각에서 선택해 주세요.");
    return;
  }
  const rect = selectionCanvas.getBoundingClientRect();
  const area = videoGeometry(rect.width, rect.height);
  const x = (event.clientX - rect.left - area.left) / area.width;
  const y = (event.clientY - rect.top - area.top) / area.height;
  const hit = pair.nearest.boxes.find((player) => {
    const [x1, y1, x2, y2] = player.box;
    return x >= x1 && x <= x2 && y >= y1 && y <= y2;
  });
  if (!hit) {
    showToast("선수 표시 안쪽을 눌러 주세요.");
    return;
  }
  selectedId = hit.id;
  lastTrackedTime = video.currentTime;
  focusLabel.textContent = `선수 ${hit.id} 따라보는 중`;
  viewerNotice.textContent = `선수 ${hit.id}을(를) 따라보고 있습니다. 다른 선수를 누르면 선택이 바뀝니다.`;
  focusEmpty.hidden = true;
  drawOverlay();
  drawFocus();
});

function drawLoop() {
  if (!viewer.hidden) {
    drawOverlay();
    drawFocus();
  }
  requestAnimationFrame(drawLoop);
}

if (session?.code && session?.slot && session?.token) {
  setSession(session);
  sendHeartbeat();
  refreshRoom();
} else {
  clearSession();
}
setInterval(() => { sendHeartbeat(); refreshRoom(); checkPendingJoin(); }, 5000);
requestAnimationFrame(drawLoop);
