document.addEventListener("DOMContentLoaded", () => {
  const setupView = document.getElementById("setupView");
  const captureView = document.getElementById("captureView");
  const captureBtn = document.getElementById("captureBtn");
  const retryBtn = document.getElementById("retryBtn");
  const status = document.getElementById("status");

  function showSetup() {
    setupView.style.display = "block";
    captureView.style.display = "none";
  }

  function showCapture() {
    setupView.style.display = "none";
    captureView.style.display = "block";
  }

  function checkServer() {
    chrome.runtime.sendMessage({ action: "checkServer" }, (resp) => {
      if (resp?.running) {
        showCapture();
      } else {
        showSetup();
      }
    });
  }

  checkServer();

  retryBtn.addEventListener("click", checkServer);

  captureBtn.addEventListener("click", async () => {
    status.textContent = "Capturing... (may take ~10s)";
    status.className = "";
    captureBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({ action: "capture" });

      if (response.success) {
        status.textContent = "Sent to Figma!";
        status.className = "success";
      } else {
        status.textContent = response.error;
        status.className = "error";
      }
    } catch (err) {
      status.textContent = err.message;
      status.className = "error";
    } finally {
      captureBtn.disabled = false;
    }
  });
});
