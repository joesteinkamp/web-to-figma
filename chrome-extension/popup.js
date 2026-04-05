document.addEventListener("DOMContentLoaded", () => {
  const captureView = document.getElementById("captureView");
  const setupView = document.getElementById("setupView");
  const howItWorksView = document.getElementById("howItWorksView");
  const footer = document.getElementById("footer");
  const captureBtn = document.getElementById("captureBtn");
  const status = document.getElementById("status");
  const progress = document.getElementById("progress");
  let steps = progress.querySelectorAll(".step");
  const setupCommand = document.getElementById("setupCommand");
  const copyBtn = document.getElementById("copyBtn");
  const copyMcpBtn = document.getElementById("copyMcpBtn");
  const retryBtn = document.getElementById("retryBtn");
  const howItWorksLink = document.getElementById("howItWorksLink");
  const howBackLink = document.getElementById("howBackLink");
  const setupLearnMore = document.getElementById("setupLearnMore");
  const saveToExisting = document.getElementById("saveToExisting");
  const fileUrlInput = document.getElementById("fileUrlInput");
  const fileUrlGroup = document.getElementById("fileUrlGroup");
  const captureOptions = document.getElementById("captureOptions");
  const useDesignSystem = document.getElementById("useDesignSystem");
  const dsOptionRow = document.getElementById("dsOptionRow");

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
    captureOptions.style.display = "";
    progress.style.display = "none";
    // Remove dynamically added DS steps
    progress.querySelectorAll(".step.ds-step").forEach((s) => s.remove());
    steps = progress.querySelectorAll(".step");
    steps.forEach((s) => { s.className = "step"; });
    if (closeTimeout) { clearTimeout(closeTimeout); closeTimeout = null; }
  }

  function setStep(n) {
    steps = progress.querySelectorAll(".step");
    const totalSteps = steps.length;
    steps.forEach((s) => {
      const stepNum = parseInt(s.dataset.step);
      if (stepNum < n) {
        s.className = s.classList.contains("ds-step") ? "step done ds-step" : "step done";
        s.querySelector(".step-icon").textContent = "\u2713";
      } else if (stepNum === n) {
        s.className = s.classList.contains("ds-step") ? "step active ds-step" : "step active";
        s.querySelector(".step-icon").textContent = "*";
      } else {
        s.className = s.classList.contains("ds-step") ? "step ds-step" : "step";
        s.querySelector(".step-icon").textContent = "*";
      }
    });

    if (n === totalSteps) {
      // Final step — mark done after delay, then auto-close
      setTimeout(() => {
        const lastStep = progress.querySelector(`[data-step="${totalSteps}"]`);
        if (lastStep) {
          lastStep.className = lastStep.classList.contains("ds-step") ? "step done ds-step" : "step done";
          lastStep.querySelector(".step-icon").textContent = "\u2713";
        }
        closeTimeout = setTimeout(() => window.close(), 5000);
      }, 6000);
    }
  }

  function addDesignSystemSteps() {
    // Relabel static steps for DS mode
    const relabel = { 1: "Connecting to Claude Code", 2: "Connecting to Figma", 3: "Searching design system" };
    progress.querySelectorAll(".step").forEach((s) => {
      const n = parseInt(s.dataset.step);
      if (relabel[n]) s.querySelector(".step-text").textContent = relabel[n];
    });
    const dsSteps = [
      { step: 4, text: "Building with components" },
      { step: 5, text: "Finalizing design" },
      { step: 6, text: "Design ready in Figma" },
    ];
    dsSteps.forEach(({ step, text }) => {
      const div = document.createElement("div");
      div.className = "step ds-step";
      div.dataset.step = step;
      div.innerHTML = `<span class="step-icon">*</span><span class="step-text">${text}</span><span class="step-dots"></span>`;
      progress.appendChild(div);
    });
    steps = progress.querySelectorAll(".step");
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
      if (resp.dsMode) addDesignSystemSteps();
      startProgressUI();
      captureOptions.style.display = "none";
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

  function updateDsVisibility() {
    const show = saveToExisting.checked && fileUrlInput.value.trim().length > 0;
    dsOptionRow.style.display = show ? "flex" : "none";
    if (!show) useDesignSystem.checked = false;
  }

  // Toggle file URL input visibility
  saveToExisting.addEventListener("change", () => {
    fileUrlGroup.style.display = saveToExisting.checked ? "block" : "none";
    chrome.storage.local.set({ saveToExisting: saveToExisting.checked });
    updateDsVisibility();
    if (saveToExisting.checked) fileUrlInput.focus();
  });

  // Persist file URL on input
  fileUrlInput.addEventListener("input", () => {
    chrome.storage.local.set({ fileUrl: fileUrlInput.value });
    updateDsVisibility();
  });

  // Persist DS checkbox
  useDesignSystem.addEventListener("change", () => {
    chrome.storage.local.set({ useDesignSystem: useDesignSystem.checked });
  });

  // Restore saved state
  chrome.storage.local.get(["saveToExisting", "fileUrl", "useDesignSystem"], (data) => {
    if (data.saveToExisting) {
      saveToExisting.checked = true;
      fileUrlGroup.style.display = "block";
    }
    if (data.fileUrl) fileUrlInput.value = data.fileUrl;
    if (data.useDesignSystem) useDesignSystem.checked = true;
    updateDsVisibility();
  });

  function isValidFigmaUrl(url) {
    return /^https:\/\/(www\.)?figma\.com\/(design|file)\//.test(url);
  }

  captureBtn.addEventListener("click", () => {
    // Validate file URL if "Save to existing" is checked
    if (saveToExisting.checked) {
      const url = fileUrlInput.value.trim();
      if (!url) {
        status.textContent = "Enter a Figma file URL";
        status.className = "error";
        fileUrlInput.focus();
        return;
      }
      if (!isValidFigmaUrl(url)) {
        status.textContent = "Invalid Figma URL (expected figma.com/design/... or figma.com/file/...)";
        status.className = "error";
        fileUrlInput.focus();
        return;
      }
    }

    const dsMode = saveToExisting.checked && useDesignSystem.checked;

    startProgressUI();
    captureOptions.style.display = "none";
    if (dsMode) addDesignSystemSteps();
    setStep(1);

    const msg = { action: "capture" };
    if (saveToExisting.checked) msg.fileUrl = fileUrlInput.value.trim();
    if (dsMode) msg.useDesignSystem = true;

    chrome.runtime.sendMessage(msg, (response) => {
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
