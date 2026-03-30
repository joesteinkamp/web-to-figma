document.addEventListener("DOMContentLoaded", () => {
  const setupView = document.getElementById("setupView");
  const captureView = document.getElementById("captureView");
  const tokenInput = document.getElementById("tokenInput");
  const saveTokenBtn = document.getElementById("saveTokenBtn");
  const captureBtn = document.getElementById("captureBtn");
  const status = document.getElementById("status");
  const logoutLink = document.getElementById("logoutLink");

  function showSetup() {
    setupView.style.display = "block";
    captureView.style.display = "none";
  }

  function showCapture() {
    setupView.style.display = "none";
    captureView.style.display = "block";
  }

  // Check if token exists
  chrome.runtime.sendMessage({ action: "checkAuth" }, (resp) => {
    if (resp?.authenticated) {
      showCapture();
    } else {
      showSetup();
    }
  });

  // Save token
  saveTokenBtn.addEventListener("click", () => {
    const token = tokenInput.value.trim();
    if (!token) return;

    chrome.runtime.sendMessage({ action: "saveToken", token }, () => {
      showCapture();
    });
  });

  // Also save on Enter
  tokenInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveTokenBtn.click();
  });

  // Capture
  captureBtn.addEventListener("click", async () => {
    status.textContent = "Capturing...";
    status.className = "";
    captureBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({ action: "capture" });

      if (response.success) {
        status.textContent = "Sent to Figma!";
        status.className = "success";
      } else {
        if (response.error === "NO_TOKEN") {
          showSetup();
          return;
        }
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

  // Logout
  logoutLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ action: "logout" }, () => {
      showSetup();
      status.textContent = "";
    });
  });
});
