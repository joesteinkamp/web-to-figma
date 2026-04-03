document.addEventListener("DOMContentLoaded", () => {
  const captureView = document.getElementById("captureView");
  const setupView = document.getElementById("setupView");
  const captureBtn = document.getElementById("captureBtn");
  const status = document.getElementById("status");
  const progress = document.getElementById("progress");
  const steps = progress.querySelectorAll(".step");
  const setupCommand = document.getElementById("setupCommand");
  const copyBtn = document.getElementById("copyBtn");
  const retryBtn = document.getElementById("retryBtn");

  let closeTimeout = null;

  function showSetup() {
    const extId = chrome.runtime.id;
    setupCommand.textContent = `curl -fsSL https://raw.githubusercontent.com/joesteinkamp/web-to-figma/main/setup.sh | bash -s -- ${extId}`;
    captureView.style.display = "none";
    setupView.style.display = "block";
  }

  function showCapture() {
    captureView.style.display = "block";
    setupView.style.display = "none";
  }

  function startProgressUI() {
    captureBtn.style.display = "none";
    progress.style.display = "block";
    status.textContent = "";
    status.className = "";
  }

  function resetUI() {
    captureBtn.style.display = "";
    captureBtn.disabled = false;
    progress.style.display = "none";
    steps.forEach((s) => { s.className = "step"; });
    if (closeTimeout) { clearTimeout(closeTimeout); closeTimeout = null; }
  }

  function setStep(n) {
    steps.forEach((s) => {
      const stepNum = parseInt(s.dataset.step);
      if (stepNum < n) {
        s.className = "step done";
        s.querySelector(".step-icon").textContent = "\u2713";
      } else if (stepNum === n) {
        s.className = "step active";
        s.querySelector(".step-icon").textContent = "*";
      } else {
        s.className = "step";
        s.querySelector(".step-icon").textContent = "*";
      }
    });

    if (n === 3) {
      closeTimeout = setTimeout(() => window.close(), 8000);
    }
  }

  // Listen for progress broadcasts from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action !== "capture-progress") return;

    if (msg.error) {
      resetUI();
      if (msg.error.includes("native messaging host not found")) {
        showSetup();
      } else {
        status.textContent = msg.error;
        status.className = "error";
      }
      return;
    }

    startProgressUI();
    setStep(msg.step);
  });

  // Restore state if popup reopened mid-capture
  chrome.runtime.sendMessage({ action: "capture-status" }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp?.active) {
      startProgressUI();
      setStep(resp.step);
    }
  });

  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(setupCommand.textContent);
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  });

  retryBtn.addEventListener("click", () => {
    showCapture();
    resetUI();
  });

  captureBtn.addEventListener("click", () => {
    startProgressUI();
    setStep(1);

    chrome.runtime.sendMessage({ action: "capture" }, (response) => {
      if (chrome.runtime.lastError) {
        resetUI();
        status.textContent = chrome.runtime.lastError.message;
        status.className = "error";
        return;
      }
      if (response?.error) {
        resetUI();
        if (response.error.includes("native messaging host not found")) {
          showSetup();
        } else {
          status.textContent = response.error;
          status.className = "error";
        }
      }
      // Success handled via capture-progress listener
    });
  });
});
