const liveRoomList = document.querySelector("#live-room-list");
const livePlayerPanel = document.querySelector("#live-player-panel");
const livePlayer = document.querySelector("#live-player");
const liveWatchStatus = document.querySelector("#live-watch-status");
const resumeLive = document.querySelector("#resume-live");

let watchSocket = null;
let watchPeer = null;
let waitingCandidates = [];

function sendWatch(message) {
  if (watchSocket?.readyState === WebSocket.OPEN) watchSocket.send(JSON.stringify(message));
}

function stopWatching(message = "") {
  const socket = watchSocket;
  watchSocket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  watchPeer?.close();
  watchPeer = null;
  waitingCandidates = [];
  livePlayer.pause();
  livePlayer.srcObject = null;
  livePlayerPanel.hidden = true;
  if (message) liveRoomList.textContent = message;
  refreshLiveRooms();
}

async function refreshLiveRooms() {
  try {
    const response = await fetch("/api/live/rooms");
    if (!response.ok) throw new Error("라이브 방 목록을 가져오지 못했습니다.");
    const rooms = await response.json();
    liveRoomList.replaceChildren();
    if (!rooms.length) {
      liveRoomList.textContent = "현재 라이브 중인 방이 없습니다.";
      return;
    }
    for (const room of rooms) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button button-secondary";
      button.textContent = `라이브 방 ${room.id.slice(0, 6)} · ${room.slot}번 기기 · 시청자 ${room.viewers}명`;
      button.addEventListener("click", () => watchRoom(room.id));
      liveRoomList.append(button);
    }
  } catch (error) {
    liveRoomList.textContent = error.message;
  }
}

async function handleWatchMessage(message) {
  if (message.type === "watching") {
    liveWatchStatus.textContent = "영상 연결 중…";
  } else if (message.type === "offer") {
    const peer = new RTCPeerConnection({ iceServers: [] });
    watchPeer = peer;
    peer.ontrack = async (event) => {
      livePlayer.srcObject = event.streams[0] || new MediaStream([event.track]);
      try {
        await livePlayer.play();
        liveWatchStatus.textContent = "라이브 시청 중";
        resumeLive.hidden = true;
      } catch {
        liveWatchStatus.textContent = "재생하기를 눌러 영상을 시작해 주세요.";
        resumeLive.hidden = false;
      }
    };
    peer.onicecandidate = (event) => {
      if (event.candidate) sendWatch({ type: "candidate", candidate: event.candidate.toJSON() });
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") liveWatchStatus.textContent = "영상 연결에 실패했습니다. 같은 와이파이인지 확인해 주세요.";
    };
    await peer.setRemoteDescription(message.sdp);
    for (const candidate of waitingCandidates) await peer.addIceCandidate(candidate);
    waitingCandidates = [];
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    sendWatch({ type: "answer", sdp: peer.localDescription });
  } else if (message.type === "candidate") {
    if (watchPeer?.remoteDescription) await watchPeer.addIceCandidate(message.candidate);
    else waitingCandidates.push(message.candidate);
  } else if (message.type === "ended" || message.type === "error") {
    stopWatching(message.message || "라이브가 종료되었습니다.");
  }
}

function watchRoom(liveId) {
  stopWatching();
  livePlayerPanel.hidden = false;
  document.querySelector("#live-player-title").textContent = `라이브 방 ${liveId.slice(0, 6)}`;
  liveWatchStatus.textContent = "연결 중…";
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${scheme}//${location.host}/ws/live/${liveId}`);
  watchSocket = socket;
  socket.onopen = () => sendWatch({ type: "view" });
  socket.onmessage = (event) => {
    handleWatchMessage(JSON.parse(event.data)).catch((error) => {
      liveWatchStatus.textContent = `영상 연결 오류: ${error.message}`;
    });
  };
  socket.onclose = () => {
    if (watchSocket === socket) stopWatching("라이브 연결이 종료되었습니다.");
  };
}

resumeLive.addEventListener("click", async () => {
  try {
    await livePlayer.play();
    resumeLive.hidden = true;
    liveWatchStatus.textContent = "라이브 시청 중";
  } catch (error) {
    liveWatchStatus.textContent = `재생할 수 없습니다: ${error.message}`;
  }
});
document.querySelector("#leave-live").addEventListener("click", () => stopWatching());
window.addEventListener("beforeunload", () => stopWatching());
refreshLiveRooms();
setInterval(refreshLiveRooms, 5000);
