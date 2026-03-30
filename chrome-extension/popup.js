const DEFAULT_SERVER = "http://localhost:3131";

document.addEventListener("DOMContentLoaded", () => {
  const captureBtn = document.getElementById("captureBtn");
  const status = document.getElementById("status");
  const connectionDiv = document.getElementById("connection");
  const connectionText = document.getElementById("connectionText");
  const serverUrlInput = document.getElementById("serverUrl");

  let serverUrl = DEFAULT_SERVER;
  let captureConfig = null;

  // Restore saved server URL
  chrome.storage.local.get(["serverUrl"], (data) => {
    if (data.serverUrl) {
      serverUrl = data.serverUrl;
      serverUrlInput.value = serverUrl;
    } else {
      serverUrlInput.value = DEFAULT_SERVER;
    }
    checkServer();
  });

  // Save server URL on change
  serverUrlInput.addEventListener("change", () => {
    serverUrl = serverUrlInput.value.trim() || DEFAULT_SERVER;
    chrome.storage.local.set({ serverUrl });
    checkServer();
  });

  async function checkServer() {
    try {
      // Check server is running
      const statusResp = await fetch(`${serverUrl}/status`, { signal: AbortSignal.timeout(2000) });
      if (!statusResp.ok) throw new Error("Server not responding");

      // Check if capture config is available
      const configResp = await fetch(`${serverUrl}/capture-config`, { signal: AbortSignal.timeout(2000) });
      if (configResp.ok) {
        captureConfig = await configResp.json();
        connectionDiv.className = "connection ready";
        connectionText.textContent = "Ready to capture";
        captureBtn.disabled = false;
      } else {
        captureConfig = null;
        connectionDiv.className = "connection connected";
        connectionText.textContent = "Server connected — no capture prepared";
        captureBtn.disabled = true;
        status.textContent = "Ask Claude Code to run generate_figma_design and POST to /prepare-capture.";
        status.className = "info";
      }
    } catch (err) {
      captureConfig = null;
      connectionDiv.className = "connection disconnected";
      connectionText.textContent = "Server not running";
      captureBtn.disabled = true;
      status.textContent = "Start the server with: npm start";
      status.className = "info";
    }
  }

  captureBtn.addEventListener("click", async () => {
    if (!captureConfig) {
      status.textContent = "No capture config available.";
      status.className = "error";
      return;
    }

    status.textContent = "Capturing...";
    status.className = "";
    captureBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        action: "capture",
        captureId: captureConfig.captureId,
        endpoint: captureConfig.endpoint,
      });

      if (response.success) {
        status.textContent = "Capture sent to Figma!";
        status.className = "success";

        // Clear the used config from the server
        fetch(`${serverUrl}/capture-config`, { method: "DELETE" }).catch(() => {});
        captureConfig = null;

        // Re-check server state after a moment
        setTimeout(checkServer, 2000);
      } else {
        status.textContent = `Error: ${response.error}`;
        status.className = "error";
        captureBtn.disabled = false;
      }
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      status.className = "error";
      captureBtn.disabled = false;
    }
  });

  // Poll server every 3 seconds for new capture configs
  setInterval(checkServer, 3000);
});
