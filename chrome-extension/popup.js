document.addEventListener("DOMContentLoaded", () => {
  const captureView = document.getElementById("captureView");
  const setupView = document.getElementById("setupView");
  const howItWorksView = document.getElementById("howItWorksView");
  const footer = document.getElementById("footer");
  const captureBtn = document.getElementById("captureBtn");
  const status = document.getElementById("status");
  const progress = document.getElementById("progress");
  const steps = progress.querySelectorAll(".step");
  const setupCommand = document.getElementById("setupCommand");
  const copyBtn = document.getElementById("copyBtn");
  const copyMcpBtn = document.getElementById("copyMcpBtn");
  const retryBtn = document.getElementById("retryBtn");
  const howItWorksLink = document.getElementById("howItWorksLink");
  const howBackLink = document.getElementById("howBackLink");
  const setupLearnMore = document.getElementById("setupLearnMore");

  let closeTimeout = null;
  let previousView = "capture"; // track which view to return to from "how it works"

  function showView(view) {
    captureView.style.display = view === "capture" ? "block" : "none";
    setupView.style.display = view === "setup" ? "block" : "none";
    howItWorksView.style.display = view === "how" ? "block" : "none";
    footer.style.display = view === "how" ? "none" : "block";
  }

  function showSetup() {
    const extId = chrome.runtime.id;
    setupCommand.textContent = `curl -fsSL https://raw.githubusercontent.com/joesteinkamp/web-to-figma/main/setup.sh | bash -s -- ${extId}`;
    showView("setup");
  }

  function showCapture() {
    showView("capture");
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
      // Loading for 3s, then check, then 8s to close
      setTimeout(() => {
        const step3 = progress.querySelector('[data-step="3"]');
        step3.className = "step done";
        step3.querySelector(".step-icon").textContent = "\u2713";
        closeTimeout = setTimeout(() => window.close(), 5000);
      }, 6000);
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

  // Copy setup command
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(setupCommand.textContent);
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  });

  // Copy MCP config
  copyMcpBtn.addEventListener("click", () => {
    const mcpConfig = document.getElementById("mcpConfig").textContent;
    navigator.clipboard.writeText(mcpConfig);
    copyMcpBtn.textContent = "Copied!";
    setTimeout(() => { copyMcpBtn.textContent = "Copy"; }, 1500);
  });

  retryBtn.addEventListener("click", () => {
    showCapture();
    resetUI();
  });

  // "How this works" link — always visible in footer
  howItWorksLink.addEventListener("click", (e) => {
    e.preventDefault();
    previousView = setupView.style.display === "block" ? "setup" : "capture";
    showView("how");
  });

  // Back link from "how it works"
  howBackLink.addEventListener("click", (e) => {
    e.preventDefault();
    if (previousView === "setup") {
      showSetup();
    } else {
      showCapture();
    }
  });

  // "Learn more" link in setup view
  setupLearnMore.addEventListener("click", (e) => {
    e.preventDefault();
    previousView = "setup";
    showView("how");
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
