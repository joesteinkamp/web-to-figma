document.addEventListener("DOMContentLoaded", () => {
  const captureIdInput = document.getElementById("captureId");
  const endpointInput = document.getElementById("endpoint");
  const captureBtn = document.getElementById("captureBtn");
  const status = document.getElementById("status");

  // Restore saved endpoint
  chrome.storage.local.get(["endpoint"], (data) => {
    if (data.endpoint) {
      endpointInput.value = data.endpoint;
    }
  });

  captureBtn.addEventListener("click", async () => {
    const captureId = captureIdInput.value.trim();
    const endpoint = endpointInput.value.trim();

    if (!captureId || !endpoint) {
      status.textContent = "Both fields are required.";
      status.className = "error";
      return;
    }

    // Save endpoint for reuse
    chrome.storage.local.set({ endpoint });

    status.textContent = "Capturing...";
    status.className = "";
    captureBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        action: "capture",
        captureId,
        endpoint,
      });

      if (response.success) {
        status.textContent = "Capture sent successfully!";
        status.className = "success";
      } else {
        status.textContent = `Error: ${response.error}`;
        status.className = "error";
      }
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      status.className = "error";
    } finally {
      captureBtn.disabled = false;
    }
  });
});
