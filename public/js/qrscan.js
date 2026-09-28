// Leitor de QR pela câmera (celular ou webcam). Usa BarcodeDetector quando existe e jsQR como alternativa.
window.QRScan = (() => {
  const insecure = () => !window.isSecureContext;
  async function start(video, onResult) {
    if (insecure()) throw new Error('INSECURE');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('NOCAM');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    await video.play();
    let detector = null;
    try { if ('BarcodeDetector' in window) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch {}
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let stopped = false, busy = false;
    const timer = setInterval(async () => {
      if (stopped || busy || video.readyState < 2) return;
      busy = true;
      try {
        let text = null;
        if (detector) {
          const codes = await detector.detect(video);
          if (codes[0]) text = codes[0].rawValue;
        } else if (window.jsQR) {
          const w = video.videoWidth, hgt = video.videoHeight;
          const scale = Math.min(1, 640 / w);
          canvas.width = w * scale; canvas.height = hgt * scale;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (code) text = code.data;
        }
        if (text && !stopped) { stop(); onResult(text); }
      } catch {} finally { busy = false; }
    }, 250);
    function stop() {
      stopped = true; clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }
    return stop;
  }
  /** Extrai o token de um texto lido (URL .../checkin?t=xxx ou o token puro). */
  function tokenFrom(text) {
    try { const u = new URL(text); if (/\/checkin$/.test(u.pathname)) return u.searchParams.get('t'); } catch {}
    return /^[a-f0-9]{16,40}$/.test(text) ? text : null;
  }
  const cameraError = (e) => e.message === 'INSECURE'
    ? 'A câmera do navegador só funciona em endereço seguro (https ou localhost). Pelo celular, use o aplicativo de câmera para ler o QR da porta.'
    : e.name === 'NotAllowedError' ? 'Permissão da câmera negada. Libere o acesso à câmera nas configurações do navegador.'
    : e.name === 'NotFoundError' || e.message === 'NOCAM' ? 'Nenhuma câmera encontrada neste dispositivo.'
    : 'Não foi possível abrir a câmera.';
  return { start, tokenFrom, cameraError };
})();
