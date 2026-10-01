const liveStart = document.querySelector("#start-live");
const liveStop = document.querySelector("#stop-live");
const liveStatus = document.querySelector("#live-broadcast-status");
const livePreview = document.querySelector("#live-preview");

let liveSocket = null;
let liveStream = null;
const livePeers = new Map();
const pendingLiveCandidates = new Map();

function sendLive(message) {
  if (liveSocket?.readyState === WebSocket.OPEN) liveSocket.send(JSON.stringify(message));
}

function endLive(message = "라이브 대기 중") {
  const socket = liveSocket;
  liveSocket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  for (const peer of livePeers.values()) peer.close();
  livePeers.clear();
  pendingLiveCandidates.clear();
  liveStream?.getTracks().forEach((track) => track.stop());
  liveStream = null;
  livePreview.srcObject = null;
  livePreview.hidden = true;
  liveStart.hidden = false;
  liveStart.disabled = false;
  liveStop.hidden = true;
  liveStatus.textContent = message;
}

async function addLiveCandidate(viewerId, candidate) {
  const peer = livePeers.get(viewerId);
  if (!peer) return;
  if (peer.remoteDescription) {
    await peer.addIceCandidate(candidate);
  } else {
    const waiting = pendingLiveCandidates.get(viewerId) || [];
    waiting.push(candidate);
    pendingLiveCandidates.set(viewerId, waiting);
  }
}

async function offerLive(viewerId) {
  if (!liveStream) return;
  const peer = new RTCPeerConnection({ iceServers: [] });
  livePeers.set(viewerId, peer);
  liveStream.getTracks().forEach((track) => peer.addTrack(track, liveStream));
  peer.onicecandidate = (event) => {
    if (event.candidate) sendLive({ type: "candidate", viewer_id: viewerId, candidate: event.candidate.toJSON() });
  };
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  sendLive({ type: "offer", viewer_id: viewerId, sdp: peer.localDescription });
}

async function handleLiveMessage(message) {
  const id = message.viewer_id;
  if (message.type === "published") {
    liveStatus.textContent = "라이브 중 · 시청자는 라이브 방 보기에서 입장할 수 있습니다.";
    liveStart.hidden = true;
    liveStop.hidden = false;
  } else if (message.type === "viewer_joined") {
    await offerLive(id);
  } else if (message.type === "viewer_left") {
    livePeers.get(id)?.close();
    livePeers.delete(id);
    pendingLiveCandidates.delete(id);
  } else if (message.type === "answer") {
    const peer = livePeers.get(id);
    if (!peer) return;
    await peer.setRemoteDescription(message.sdp);
    for (const candidate of pendingLiveCandidates.get(id) || []) await peer.addIceCandidate(candidate);
    pendingLiveCandidates.delete(id);
  } else if (message.type === "candidate") {
    await addLiveCandidate(id, message.candidate);
  } else if (message.type === "error") {
    endLive(message.message);
  }
}

liveStart.addEventListener("click", async () => {
  if (!session) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    liveStatus.textContent = "카메라를 사용할 수 없습니다. 휴대폰에서는 HTTPS 주소로 접속해 주세요.";
    return;
  }
  liveStart.disabled = true;
  liveStatus.textContent = "카메라 연결 중…";
  try {
    try {
      liveStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }, audio: true,
      });
    } catch (error) {
      if (error.name !== "NotFoundError" && error.name !== "NotAllowedError") throw error;
      liveStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }, audio: false,
      });
    }
    livePreview.srcObject = liveStream;
    livePreview.hidden = false;
    await livePreview.play();
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${location.host}/ws/rooms/${session.code}/live`);
    liveSocket = socket;
    socket.onopen = () => sendLive({ type: "publish", token: session.token });
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      handleLiveMessage(message).catch(() => {
        livePeers.get(message.viewer_id)?.close();
        livePeers.delete(message.viewer_id);
        pendingLiveCandidates.delete(message.viewer_id);
        liveStatus.textContent = "라이브 중 · 한 시청자의 연결에 실패했습니다.";
      });
    };
    socket.onerror = () => { liveStatus.textContent = "라이브 서버에 연결하지 못했습니다."; };
    socket.onclose = () => { if (liveSocket === socket) endLive("라이브가 종료되었습니다."); };
  } catch (error) {
    endLive(`카메라를 시작하지 못했습니다: ${error.message}`);
  }
});

liveStop.addEventListener("click", () => endLive("라이브가 종료되었습니다."));
window.addEventListener("room-session-cleared", () => endLive());
window.addEventListener("beforeunload", () => endLive());
