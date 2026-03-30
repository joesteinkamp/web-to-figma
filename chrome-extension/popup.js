document.addEventListener("DOMContentLoaded", () => {
  const captureBtn = document.getElementById("captureBtn");
  const status = document.getElementById("status");
  const authStatus = document.getElementById("authStatus");
  const logoutLink = document.getElementById("logoutLink");

  // Check auth on open
  chrome.runtime.sendMessage({ action: "checkAuth" }, (resp) => {
    if (resp?.authenticated) {
      authStatus.textContent = "Connected to Figma";
      authStatus.className = "auth-status connected";
    } else {
      authStatus.textContent = "Will sign in on first capture";
      authStatus.className = "auth-status";
    }
  });

  captureBtn.addEventListener("click", async () => {
    status.textContent = "Capturing...";
    status.className = "";
    captureBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({ action: "capture" });

      if (response.success) {
        status.textContent = "Sent to Figma!";
        status.className = "success";
        // Update auth status
        authStatus.textContent = "Connected to Figma";
        authStatus.className = "auth-status connected";
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

  logoutLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ action: "logout" }, () => {
      authStatus.textContent = "Signed out";
      authStatus.className = "auth-status";
      status.textContent = "";
    });
  });
});
