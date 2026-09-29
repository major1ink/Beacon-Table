// Сведения о видео-фоне для отчёта о баге: какие кодеки знает браузер и что с кадрами.

const CODECS = [
  ["h264 4K", 'video/mp4; codecs="avc1.640033"'],
  ["h264 FHD", 'video/mp4; codecs="avc1.640028"'],
  ["vp9", 'video/webm; codecs="vp9"'],
  ["vp8", 'video/webm; codecs="vp8"'],
  ["av1", 'video/mp4; codecs="av01.0.08M.08"'],
  ["hevc", 'video/mp4; codecs="hvc1.1.6.L153.B0"'],
];

const BLACK_LEVEL = 8;

export function codecSupport() {
  const v = document.createElement("video");
  return CODECS.map(([name, type]) => `${name}: ${v.canPlayType(type) || "нет"}`).join(", ");
}

// isBlackFrame — все пиксели RGBA-данных почти чёрные.
export function isBlackFrame(data) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] >= BLACK_LEVEL || data[i + 1] >= BLACK_LEVEL || data[i + 2] >= BLACK_LEVEL) return false;
  }
  return true;
}

// frameIsBlack — "да", "нет" или причина, почему проверить не вышло.
export function frameIsBlack(video) {
  if (!video.videoWidth) return "нет кадров";
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    const c2d = canvas.getContext("2d");
    c2d.drawImage(video, 0, 0, canvas.width, canvas.height);
    return isBlackFrame(c2d.getImageData(0, 0, canvas.width, canvas.height).data) ? "да" : "нет";
  } catch {
    return "не удалось прочитать";
  }
}

export function describeVideo(video) {
  const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
  const frames = q ? `${q.totalVideoFrames}, пропущено ${q.droppedVideoFrames}` : "?";
  const error = video.error ? video.error.code : "нет";
  return {
    video: `${video.videoWidth}×${video.videoHeight}, readyState ${video.readyState}, network ${video.networkState}, кадров ${frames}, время ${video.currentTime.toFixed(1)}, ошибка ${error}`,
    videoBlack: frameIsBlack(video),
  };
}

// videoReadsDirect — отдаёт ли браузер кадр видео прямой заливкой в WebGL
// (без промежуточного 2D-canvas): заливает кадр в текстуру и читает несколько пикселей.
export function videoReadsDirect(video) {
  if (!video.videoWidth) return false;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl");
  if (!gl) return false;
  try {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
    const px = new Uint8Array(4);
    for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]]) {
      gl.readPixels(Math.floor(video.videoWidth * fx), Math.floor(video.videoHeight * fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (px[0] >= BLACK_LEVEL || px[1] >= BLACK_LEVEL || px[2] >= BLACK_LEVEL) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
  }
}
