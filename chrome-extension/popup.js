document.addEventListener("DOMContentLoaded", () => {
  const captureView = document.getElementById("captureView");
  const setupView = document.getElementById("setupView");
  const captureBtn = document.getElementById("captureBtn");
  const status = document.getElementById("status");
  const setupCommand = document.getElementById("setupCommand");
  const copyBtn = document.getElementById("copyBtn");
  const retryBtn = document.getElementById("retryBtn");

  function showSetup() {
    const extId = chrome.runtime.id;
    setupCommand.textContent = `./native-host/install.sh ${extId}`;
    captureView.style.display = "none";
    setupView.style.display = "block";
  }

  function showCapture() {
    captureView.style.display = "block";
    setupView.style.display = "none";
  }

  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(setupCommand.textContent);
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  });

  retryBtn.addEventListener("click", () => {
    showCapture();
    status.textContent = "";
    status.className = "";
  });

  captureBtn.addEventListener("click", async () => {
    status.textContent = "Capturing... (may take ~10s)";
    status.className = "";
    captureBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({ action: "capture" });

      if (response.success) {
        status.textContent = "Sent to Figma!";
        status.className = "success";
      } else if (response.error?.includes("native messaging host not found")) {
        showSetup();
      } else {
        status.textContent = response.error;
        status.className = "error";
      }
    } catch (err) {
      if (err.message?.includes("native messaging host not found")) {
        showSetup();
      } else {
        status.textContent = err.message;
        status.className = "error";
      }
    } finally {
      captureBtn.disabled = false;
    }
  });
});
