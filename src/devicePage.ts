export const DEVICE_PAGE_HTML = `<!doctype html>
<html lang="nl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Elewijtse Pijl 2026 - Aanmelden</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f5f5f5;
    padding: 2rem;
    box-sizing: border-box;
  }
  main {
    width: 100%;
    max-width: 420px;
    background: white;
    border-radius: 12px;
    padding: 2rem;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
    text-align: center;
    box-sizing: border-box;
  }
  h1 { font-size: 1.3rem; margin: 0 0 1.5rem; color: #003da5; }
  #qr-container { display: flex; justify-content: center; margin-bottom: 1.5rem; min-height: 200px; align-items: center; }
  #qr-container svg { width: 200px; height: 200px; }
  .user-code {
    font-size: 2rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    color: #003da5;
    margin: 0 0 1rem;
  }
  .hint { color: #666; font-size: 0.9rem; margin: 0 0 0.5rem; }
  .status { font-weight: 600; margin: 1rem 0 0; }
  .status.error { color: #c0392b; }
  .status.complete { color: #1e9e4d; }
  button {
    margin-top: 1rem;
    font-size: 1rem;
    padding: 0.7rem 1.2rem;
    border: none;
    border-radius: 6px;
    background: #003da5;
    color: white;
    cursor: pointer;
  }
  button[hidden] { display: none; }
</style>
</head>
<body>
  <main>
    <h1>Elewijtse Pijl 2026</h1>
    <div id="qr-container"></div>
    <p class="user-code" id="user-code">------</p>
    <p class="hint">Scan de QR-code met je telefoon, of ga naar de getoonde link en voer de code in.</p>
    <p class="status" id="status">Code aanmaken...</p>
    <button id="retry-btn" type="button" hidden>Opnieuw proberen</button>
  </main>

  <script src="/device/qrcode.js"></script>
  <script>
    const qrContainer = document.getElementById('qr-container');
    const userCodeEl = document.getElementById('user-code');
    const statusEl = document.getElementById('status');
    const retryBtn = document.getElementById('retry-btn');

    let pollTimer = null;

    function setStatus(text, className) {
      statusEl.textContent = text;
      statusEl.className = 'status' + (className ? ' ' + className : '');
    }

    function stopPolling() {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
    }

    async function schedulePoll(pollId, intervalSeconds) {
      pollTimer = setTimeout(async () => {
        try {
          const res = await fetch('/device/poll?id=' + encodeURIComponent(pollId));
          const data = await res.json();

          if (data.status === 'complete') {
            setStatus('Aangemeld! Doorsturen...', 'complete');
            window.location.href = '/';
            return;
          }

          if (data.status === 'error') {
            stopPolling();
            setStatus(data.message || 'Aanmelden mislukt.', 'error');
            retryBtn.hidden = false;
            return;
          }

          setStatus('Wachten op bevestiging op je telefoon...');
          schedulePoll(pollId, data.interval || intervalSeconds);
        } catch (err) {
          setStatus('Verbinding mislukt, opnieuw proberen...', 'error');
          schedulePoll(pollId, intervalSeconds);
        }
      }, intervalSeconds * 1000);
    }

    async function start() {
      stopPolling();
      retryBtn.hidden = true;
      qrContainer.innerHTML = '';
      userCodeEl.textContent = '------';
      setStatus('Code aanmaken...');

      try {
        const res = await fetch('/device/start', { method: 'POST' });
        const data = await res.json();

        if (!res.ok || data.error) {
          setStatus(data.error || 'Kon apparaatcode niet aanmaken.', 'error');
          retryBtn.hidden = false;
          return;
        }

        userCodeEl.textContent = data.userCode;
        QRCode.toString(data.verificationUriComplete, { type: 'svg', margin: 1 }, (err, svg) => {
          if (!err) qrContainer.innerHTML = svg;
        });
        setStatus('Wachten op bevestiging op je telefoon...');
        schedulePoll(data.pollId, data.interval);
      } catch (err) {
        setStatus('Kon apparaatcode niet aanmaken.', 'error');
        retryBtn.hidden = false;
      }
    }

    retryBtn.addEventListener('click', start);
    start();
  </script>
</body>
</html>
`;
