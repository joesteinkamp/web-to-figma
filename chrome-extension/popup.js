document.addEventListener("DOMContentLoaded", () => {
  const signedOut = document.getElementById("signedOut");
  const signedIn = document.getElementById("signedIn");
  const connectBtn = document.getElementById("connectBtn");
  const captureBtn = document.getElementById("captureBtn");
  const status = document.getElementById("status");
  const logoutLink = document.getElementById("logoutLink");

  function showSignedOut() {
    signedOut.style.display = "block";
    signedIn.style.display = "none";
  }

  function showSignedIn() {
    signedOut.style.display = "none";
    signedIn.style.display = "block";
  }

  // Check auth on open
  chrome.runtime.sendMessage({ action: "checkAuth" }, (resp) => {
    if (resp?.authenticated) {
      showSignedIn();
    } else {
      showSignedOut();
    }
  });

  // Connect triggers OAuth, then immediately captures
  connectBtn.addEventListener("click", () => {
    doCapture();
  });

  captureBtn.addEventListener("click", () => {
    doCapture();
  });

  async function doCapture() {
    status.textContent = "Capturing...";
    status.className = "";
    captureBtn.disabled = true;
    connectBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({ action: "capture" });

      if (response.success) {
        showSignedIn();
        status.textContent = "Sent to Figma!";
        status.className = "success";
      } else {
        showSignedIn();
        status.textContent = response.error;
        status.className = "error";
      }
    } catch (err) {
      status.textContent = err.message;
      status.className = "error";
    } finally {
      captureBtn.disabled = false;
      connectBtn.disabled = false;
    }
  }

  logoutLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ action: "logout" }, () => {
      showSignedOut();
      status.textContent = "";
    });
  });
});
